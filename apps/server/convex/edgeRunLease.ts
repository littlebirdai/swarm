import type { Doc } from "./_generated/dataModel";
import {
  driveDeviceMove,
  runDeviceMoveStep,
  startDeviceMoveDriver,
} from "./lib/edge/device-move-driver.state";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { listTeamMachines } from "./sessionLaunch";
import { canAccessConversation } from "./lib/access";
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

const DONE_RECEIPT_MS = 30_000;

type ForcedMoveOption = {
  _id: Doc<"conversations">["_id"];
  epoch: number;
  sourceLabel: string;
  offlineAfter: number;
  requestedDestination: string | null;
  progress: "requested" | "preparing" | "moving" | "done" | "failed" | null;
  failure: string | null;
  doneUntil?: number;
  failedMove?: { move_id: string; revision: number };
  destinations: { id: string; label: string }[];
};

export const forcedMoveOptions = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }): Promise<ForcedMoveOption[]> => {
    if (!forcedDeviceMoveEnabled()) return [];
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const conversation = await ctx.db.get(conversation_id);
    if (
      conversation?.execution_protocol_state !== "fenced" ||
      !conversation.owner_device_id ||
      isConversationSafetyBlocked(conversation)
    )
      return [];
    const sourceId = conversation.owner_device_id;
    const head = await ctx.db
      .query("conversation_execution_heads")
      .withIndex("by_conversation", (q) =>
        q.eq("conversation_id", conversation_id),
      )
      .unique();
    if (head?.protocol_state !== "fenced" || head.current_epoch === undefined)
      return [];
    const move = head.device_move;
    const isOwner =
      conversation.user_id === userId && head.owner_user_id === userId;
    const receipt = head.last_device_move;
    let done:
      | Pick<
          ForcedMoveOption,
          "progress" | "requestedDestination" | "doneUntil"
        >
      | undefined;
    if (
      !move &&
      receipt?.forced &&
      receipt.epoch === head.current_epoch &&
      Date.now() < receipt.activated_at + DONE_RECEIPT_MS &&
      (isOwner ||
        (receipt.source_runner_id === userId &&
          (await canAccessConversation(ctx, userId, conversation))))
    ) {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q) =>
          q
            .eq("user_id", receipt.destination_runner_id)
            .eq("device_id", receipt.destination_device_id),
        )
        .first();
      done = {
        requestedDestination:
          device?.display_name ||
          device?.label ||
          receipt.destination_device_id,
        progress: "done",
        doneUntil: receipt.activated_at + DONE_RECEIPT_MS,
      };
    }
    if (!isOwner)
      return done
        ? [
            {
              _id: conversation_id,
              epoch: head.current_epoch,
              sourceLabel: "",
              offlineAfter: 0,
              failure: null,
              destinations: [],
              ...done,
            },
          ]
        : [];
    if (move?.phase === "aborting" && !move.replacement) return [];
    if (
      !move &&
      (head.pending_epoch !== undefined ||
        head.successor_intent?.status === "pending")
    )
      return [];
    const own = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId))
      .collect();
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
    const failed = move?.forced && move.driver?.step === "failed";
    const candidates =
      move?.forced && !failed
        ? []
        : eligible.filter(
            (device) =>
              device.device_id !== sourceId &&
              device.device_id.length > 0 &&
              device.device_id.trim() === device.device_id &&
              (!move ||
                failed ||
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
    const target = move?.replacement ?? move;
    const requested =
      target &&
      eligible.find(
        (device) =>
          device.device_id === target.destination_device_id &&
          device.user_id === target.destination_runner_id,
      );
    const source = own.find(({ device_id }) => device_id === sourceId);
    return [
      {
        _id: conversation_id,
        epoch: head.current_epoch,
        sourceLabel: source?.display_name || source?.label || "Old computer",
        offlineAfter: source ? source.last_seen + DEVICE_ONLINE_MS : 0,
        requestedDestination:
          move?.forced && target
            ? requested?.display_name ||
              requested?.label ||
              target.destination_device_id
            : null,
        progress: !move?.forced
          ? null
          : move.driver?.step === "failed"
            ? ("failed" as const)
            : move.driver?.step === "restore" ||
                move.driver?.step === "activate" ||
                (move.driver?.moved ?? 0) > 0
              ? ("moving" as const)
              : move.driver?.prepared_at !== undefined ||
                  (move.driver?.retries ?? 0) > 0
                ? ("preparing" as const)
                : ("requested" as const),
        failure:
          move?.driver?.step === "failed"
            ? (move.driver.last_error ?? "The device move could not finish")
            : null,
        ...(move?.forced &&
          move.move_id &&
          move.driver?.step === "failed" && {
            failedMove: {
              move_id: move.move_id,
              revision: move.driver.revision,
            },
          }),
        destinations,
        ...done,
      },
    ];
  },
});

export const forceMove = mutation({
  args: {
    ...moveTarget,
    acknowledge_source_may_still_run: v.literal(true),
    retry_failed_move: v.optional(
      v.object({ move_id: v.string(), revision: v.number() }),
    ),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      throw new ConvexError(
        "Forcing a move requires a signed-in session owner",
      );
    const now = Date.now();
    const { moveId, headId, sourceEpoch, resumeDriver } =
      await recordDeviceMove(ctx, { ...args, forced_by: userId }, now);
    await expireMoveSettlement(ctx, headId, sourceEpoch, now);
    await startDeviceMoveDriver(
      ctx,
      {
        conversation_id: args.conversation_id,
        move_id: moveId,
      },
      resumeDriver,
    );
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

const recordedMoveAddress = {
  conversation_id: v.id("conversations"),
  move_id: v.string(),
};
const moveAddress = { ...recordedMoveAddress, bearer: v.string() };
const moveTicket = { ...recordedMoveAddress, revision: v.number() };

export const driveMove = internalMutation({
  args: moveTicket,
  handler: driveDeviceMove,
});
export const runMoveStep = internalMutation({
  args: moveTicket,
  handler: runDeviceMoveStep,
});

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
  handler: async (ctx, args): Promise<void> => {
    await confirmMoveSourceStopped(ctx, args, Date.now());
    await startDeviceMoveDriver(ctx, args);
  },
});

export const confirmMoveSourceReplacementBoot = internalMutation({
  args: { ...moveAddress, daemon_boot_id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await confirmMoveSourceBoot(ctx, args, Date.now());
    await startDeviceMoveDriver(ctx, args);
  },
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
