import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation } from "./functions";
import {
  canAccessTask,
  resolveSessionConversation,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./lib/access";
import { resolveActor } from "./lib/actor";
import { requireAccessibleTaskByToken } from "./lib/taskClaimLifecycle";
import { insertTaskComment } from "./lib/taskComments";
import {
  cliVia,
  schedulePushComment,
  subscribeUser,
} from "./lib/taskNotifications";

export const addComment = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    text: v.string(),
    author: v.optional(v.string()),
    comment_type: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    // From a run's own session: the comment is for the run's owner alone (a stop the machine caused), not the task's followers.
    to_owner: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { auth, task } = await requireAccessibleTaskByToken(
      ctx,
      args.api_token,
      args.short_id,
    );

    const conv = args.conversation_id
      ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id)
      : null;
    const conversation_id = conv?._id;

    // A post from inside a session is an agent's: no actor, so the owner's
    // thread lights up. A person running the CLI by hand is the actor. The
    // name is the server resolved identity (lib/actor): a role's standing
    // session signs as the role, a run's own session as the run, everyone
    // else as the token's owner. The author argument is accepted for older
    // CLIs and never read.
    const actor = await resolveActor(ctx, auth.userId, conv);
    if (args.to_owner && actor.kind !== "run")
      throw new Error("to_owner is for a run's own comments");
    // A run is nobody's session to open: its notification names the run and leads to the task.
    const notificationConversationId =
      actor.kind !== "run" &&
      conv &&
      workspacesMatch(
        workspaceForConversation(conv),
        workspaceForResource(task),
      )
        ? conv._id
        : undefined;
    const id = await insertTaskComment(
      ctx,
      task._id,
      {
        author: actor.name || "unknown",
        text: args.text,
        conversation_id,
        comment_type: args.comment_type || "note",
      },
      args.conversation_id ? undefined : auth.userId,
      {
        tokenOwner: auth.userId,
        conversationId: notificationConversationId,
        ...(actor.kind === "run"
          ? {
              run: {
                name: actor.name ?? "A run",
                owner: actor.run!.user_id,
                ownerOnly: !!args.to_owner,
              },
            }
          : {}),
      },
    );

    await subscribeUser(ctx, auth.userId, task._id, "commenter", cliVia(args));
    await schedulePushComment(ctx, task, id);

    return { id };
  },
});

export const webAddComment = mutation({
  args: {
    short_id: v.string(),
    text: v.string(),
    comment_type: v.optional(v.string()),
    image_storage_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, userId, task)))
      throw new Error("Task not found");

    const user = await ctx.db.get(userId);

    const commentId = await insertTaskComment(
      ctx,
      task._id,
      {
        author: user?.name || "unknown",
        text: args.text,
        comment_type: args.comment_type || "note",
        image_storage_ids: args.image_storage_ids,
      },
      userId,
      { tokenOwner: userId },
    );

    await subscribeUser(ctx, userId, task._id, "commenter", "human");
    await schedulePushComment(ctx, task, commentId);

    return { success: true };
  },
});
