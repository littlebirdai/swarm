import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  fromConvexAgentType,
  toConvexAgentType,
} from "@codecast/agent-clients/agentClients";
import { buildTaskSpawnPrompt } from "@codecast/tasks/foreignText";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./functions";
import { resolveDefinitionFor } from "./agentDefinitions";
import { verifyApiToken } from "./apiTokens";
import { addConversationToWorkItem } from "./conversationLinks";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage } from "./pendingMessages";
import { resolveTeamForPath } from "./privacy";
import { resolveSpawnDefinition, resolveTaskSpawnDevice } from "./spawn";
import {
  canAccessPlan,
  isSameWorkspace,
  workspaceForResource,
} from "./lib/access";
import {
  enrollLocalCodexLaunch,
  launchPromptId,
} from "./lib/fenced-session-launch.state";
import { insertConversationWithStatus } from "./lib/sessionStatusWriter";
import { webBaseUrl } from "./lib/slackOAuth";
import { insertTaskComment } from "./lib/taskComments";
import {
  resolveTaskGitContext,
  resolveWorkerParentConversation,
  worktreeNameFor,
} from "./lib/taskLaunch";
import { schedulePushComment } from "./lib/taskNotifications";
import { claimTaskOwnership } from "./lib/taskOwner";

/**
 * May this user launch a session for this task? Its creator, or any member of
 * its team — the same rule dispatch.createSession applies. Without the team
 * clause, "start agent run" on a shared team task is silently rejected as
 * Unauthorized.
 */
export async function canLaunchTaskSession(
  ctx: any,
  userId: Id<"users">,
  task: any,
): Promise<boolean> {
  if (task.user_id.toString() === userId.toString()) return true;
  if (!task.team_id) return false;
  return !!(await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) =>
      q.eq("user_id", userId).eq("team_id", task.team_id),
    )
    .first());
}

/**
 * Spawn a session that works one task. THE spawn: the board's assign-to-agent
 * action, the CLI's `cast task start --spawn`, and issue sync's automatic
 * delegation (issue-sync.md S7) all land here, so a task-backed session is
 * built one way no matter who asked for it.
 *
 * Callers own the access check (canLaunchTaskSession); this assumes it passed.
 */
export async function spawnSessionForTask(
  ctx: any,
  userId: Id<"users">,
  task: any,
  opts: {
    agent_type?: string;
    initial_message?: string;
    isolated?: boolean;
    worktree_name?: string;
    target_device_id?: string;
    definition?: string;
    caller_user_id?: Id<"users">;
  } = {},
): Promise<{ conversationId: Id<"conversations">; sessionId: string }> {
  const initial_message = opts.initial_message;
  const prompt = buildTaskSpawnPrompt(task, initial_message);
  const asDef = await resolveSpawnDefinition(ctx, userId, opts.definition, {
    agentType: opts.agent_type,
    model: task.model,
    effort: task.effort,
    prompt,
    isolated: opts.isolated,
  });
  // Round-trip through the client registry so any spelling a caller supplies
  // (a daemon client id, a convex literal, something stale) normalizes to the
  // closed union the conversations row stores. Unknown falls back to claude.
  const daemonAgentType = fromConvexAgentType(
    asDef.agentType ?? opts.agent_type ?? "claude_code",
  );
  const agent_type = toConvexAgentType(daemonAgentType);

  const now = Date.now();
  const sessionId = crypto.randomUUID();

  let workerPlanId: Id<"plans"> | undefined;
  if ((task as any).plan_id) {
    const plan = await ctx.db.get((task as any).plan_id as Id<"plans">);
    if (
      plan &&
      isSameWorkspace(plan, workspaceForResource(task)) &&
      (await canAccessPlan(ctx, userId, plan))
    ) {
      workerPlanId = plan._id;
    }
  }
  const parentConversationId = await resolveWorkerParentConversation(
    ctx,
    userId,
    workerPlanId,
  );

  // Without a project_path the daemon has nowhere to launch the session, so the
  // run silently never starts. Resolve it (and git_root/remote) from the task
  // the same way dispatch.createSession does.
  const mappings = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const { project_path, git_root, git_remote_url } =
    await resolveTaskGitContext(ctx, userId, task, mappings);

  // Team/privacy come from the launcher's directory mappings, exactly like
  // dispatch.createSession (the sibling launch path) — the task's team is
  // only a routing fallback. A literal is_private here once minted
  // "shared with nobody" rows: non-private but teamless, invisible to every
  // teammate because the visibility gates short-circuit on !team_id.
  const { teamId, isPrivate, autoShared } = resolveTeamForPath(
    mappings,
    git_root || project_path,
    task.team_id,
  );

  const conversationId = await insertConversationWithStatus(ctx, {
    user_id: userId,
    agent_type,
    session_id: sessionId,
    project_path,
    git_root,
    ...(git_remote_url ? { git_remote_url } : {}),
    started_at: now,
    updated_at: now,
    message_count: 0,
    status: "active",
    team_id: teamId,
    is_private: isPrivate,
    auto_shared: autoShared || undefined,
    title: task.title.slice(0, 80),
    // Stamp the plan so the inbox can group plan workers even when there's no
    // viable parent session to nest under (the grouping fallback).
    ...(workerPlanId ? { active_plan_id: workerPlanId } : {}),
    ...(parentConversationId
      ? { parent_conversation_id: parentConversationId, is_subagent: true }
      : {}),
  } as any);
  const shortId = conversationId.toString().slice(0, 7);
  await ctx.db.patch(conversationId, { short_id: shortId } as any);

  // Link the new session to the task so it counts as a linked conversation —
  // drives session_count, origin_session, and the "Has session" filter.
  // Mirrors dispatch.createSession, which links the conversation before
  // binding active_task_id. Without this an agent-run task shows a live
  // session pill (from active_task_id) while session_count stays 0, so it
  // wrongly drops out of the "Has session" filter.
  await addConversationToWorkItem(ctx, userId, "task", task, conversationId);
  // The launcher chose this session to do the work: it becomes the task's one
  // owner, and any earlier bound session lets go.
  const claimed = await claimTaskOwnership(
    ctx,
    await ctx.db.get(conversationId),
    task,
    { take: true, now },
  );
  await ctx.scheduler.runAfter(0, internal.sessionOwnership.reconcileHold, {
    conversation_id: conversationId,
  });

  // NB: intentionally do NOT reassign the task to "agent" — the launcher stays
  // the owner. The active run is already conveyed by the task status and the
  // session linked via active_task_id, so clobbering assignee only lost the
  // human owner and dropped the task out of the launcher's "assigned to me" view.

  const content = asDef.prompt ?? prompt;
  const worktreeName =
    opts.worktree_name ||
    (asDef.isolated && task.external?.identifier
      ? worktreeNameFor(task.external.identifier) || undefined
      : undefined);

  const start = {
    conversationId,
    agentType: daemonAgentType,
    projectPath: project_path || git_root,
    gitRoot: git_root,
    createdAt: now,
    // The task's execution hints (task-graph.md TG8), fixed at launch; the
    // daemon drops a model or effort its client does not offer.
    ...(asDef.model ? { model: asDef.model } : {}),
    ...(asDef.effort ? { effort: asDef.effort } : {}),
    isolated: asDef.isolated,
    worktreeName,
    targetDeviceId: opts.target_device_id,
    definition: asDef.definition,
    callerUserId: opts.caller_user_id,
  };

  const enrolled = await enrollLocalCodexLaunch(ctx, userId, start);
  // Single canonical writer: stamps owner_user_id for the daemon's delivery poll and flips
  // has_pending_messages. The task session is the launcher's own, so owner == sender.
  const taskConversation = await ctx.db.get(conversationId);
  await enqueuePendingMessage(ctx, taskConversation, userId, {
    content,
    client_id: launchPromptId(taskConversation, "task"),
  });

  if (!enrolled) await enqueueStartSession(ctx, userId, start);

  // S7: tell the provider issue that a session took it, exactly once per
  // spawn. Written as a normal task comment and pushed outward by the same
  // schedulePushComment every other outbound comment uses, so the link lands
  // in both places and there is no second outbound path to keep true.
  if (task.external) {
    const commentId = await insertTaskComment(ctx, task._id, {
      author: "codecast",
      text: `Codecast session ${shortId} picked this up: ${webBaseUrl()}/conversation/${conversationId}`,
      comment_type: "note",
      conversation_id: conversationId,
    });
    await schedulePushComment(ctx, task, commentId);
  }

  return {
    conversationId,
    sessionId,
    ...(claimed.claimToken !== undefined
      ? { claim_token: claimed.claimToken, lease_until: claimed.leaseUntil }
      : {}),
  };
}

export const assignToAgent = mutation({
  args: {
    short_id: v.string(),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok"),
      v.literal("muse"),
      v.literal("antigravity"),
    ),
    // Optional lead-in the user types before launch (defaults to "lets do this
    // task" in the palette). Prepended to the structured task prompt below.
    initial_message: v.optional(v.string()),
  },
  handler: async (ctx, { short_id, agent_type, initial_message }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
      .first();
    if (!task) throw new Error("Task not found");
    if (!(await canLaunchTaskSession(ctx, userId, task)))
      throw new Error("Unauthorized");

    return await spawnSessionForTask(ctx, userId, task, {
      agent_type,
      initial_message,
    });
  },
});

/** The CLI's `cast task start <id> --spawn` (S7.2). Same access rule, same
 *  spawn; only the credential differs. */
export const spawnForTask = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    agent_type: v.optional(v.string()),
    initial_message: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
    device: v.optional(v.string()),
    definition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) throw new Error("Task not found");
    if (!(await canLaunchTaskSession(ctx, auth.userId, task)))
      throw new Error("Unauthorized");

    return await spawnSessionForTask(ctx, auth.userId, task, {
      agent_type: args.agent_type,
      initial_message: args.initial_message,
      isolated: args.isolated,
      worktree_name: args.worktree_name,
      target_device_id: args.device
        ? await resolveTaskSpawnDevice(ctx, auth.userId, args.device)
        : undefined,
      definition: args.definition,
      caller_user_id: auth.userId,
    });
  },
});

/** Issue sync's automatic delegation (S7.3). Idempotent on purpose: a second
 *  delegating event on the same issue must not stack a second session, so a
 *  task that already has one is left alone. */
export const spawnSessionForTaskInternal = internalMutation({
  args: {
    task_id: v.id("tasks"),
    user_id: v.id("users"),
    agent_type: v.optional(v.string()),
    initial_message: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
    target_device_id: v.optional(v.string()),
    definition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task) return null;
    if ((task.conversation_ids ?? []).length > 0) return null;
    if (
      args.definition &&
      !(await resolveDefinitionFor(ctx, args.user_id, args.definition))
    ) {
      const text = `The automatic session was not started: no agent definition named "${args.definition}" exists. Create it, or change the source's definition with \`cast integrations set\` (--as <name|none>).`;
      const comments = await ctx.db
        .query("task_comments")
        .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
        .collect();
      if (!comments.some((c) => c.text === text)) {
        await insertTaskComment(ctx, task._id, {
          author: "codecast",
          text,
          comment_type: "note",
        });
      }
      return null;
    }
    return await spawnSessionForTask(ctx, args.user_id, task, {
      agent_type: args.agent_type,
      initial_message: args.initial_message,
      isolated: args.isolated,
      worktree_name: args.worktree_name,
      target_device_id: args.target_device_id,
      definition: args.definition,
    });
  },
});
