import {
  beginPendingSweep,
  stuckApplyPage,
} from "./lib/pending-message-liveness.rules";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import {
  cronSweepName,
  cronSweepPage,
  cronSweepRow,
  cronSweepToken,
  isCurrentCronSweep,
} from "./lib/cron-sweep.rules";

export const begin = internalMutation({
  args: { job: cronSweepName },
  handler: (ctx, { job }): Promise<number | null> =>
    cronSweepToken(ctx.db, job),
});

export const continuePage = internalAction({
  args: { page: cronSweepPage, retried: v.optional(v.boolean()) },
  handler: async (ctx, { page, retried }): Promise<void> => {
    try {
      switch (page.job) {
        case "activity":
          await ctx.runAction(internal.activityDays.sweep, {
            days: page.days,
            phase: page.phase,
            tailEnd: page.tailEnd,
            tailPagesRemaining: page.tailPagesRemaining,
            startedAt: page.startedAt,
            cursor: page.cursor,
            token: page.token,
          });
          break;
        case "health":
          await ctx.runMutation(internal.daemonLogs.checkDaemonHealth, {
            now: page.startedAt,
            cursor: page.cursor,
            token: page.token,
          });
          break;
        case "reclaim":
          await ctx.runMutation(internal.agentTasks.reclaimStaleTasks, {
            through: page.startedAt,
            cursor: page.cursor,
            token: page.token,
          });
      }
    } catch (error) {
      await ctx.runMutation(internal.cronSweep.recordFailure, {
        page,
        retried,
        error: String(error).slice(0, 300),
      });
    }
  },
});

export const recordFailure = internalMutation({
  args: {
    page: cronSweepPage,
    retried: v.optional(v.boolean()),
    error: v.string(),
  },
  handler: async (ctx, { page, retried, error }): Promise<void> => {
    if (!(await isCurrentCronSweep(ctx.db, page.job, page.token))) return;
    const key = `cron_sweep_failure:${page.job}`;
    const row = await cronSweepRow(ctx.db, key);
    const fields = {
      value: JSON.stringify({ page, error, retried: !!retried }),
      updated_at: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("system_config", { key, ...fields });
    if (!retried)
      await ctx.scheduler.runAfter(1000, internal.cronSweep.continuePage, {
        page,
        retried: true,
      });
  },
});

export const beginPending = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> =>
    (await beginPendingSweep(ctx.db)).run_token!,
});

export const continuePending = internalAction({
  args: { page: stuckApplyPage },
  handler: async (ctx, { page }): Promise<void> => {
    try {
      await ctx.runMutation(internal.pendingMessages.applyStuckMessages, page);
    } catch (error) {
      console.warn(
        `pending message sweep page failed: ${String(error).slice(0, 300)}`,
      );
      if (!page.conversationId) throw error;
      const conversationId = page.conversationId;
      await ctx.runMutation(
        internal.pendingMessages.checkpointStuckMessagePage,
        {
          now: Date.now(),
          runToken: page.runToken,
          updates: page.ids.map((messageId) => ({
            conversationId,
            messageId,
            reason: "apply_failed" as const,
          })),
        },
      );
    }
  },
});
