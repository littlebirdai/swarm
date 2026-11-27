import type { Doc } from "./_generated/dataModel";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { listTeamMachines } from "./sessionLaunch";
import { isConversationSafetyBlocked } from "./conversationSafety";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import {
  expireMoveSettlement,
  findForceFencedDeviceBinding,
  forcedDeviceMoveEnabled,
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

export const forcedMoveOptions = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }) => {
    if (!forcedDeviceMoveEnabled()) return [];
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const conversation = await ctx.db.get(conversation_id);
    if (
      conversation?.user_id !== userId ||
      conversation.execution_protocol_state !== "fenced" ||
      !conversation.owner_device_id ||
      isConversationSafetyBlocked(conversation)
    )
      return [];
    const sourceId = conversation.owner_device_id;
    const [head, own] = await Promise.all([
      ctx.db
        .query("conversation_execution_heads")
        .withIndex("by_conversation", (q) =>
          q.eq("conversation_id", conversation_id),
        )
        .unique(),
      ctx.db
        .query("devices")
        .withIndex("by_user_device", (q) => q.eq("user_id", userId))
        .collect(),
    ]);
    if (
      head?.owner_user_id !== userId ||
      head.protocol_state !== "fenced" ||
      head.current_epoch === undefined ||
      head.device_move?.phase === "aborting"
    )
      return [];
    const move = head.device_move;
    if (
      !move &&
      (head.pending_epoch !== undefined ||
        head.successor_intent?.status === "pending")
    )
      return [];
    const shared = await listTeamMachines(ctx, userId);
    const ownIds = new Set(own.map(({ device_id }) => device_id));
    const sharedCounts = new Map<string, number>();
    for (const { device } of shared)
      sharedCounts.set(
        device.device_id,
        (sharedCounts.get(device.device_id) ?? 0) + 1,
      );
    const eligible: Doc<"devices">[] = [
      ...own,
      ...shared
        .filter(
          ({ device }) =>
            !ownIds.has(device.device_id) &&
            sharedCounts.get(device.device_id) === 1,
        )
        .map(({ device }) => device),
    ];
    const candidates = move?.forced
      ? []
      : eligible.filter(
          (device) =>
            device.device_id !== sourceId &&
            device.device_id.length > 0 &&
            device.device_id.trim() === device.device_id &&
            (!move ||
              (device.device_id === move.destination_device_id &&
                device.user_id === move.destination_runner_id)),
        );
    const destinations = (
      await Promise.all(
        candidates.map(async (device) => {
          if (
            await findForceFencedDeviceBinding(
              ctx,
              conversation_id,
              device.device_id,
            )
          )
            return null;
          return {
            id: device.device_id,
            label: device.display_name || device.label,
          };
        }),
      )
    ).filter((device) => device !== null);
    const requested = move?.forced
      ? eligible.find(
          (device) =>
            device.device_id === move.destination_device_id &&
            device.user_id === move.destination_runner_id,
        )
      : undefined;
    const source = own.find(({ device_id }) => device_id === sourceId);
    return [
      {
        _id: conversation_id,
        epoch: head.current_epoch,
        sourceLabel: source?.display_name || source?.label || "Old computer",
        offlineAfter: source ? source.last_seen + DEVICE_ONLINE_MS : 0,
        requestedDestination: move?.forced
          ? requested?.display_name ||
            requested?.label ||
            move.destination_device_id
          : null,
        destinations,
      },
    ];
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
