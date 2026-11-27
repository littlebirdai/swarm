import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./functions";
import {
  expireMoveSettlement,
  recordDeviceMove,
} from "./lib/edge/device-move.state";
import {
  abortDeviceMove,
  activateDeviceMove,
  confirmMoveSourceBoot,
  confirmMoveSourceStopped,
  prepareDeviceMove,
  retargetDeviceMove,
} from "./lib/edge/device-move-transition.state";
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

const moveTarget = {
  conversation_id: v.id("conversations"),
  expected_source_epoch: v.number(),
  destination_device_id: v.string(),
};

export const recordMove = internalMutation({
  args: { ...moveTarget, destination_runner_id: v.id("users") },
  handler: async (ctx, args): Promise<string> => {
    const now = Date.now();
    const recorded = await recordDeviceMove(ctx, args, now);
    const { moveId, headId, sourceEpoch, expiresAt } = recorded;
    if (expiresAt === null) return moveId;
    if (expiresAt <= now) {
      await expireMoveSettlement(ctx, headId, sourceEpoch, now);
    } else {
      await ctx.scheduler.runAt(expiresAt, internal.edgeRunLease.expireMove, {
        head_id: headId,
        source_epoch: sourceEpoch,
      });
    }
    return moveId;
  },
});

export const forceMove = mutation({
  args: { ...moveTarget, acknowledge_source_may_still_run: v.literal(true) },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      throw new ConvexError(
        "Forcing a move requires a signed-in session owner",
      );
    const now = Date.now();
    const { moveId, headId, sourceEpoch } = await recordDeviceMove(
      ctx,
      { ...args, forced_by: userId },
      now,
    );
    await expireMoveSettlement(ctx, headId, sourceEpoch, now);
    return moveId;
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

const moveAddress = {
  conversation_id: v.id("conversations"),
  move_id: v.string(),
  bearer: v.string(),
};

export const prepareMove = internalMutation({
  args: { ...moveAddress, daemon_boot_id: v.string() },
  handler: (ctx, args) => prepareDeviceMove(ctx, args, Date.now()),
});

export const confirmMoveSourceStop = internalMutation({
  args: {
    ...moveAddress,
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    fencing_token: v.string(),
  },
  handler: (ctx, args) => confirmMoveSourceStopped(ctx, args, Date.now()),
});

export const confirmMoveSourceReplacementBoot = internalMutation({
  args: { ...moveAddress, daemon_boot_id: v.string() },
  handler: (ctx, args) => confirmMoveSourceBoot(ctx, args, Date.now()),
});

export const retargetMove = internalMutation({
  args: moveAddress,
  handler: (ctx, args) => retargetDeviceMove(ctx, args, Date.now()),
});

export const abortMove = internalMutation({
  args: moveAddress,
  handler: (ctx, args) => abortDeviceMove(ctx, args, Date.now()),
});

export const activateMove = internalMutation({
  args: {
    ...moveAddress,
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    operation_id: v.string(),
  },
  handler: (ctx, args) => activateDeviceMove(ctx, args, Date.now()),
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
