import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  blockDeliveryAsAmbiguous,
  requeueDeliveryBeforeEffect,
  type PermitFence,
} from "../delivery-slot.state";
import { loadRunLeaseClaim } from "./runLease";

const SETTLEMENT_WINDOW_MS = 10_000;
export const DEVICE_MOVE_FENCE = "EXECUTION_DEVICE_MOVE_IN_PROGRESS";
type Head = Doc<"conversation_execution_heads">;
type Move = NonNullable<Head["device_move"]>;
type Destination = Pick<
  Move,
  "destination_device_id" | "destination_runner_id"
>;

export function requireNoDeviceMove(head: Pick<Head, "device_move"> | null) {
  if (head?.device_move)
    throw new ConvexError({
      code: DEVICE_MOVE_FENCE,
      message: "Execution is fenced by a device move",
    });
}

export async function assertMoveSettlement(
  ctx: Pick<QueryCtx, "db">,
  head: Head,
  attempt: Doc<"delivery_attempts">,
  fence: PermitFence & { now: number },
) {
  const move = head.device_move;
  if (!move) return;
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (
    attempt._id !== move.attempt_id ||
    attempt.delivery_started_at === undefined ||
    fence.executionEpoch !== move.source_epoch ||
    fence.now >= move.settlement_deadline ||
    !lease ||
    lease.released_at !== undefined ||
    fence.now >= lease.expires_at ||
    lease.fencing_token !== fence.fencingToken
  )
    requireNoDeviceMove(head);
}

export async function recordDeviceMove(
  ctx: Pick<MutationCtx, "db">,
  args: Destination & {
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
  const existing = head?.device_move;
  if (existing) {
    if (
      existing.source_epoch === args.expected_source_epoch &&
      existing.destination_device_id === args.destination_device_id &&
      existing.destination_runner_id === args.destination_runner_id
    )
      return null;
    requireNoDeviceMove(head);
  }
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
  const move: Move = {
    source_epoch: binding.epoch,
    source_lease_id: sourceLease?._id,
    attempt_id: head.active_delivery_attempt_id,
    destination_device_id: args.destination_device_id,
    destination_runner_id: args.destination_runner_id,
    next_epoch: binding.epoch + 1,
    settlement_deadline: now + SETTLEMENT_WINDOW_MS,
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
    headId: head._id,
    sourceEpoch: binding.epoch,
    expiresAt:
      head.active_delivery_state === "delivery-started" ? expiresAt : null,
  };
}

async function activeMoveAttempt(
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
    lease &&
    lease.released_at === undefined &&
    now < Math.min(move.settlement_deadline, lease.expires_at)
  )
    return;
  const { attempt, message } = await activeMoveAttempt(ctx, head, move);
  await blockDeliveryAsAmbiguous(ctx, headId, message._id, attempt._id, now, {
    failure_code: "MOVE_SETTLEMENT_EXPIRED",
    failure_message:
      "The source could not confirm delivery before its settlement window ended",
  });
}
