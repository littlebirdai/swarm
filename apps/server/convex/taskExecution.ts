import { v } from "convex/values";
import { mutation, type MutationCtx } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { assigneeScopeOf, resolveAssigneeStr } from "./lib/taskAssignees";
import {
  releaseTaskWithClaim,
  renewTaskHeartbeat,
} from "./lib/taskClaimHeartbeat";
import {
  requireAccessibleTaskByToken,
  requireClaimedTaskMutation,
} from "./lib/taskClaimLifecycle";
import { claimRefArgs } from "./lib/taskClaims";
import { insertTaskComment } from "./lib/taskComments";
import { byUser, recordTaskChange } from "./lib/taskHistory";
import { announceAssignment } from "./lib/taskNotifications";
import { releaseBoundSessions } from "./lib/taskOwner";
import { assertValidTaskStatus } from "./lib/taskStatuses";
import { recalcPlanProgress } from "./lib/taskSubtasks";
import { moveTaskStatus } from "./lib/taskTransitions";
import { patchTask } from "./lib/taskWrite";

export const incrementRetryCount = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    ...claimRefArgs,
  },
  handler: async (ctx, args) => {
    const { auth, task, now } = await requireClaimedTaskMutation(ctx, args);
    const newRetryCount = ((task as any).retry_count || 0) + 1;
    const maxRetries = (task as any).max_retries ?? 3;

    const updates: any = {
      retry_count: newRetryCount,
      last_attempted_at: now,
      updated_at: now,
    };

    if (newRetryCount >= maxRetries) {
      updates.execution_status = "blocked";

      const user = await ctx.db.get(auth.userId);
      await insertTaskComment(ctx, task._id, {
        author: user?.name || "system",
        text: `Retry count (${newRetryCount}) exceeded max retries (${maxRetries}). Task automatically blocked.`,
        comment_type: "blocker",
      });
    }

    await ctx.db.patch(task._id, updates);

    return { retry_count: newRetryCount, blocked: newRetryCount >= maxRetries };
  },
});

export const updateExecutionStatus = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    execution_status: v.union(
      v.literal("done"),
      v.literal("done_with_concerns"),
      v.literal("blocked"),
      v.literal("needs_context"),
    ),
    execution_comment: v.optional(v.string()),
    ...claimRefArgs,
  },
  handler: async (ctx, args) => {
    const { auth, task, now } = await requireClaimedTaskMutation(ctx, args);
    await ctx.db.patch(task._id, {
      execution_status: args.execution_status,
      updated_at: now,
    });

    if (args.execution_comment) {
      const user = await ctx.db.get(auth.userId);
      await insertTaskComment(ctx, task._id, {
        author: user?.name || "unknown",
        text: args.execution_comment,
        comment_type: "progress",
      });
    }

    await recordTaskChange(
      ctx,
      task._id,
      byUser(auth.userId),
      [["execution_status", task.execution_status, args.execution_status]],
      now,
    );

    return { success: true };
  },
});

export const batchUpdateStatus = mutation({
  args: {
    api_token: v.string(),
    short_ids: v.array(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    assertValidTaskStatus(args.status);

    const now = Date.now();
    const results: { short_id: string; success: boolean }[] = [];

    for (const short_id of args.short_ids) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .first();
      if (!task || task.user_id !== auth.userId) {
        results.push({ short_id, success: false });
        continue;
      }

      await moveTaskStatus(ctx, task, args.status as any, {
        actorUserId: auth.userId,
        actorType: "user",
        now,
      });

      results.push({ short_id, success: true });
    }

    return { results, updated: results.filter((r) => r.success).length };
  },
});

/** Enough for any board selection; past it the roster and history reads of
 *  one call would run into the transaction's document limit. */
const MAX_BATCH_ASSIGN = 200;

export const batchAssign = mutation({
  args: {
    api_token: v.string(),
    short_ids: v.array(v.string()),
    assignee: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    if (args.short_ids.length > MAX_BATCH_ASSIGN) {
      throw new Error(
        `Assign at most ${MAX_BATCH_ASSIGN} tasks in one call (${args.short_ids.length} given). Split the batch.`,
      );
    }
    const now = Date.now();
    const results: { short_id: string; success: boolean }[] = [];

    // The handle resolves once per boundary, not once per task: resolving
    // reads the roster, and the whole batch usually sits in one workspace.
    const resolvedIn = new Map<string, Promise<string>>();
    const resolveFor = async (task: any): Promise<string> => {
      const boundary = await assigneeScopeOf(ctx, task);
      const key = `${boundary.team_id ?? ""}|${boundary.scope_user_id ?? ""}|${boundary.routed_team_id ?? ""}`;
      let pending = resolvedIn.get(key);
      if (!pending) {
        pending = resolveAssigneeStr(
          ctx,
          args.assignee,
          auth.userId,
          boundary,
        ).then((r) => r || args.assignee);
        resolvedIn.set(key, pending);
      }
      return pending;
    };

    for (const short_id of args.short_ids) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .first();
      if (!task || task.user_id !== auth.userId) {
        results.push({ short_id, success: false });
        continue;
      }
      const resolvedAssignee = await resolveFor(task);

      await recordTaskChange(
        ctx,
        task._id,
        byUser(auth.userId),
        [["assignee", task.assignee, resolvedAssignee]],
        now,
      );

      await patchTask(ctx, task, {
        assignee: resolvedAssignee,
        updated_at: now,
      });

      if (resolvedAssignee !== task.assignee) {
        await announceAssignment(ctx, {
          task,
          assignee: resolvedAssignee,
          actorUserId: auth.userId,
          via: "human",
        });
      }

      results.push({ short_id, success: true });
    }

    return { results, updated: results.filter((r) => r.success).length };
  },
});

export const scheduleRetry = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    ...claimRefArgs,
  },
  handler: async (ctx, args) => {
    const { auth, task, now } = await requireClaimedTaskMutation(
      ctx,
      args,
      (t, claimConvId) => releaseBoundSessions(ctx, t, claimConvId),
    );
    const newAttemptCount = (task.attempt_count || 0) + 1;

    await patchTask(ctx, task, {
      status: "open" as any,
      execution_status: undefined,
      attempt_count: newAttemptCount,
      updated_at: now,
    });

    const user = await ctx.db.get(auth.userId);
    await insertTaskComment(ctx, task._id, {
      author: user?.name || "system",
      text: `Scheduled for retry (attempt ${newAttemptCount})`,
      comment_type: "progress",
    });

    if (task.plan_id && task.status !== "open") {
      await recalcPlanProgress(ctx, task.plan_id, task._id, "open");
    }

    return { success: true, attempt_count: newAttemptCount };
  },
});

async function runHeartbeat(
  ctx: MutationCtx,
  { auth, task }: Awaited<ReturnType<typeof requireAccessibleTaskByToken>>,
  args: {
    progress_pct?: number;
    claim_token?: number;
    conversation_id?: string;
  },
) {
  return await renewTaskHeartbeat(ctx, {
    task,
    holder: auth.userId,
    claimToken: args.claim_token,
    conversationRef: args.conversation_id,
    writeHeartbeat: async () => {
      const updates: any = { last_heartbeat: Date.now() };
      if (args.progress_pct !== undefined)
        updates.progress_pct = args.progress_pct;
      await patchTask(ctx, task, updates);
    },
  });
}

export const heartbeat = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    progress_pct: v.optional(v.number()),
    ...claimRefArgs,
  },
  handler: async (ctx, args) =>
    runHeartbeat(
      ctx,
      await requireAccessibleTaskByToken(ctx, args.api_token, args.short_id),
      args,
    ),
});

export const renew = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    claim_token: v.number(),
    conversation_id: v.optional(v.string()),
    progress_pct: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    await runHeartbeat(
      ctx,
      await requireAccessibleTaskByToken(ctx, args.api_token, args.short_id),
      args,
    ),
});

export const release = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    claim_token: v.number(),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { auth, task } = await requireAccessibleTaskByToken(
      ctx,
      args.api_token,
      args.short_id,
    );
    return await releaseTaskWithClaim(ctx, {
      task,
      holder: auth.userId,
      claimToken: args.claim_token,
      conversationRef: args.conversation_id,
      releaseBound: (c) => releaseBoundSessions(ctx, task, c),
      reopen: (c) =>
        moveTaskStatus(ctx, task, "open", {
          actorUserId: auth.userId,
          actorType: c ? "agent" : "user",
          conversationId: c,
        }),
    });
  },
});
