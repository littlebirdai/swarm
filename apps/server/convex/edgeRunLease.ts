import { internal } from "./_generated/api";
import { v } from "convex/values";
import { internalMutation } from "./functions";
import {
  expireMoveSettlement,
  recordDeviceMove,
} from "./lib/edge/device-move.state";
import {
  appendClaimedEvents,
  claimRunLease,
  releaseRunLease,
  renewRunLease,
} from "./lib/edge/runLease";

const address = { bearer: v.string(), conversation_id: v.string() };
const fence = { ...address, run: v.number(), fencing_token: v.string() };

export const claim = internalMutation({
  args: {
    ...address,
    machine: v.string(),
    boot: v.string(),
    claim_id: v.string(),
  },
  handler: claimRunLease,
});

export const renew = internalMutation({ args: fence, handler: renewRunLease });
export const release = internalMutation({
  args: fence,
  handler: releaseRunLease,
});

export const append = internalMutation({
  args: { ...fence, events_json: v.string() },
  handler: appendClaimedEvents,
});

export const recordMove = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    expected_source_epoch: v.number(),
    destination_device_id: v.string(),
    destination_runner_id: v.id("users"),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const recorded = await recordDeviceMove(ctx, args, now);
    if (!recorded || recorded.expiresAt === null) return;
    const { headId, sourceEpoch, expiresAt } = recorded;
    if (expiresAt <= now) {
      await expireMoveSettlement(ctx, headId, sourceEpoch, now);
    } else {
      await ctx.scheduler.runAt(expiresAt, internal.edgeRunLease.expireMove, {
        head_id: headId,
        source_epoch: sourceEpoch,
      });
    }
  },
});

export const expireMove = internalMutation({
  args: {
    head_id: v.id("conversation_execution_heads"),
    source_epoch: v.number(),
  },
  handler: (ctx, args) =>
    expireMoveSettlement(ctx, args.head_id, args.source_epoch, Date.now()),
});

export const prune = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const limit = 500;
    const rows = await ctx.db
      .query("run_leases")
      .withIndex("by_retention", (q) => q.lte("retain_until", Date.now()))
      .take(limit);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === limit)
      await ctx.scheduler.runAfter(0, internal.edgeRunLease.prune, {});
    return rows.length;
  },
});
