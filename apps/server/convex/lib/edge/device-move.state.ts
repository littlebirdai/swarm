import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  blockDeliveryAsAmbiguous,
  requeueDeliveryBeforeEffect,
  type PermitFence,
} from "../delivery-slot.state";
import { resolveSessionLaunchDevice } from "../../sessionLaunch";
import { loadRunLeaseClaim } from "./runLease";

const SETTLEMENT_WINDOW_MS = 10_000;
export const DEVICE_MOVE_FENCE = "EXECUTION_DEVICE_MOVE_IN_PROGRESS";
const FORCED_MOVE_FLAG = "CODECAST_FORCED_DEVICE_MOVE_V1";
type Head = Doc<"conversation_execution_heads">;
type Move = NonNullable<Head["device_move"]>;
type Destination = Pick<
  Move,
  "destination_device_id" | "destination_runner_id"
>;

export function forcedDeviceMoveEnabled() {
  return process.env[FORCED_MOVE_FLAG] === "1";
}

export function requireForcedDeviceMoveEnabled() {
  if (!forcedDeviceMoveEnabled())
    throw new ConvexError("Forced device moves are disabled");
}

export function findForceFencedDeviceBinding(
  ctx: Pick<QueryCtx, "db">,
  conversationId: Id<"conversations">,
  deviceId: string,
) {
  return ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_device_forced_at", (q) =>
      q
        .eq("conversation_id", conversationId)
        .eq("owner_device_id", deviceId)
        .gt("forced_device_move.at", undefined),
    )
    .first();
}

export async function requireDeviceNotForceFenced(
  ctx: Pick<QueryCtx, "db">,
  conversationId: Id<"conversations">,
  deviceId: string,
  callerId?: Id<"users">,
) {
  const retired = await findForceFencedDeviceBinding(
    ctx,
    conversationId,
    deviceId,
  );
  if (retired && callerId && callerId !== retired.owner_user_id) {
    const conversation = await ctx.db.get(conversationId);
    if (conversation?.user_id !== callerId) return;
  }
  if (retired)
    throw new ConvexError({
      code: "EXECUTION_DEVICE_FORCE_FENCED",
      message: "This device was fenced by a forced move for this conversation",
    });
}

export function requireNoDeviceMove(head: Pick<Head, "device_move"> | null) {
  if (head?.device_move)
    throw new ConvexError({
      code: DEVICE_MOVE_FENCE,
      message: "Execution is fenced by a device move",
    });
}

export async function assertMoveSettlementWindow(
  ctx: Pick<QueryCtx, "db">,
  head: Head,
  attemptId: Id<"delivery_attempts">,
  fence: PermitFence & { now: number },
) {
  const move = head.device_move;
  if (!move) return;
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (
    move.forced !== undefined ||
    attemptId !== move.attempt_id ||
    fence.executionEpoch !== move.source_epoch ||
    fence.now >= move.settlement_deadline ||
    !lease ||
    lease.released_at !== undefined ||
    fence.now >= lease.expires_at ||
    lease.fencing_token !== fence.fencingToken
  )
    requireNoDeviceMove(head);
}

export function assertMoveSettlementStarted(
  head: Head,
  attempt: Doc<"delivery_attempts">,
) {
  if (
    attempt.state !== "delivery-started" ||
    head.active_delivery_state !== "delivery-started"
  )
    requireNoDeviceMove(head);
}

export async function assertMoveSettlement(
  ctx: Pick<QueryCtx, "db">,
  head: Head,
  attempt: Doc<"delivery_attempts">,
  fence: PermitFence & { now: number },
) {
  await assertMoveSettlementWindow(ctx, head, attempt._id, fence);
  assertMoveSettlementStarted(head, attempt);
}

export async function registeredBoot(
  ctx: Pick<QueryCtx, "db">,
  runner: Id<"users">,
  device: string,
) {
  return await ctx.db
    .query("execution_daemon_boots")
    .withIndex("by_user_device", (q) =>
      q.eq("user_id", runner).eq("owner_device_id", device),
    )
    .unique();
}

export async function recordDeviceMove(
  ctx: Pick<MutationCtx, "db">,
  args: (
    | Destination
    | {
        destination_device_id: string;
        forced_by: Id<"users">;
        retry_failed_move?: { move_id: string; revision: number };
      }
  ) & {
    conversation_id: Id<"conversations">;
    expected_source_epoch: number;
  },
  now: number,
) {
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", args.conversation_id),
    )
    .unique();
  const forcedBy = "forced_by" in args ? args.forced_by : undefined;
  let destinationRunnerId: Id<"users">;
  if ("forced_by" in args) {
    requireForcedDeviceMoveEnabled();
    const conversation = await ctx.db.get(args.conversation_id);
    if (
      conversation?.user_id !== args.forced_by ||
      head?.owner_user_id !== args.forced_by
    )
      throw new ConvexError("Only the current session owner can force a move");
    if (head.current_epoch !== args.expected_source_epoch)
      throw new ConvexError("The source epoch changed before the forced move");
    if (
      !args.destination_device_id ||
      args.destination_device_id !== args.destination_device_id.trim()
    )
      throw new ConvexError("The destination device ID must be canonical");
    if (conversation.owner_device_id === args.destination_device_id)
      throw new ConvexError("A forced move requires a different device");
    const device = await resolveSessionLaunchDevice(
      ctx,
      args.forced_by,
      args.destination_device_id,
    );
    if (!device)
      throw new ConvexError(
        "Choose one of your devices or a device shared with your team",
      );
    destinationRunnerId = device.user_id as Id<"users">;
  } else {
    destinationRunnerId = args.destination_runner_id;
  }
  await requireDeviceNotForceFenced(
    ctx,
    args.conversation_id,
    args.destination_device_id,
  );
  const existing = head?.device_move;
  const retry = "forced_by" in args ? args.retry_failed_move : undefined;
  const resumeDriver =
    retry !== undefined &&
    existing?.move_id === retry.move_id &&
    existing.driver?.step === "failed" &&
    existing.driver.revision === retry.revision;
  if (head && existing) {
    const target = existing.replacement ?? existing;
    const sameTarget =
      existing.source_epoch === args.expected_source_epoch &&
      target.destination_device_id === args.destination_device_id &&
      target.destination_runner_id === destinationRunnerId;
    const replacementDriver =
      forcedBy !== undefined &&
      existing.forced &&
      existing.source_epoch === args.expected_source_epoch &&
      existing.driver?.step === "failed" &&
      resumeDriver &&
      (existing.phase !== "aborting" || existing.replacement)
        ? existing.driver
        : undefined;
    const abandonedMoveId =
      replacementDriver && existing.phase
        ? (existing.replacement?.abandoned_move_id ?? existing.move_id)
        : undefined;
    const prepared =
      replacementDriver && existing.phase
        ? await ctx.db
            .query("execution_bindings")
            .withIndex("by_conversation_epoch", (q) =>
              q
                .eq("conversation_id", args.conversation_id)
                .eq("epoch", existing.next_epoch),
            )
            .unique()
        : undefined;
    if (
      prepared !== undefined &&
      (head.pending_epoch !== existing.next_epoch ||
        !prepared ||
        !abandonedMoveId ||
        prepared.move_id !== abandonedMoveId ||
        prepared.owner_device_id !== existing.destination_device_id ||
        prepared.owner_user_id !== existing.destination_runner_id)
    )
      throw new ConvexError("The destination binding does not match the move");
    const refreshPreparedBinding =
      sameTarget &&
      replacementDriver &&
      existing.phase === "preparing" &&
      prepared &&
      ((prepared.state !== "requested" &&
        prepared.state !== "starting" &&
        prepared.state !== "ready" &&
        (prepared.state !== "start-failed-before-effect" ||
          prepared.failure_retryable !== true)) ||
        (
          await registeredBoot(
            ctx,
            prepared.owner_user_id,
            prepared.owner_device_id,
          )
        )?.daemon_boot_id !== prepared.daemon_boot_id);
    if (sameTarget && !refreshPreparedBinding) {
      const moveId = existing.move_id ?? crypto.randomUUID();
      if (
        forcedBy !== undefined &&
        existing.phase === "aborting" &&
        !existing.replacement
      )
        throw new ConvexError("An aborting move cannot be forced");
      const force = forcedBy !== undefined && existing.forced === undefined;
      if (!existing.move_id || existing.recorded_at === undefined || force)
        await ctx.db.patch(head._id, {
          device_move: {
            ...existing,
            move_id: moveId,
            recorded_at: existing.recorded_at ?? now,
            ...(force && {
              forced: { by_user_id: forcedBy, at: now },
              settlement_deadline: now,
            }),
          },
        });
      return {
        moveId,
        headId: head._id,
        sourceEpoch: existing.source_epoch,
        expiresAt: force ? now : null,
        resumeDriver: force || resumeDriver,
      };
    }
    if (replacementDriver) {
      const moveId = crypto.randomUUID();
      const destination = {
        destination_device_id: args.destination_device_id,
        destination_runner_id: destinationRunnerId,
      };
      if (prepared) {
        if (!Number.isSafeInteger(existing.next_epoch + 1))
          throw new ConvexError("The next destination epoch is out of range");
        await ctx.db.patch(prepared._id, {
          state:
            prepared.state === "requested" ||
            prepared.state === "start-failed-before-effect" ||
            prepared.state === "stopped"
              ? "stopped"
              : "quarantined",
          abandoned_move: true,
          stopped_reason: "session owner replaced the failed destination",
          updated_at: now,
        });
      }
      await ctx.db.patch(head._id, {
        device_move: {
          ...existing,
          move_id: moveId,
          ...(abandonedMoveId
            ? {
                phase: "aborting",
                replacement: {
                  ...destination,
                  abandoned_move_id: abandonedMoveId,
                },
              }
            : destination),
          driver: {
            revision: replacementDriver.revision,
            step: "failed",
            retries: 0,
            moved: 0,
          },
        },
        updated_at: now,
      });
      return {
        moveId,
        headId: head._id,
        sourceEpoch: existing.source_epoch,
        expiresAt: null,
        resumeDriver,
      };
    }
    requireNoDeviceMove(head);
  }
  if (retry) throw new ConvexError("The failed move changed before the retry");
  if (
    !head ||
    head.protocol_state !== "fenced" ||
    head.current_epoch !== args.expected_source_epoch ||
    !Number.isSafeInteger(args.expected_source_epoch + 1) ||
    head.pending_epoch !== undefined ||
    head.successor_intent?.status === "pending" ||
    !args.destination_device_id.trim()
  )
    throw new ConvexError("Cannot record a move for this execution head");
  const [conversation, binding] = await Promise.all([
    ctx.db.get(args.conversation_id),
    ctx.db
      .query("execution_bindings")
      .withIndex("by_conversation_epoch", (q) =>
        q
          .eq("conversation_id", args.conversation_id)
          .eq("epoch", args.expected_source_epoch),
      )
      .unique(),
  ]);
  if (
    conversation?.execution_protocol_state !== "fenced" ||
    conversation.user_id !== head.owner_user_id ||
    binding?.owner_user_id !== head.owner_user_id ||
    binding.owner_device_id !== conversation.owner_device_id
  )
    throw new ConvexError("The source binding does not own this conversation");
  const lease =
    binding.claim_id === undefined
      ? null
      : await loadRunLeaseClaim(ctx, args.conversation_id, binding.claim_id);
  const sourceLease =
    lease?.binding_id === binding._id && lease.boot === binding.daemon_boot_id
      ? lease
      : null;
  const started = head.active_delivery_state === "delivery-started";
  const moveId = crypto.randomUUID();
  const move: Move = {
    move_id: moveId,
    recorded_at: now,
    source_epoch: binding.epoch,
    source_lease_id: sourceLease?._id,
    attempt_id: head.active_delivery_attempt_id,
    destination_device_id: args.destination_device_id,
    destination_runner_id: destinationRunnerId,
    next_epoch: binding.epoch + 1,
    ...(forcedBy !== undefined && {
      forced: { by_user_id: forcedBy, at: now },
    }),
    settlement_deadline:
      started && forcedBy === undefined ? now + SETTLEMENT_WINDOW_MS : now,
  };
  await ctx.db.patch(head._id, { device_move: move, updated_at: now });
  if (head.active_delivery_state === "claimed") {
    const { attempt, message } = await activeMoveAttempt(ctx, head, move);
    await requeueDeliveryBeforeEffect(ctx, head._id, message, attempt._id, {
      failure_code: DEVICE_MOVE_FENCE,
      completed_at: now,
    });
  }
  const expiresAt =
    sourceLease && sourceLease.released_at === undefined
      ? Math.min(move.settlement_deadline, sourceLease.expires_at)
      : now;
  return {
    moveId,
    headId: head._id,
    sourceEpoch: binding.epoch,
    expiresAt: started ? expiresAt : null,
  };
}

export async function activeMoveAttempt(
  ctx: Pick<MutationCtx, "db">,
  head: Head,
  move: Move,
) {
  const attempt = move.attempt_id && (await ctx.db.get(move.attempt_id));
  const message = attempt && (await ctx.db.get(attempt.message_id));
  if (
    !attempt ||
    !message ||
    attempt.conversation_id !== head.conversation_id ||
    attempt.execution_epoch !== move.source_epoch ||
    attempt.state !== head.active_delivery_state ||
    message.conversation_id !== attempt.conversation_id ||
    message.execution_epoch !== attempt.execution_epoch ||
    message.delivery_id !== attempt.delivery_id ||
    message.conversation_sequence !== attempt.conversation_sequence ||
    message.delivery_status !== attempt.state ||
    message.active_delivery_attempt_id !== attempt._id
  )
    throw new ConvexError(
      "The move attempt does not match the active delivery slot",
    );
  return { attempt, message };
}

export async function expireMoveSettlement(
  ctx: Pick<MutationCtx, "db">,
  headId: Id<"conversation_execution_heads">,
  sourceEpoch: number,
  now: number,
) {
  const head = await ctx.db.get(headId);
  const move = head?.device_move;
  if (
    !head ||
    !move ||
    move.source_epoch !== sourceEpoch ||
    head.active_delivery_attempt_id !== move.attempt_id ||
    head.active_delivery_state !== "delivery-started"
  )
    return;
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (
    move.forced === undefined &&
    lease &&
    lease.released_at === undefined &&
    now < Math.min(move.settlement_deadline, lease.expires_at)
  )
    return;
  const { attempt, message } = await activeMoveAttempt(ctx, head, move);
  await blockDeliveryAsAmbiguous(
    ctx,
    headId,
    message._id,
    attempt._id,
    now,
    move.forced
      ? {
          failure_code: "FORCED_MOVE_DELIVERY_IN_DOUBT",
          failure_message:
            "The session owner forced the move before delivery was confirmed",
        }
      : {
          failure_code: "MOVE_SETTLEMENT_EXPIRED",
          failure_message:
            "The source could not confirm delivery before its settlement window ended",
        },
  );
}

export function assertMoveAdmissionOpen(head: Pick<Head, "device_move">) {
  if (head.device_move?.phase === "aborting") requireNoDeviceMove(head);
}
