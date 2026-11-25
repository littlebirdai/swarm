import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type ReadyBindingFence = {
  executionEpoch: number;
  configurationRevision: number;
  ownerDeviceId: string;
  daemonBootId: string;
  runtimeId: string;
  fencingToken?: string;
};

export type PermitFence = ReadyBindingFence & {
  messageId: Id<"pending_messages">;
  deliveryId: string;
  conversationSequence: number;
  attemptId: Id<"delivery_attempts">;
  conversationId: Id<"conversations">;
};

export function claimedPermitWire(attempt: Doc<"delivery_attempts">) {
  return {
    state: "claimed" as const,
    messageId: String(attempt.message_id),
    deliveryId: attempt.delivery_id,
    conversationSequence: String(attempt.conversation_sequence),
    attemptId: String(attempt._id),
    conversationId: String(attempt.conversation_id),
    executionEpoch: attempt.execution_epoch,
    configurationRevision: attempt.configuration_revision,
    ownerDeviceId: attempt.owner_device_id,
    daemonBootId: attempt.daemon_boot_id,
    runtimeId: attempt.runtime_id,
  };
}

export function startedPermitWire(attempt: Doc<"delivery_attempts">) {
  return { ...claimedPermitWire(attempt), state: "delivery-started" as const };
}

export function attemptMatchesFence(
  attempt: Doc<"delivery_attempts"> | null,
  fence: PermitFence,
  userId?: Id<"users">,
): boolean {
  return (
    !!attempt &&
    String(attempt._id) === String(fence.attemptId) &&
    String(attempt.message_id) === String(fence.messageId) &&
    String(attempt.conversation_id) === String(fence.conversationId) &&
    (userId === undefined ||
      String(attempt.owner_user_id) === String(userId)) &&
    attempt.delivery_id === fence.deliveryId &&
    attempt.conversation_sequence === fence.conversationSequence &&
    attempt.execution_epoch === fence.executionEpoch &&
    attempt.configuration_revision === fence.configurationRevision &&
    attempt.owner_device_id === fence.ownerDeviceId &&
    attempt.daemon_boot_id === fence.daemonBootId &&
    attempt.runtime_id === fence.runtimeId
  );
}

type DbCtx = Pick<MutationCtx, "db">;

export async function requeueDeliveryBeforeEffect(
  ctx: DbCtx,
  headId: Id<"conversation_execution_heads">,
  message: Pick<Doc<"pending_messages">, "_id" | "retry_count">,
  attemptId: Id<"delivery_attempts">,
  disposition: Pick<
    Doc<"delivery_attempts">,
    "failure_code" | "failure_message" | "resolution_evidence"
  > & { completed_at: number },
) {
  await ctx.db.patch(attemptId, {
    ...disposition,
    state: "failed-before-effect",
  });
  await ctx.db.patch(message._id, {
    delivery_status: "pending",
    active_delivery_attempt_id: undefined,
    retry_count: (message.retry_count ?? 0) + 1,
  });
  await ctx.db.patch(headId, {
    active_delivery_attempt_id: undefined,
    active_delivery_state: undefined,
    updated_at: disposition.completed_at,
  });
}

export async function blockDeliveryAsAmbiguous(
  ctx: DbCtx,
  headId: Id<"conversation_execution_heads">,
  messageId: Id<"pending_messages">,
  attemptId: Id<"delivery_attempts">,
  now: number,
  disposition: Pick<
    Doc<"delivery_attempts">,
    "failure_code" | "failure_message"
  > &
    Partial<Pick<Doc<"delivery_attempts">, "daemon_boot_id">>,
) {
  await ctx.db.patch(attemptId, { ...disposition, state: "ambiguous" });
  await ctx.db.patch(messageId, { delivery_status: "ambiguous" });
  await ctx.db.patch(headId, {
    active_delivery_state: "ambiguous",
    updated_at: now,
  });
}
