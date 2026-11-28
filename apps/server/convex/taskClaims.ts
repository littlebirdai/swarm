import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./functions";
import { clearClaim, findClaim } from "./lib/claims";
import { releaseBoundSessions } from "./lib/taskOwner";
import { moveTaskStatus } from "./tasks";

export const expire = internalMutation({
  args: {
    task_id: v.id("tasks"),
    token: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await findClaim(ctx.db, { kind: "task", id: args.task_id });
    if (!row || row.holder === undefined || row.token !== args.token) return;
    const now = Date.now();
    const remaining = row.lease_until - now;
    if (remaining > 0) {
      await ctx.scheduler.runAfter(remaining, internal.taskClaims.expire, args);
      return;
    }
    const boundConvId = row.task?.conversation_id;
    await clearClaim(ctx, row);
    const task = await ctx.db.get(args.task_id);
    if (!task) return;
    await releaseBoundSessions(ctx, task, boundConvId);
    if (task.status === "in_progress") {
      await moveTaskStatus(ctx, task, "open", {
        actorUserId: task.user_id,
        actorType: "system",
        now,
        conversationId: boundConvId,
      });
    }
  },
});
