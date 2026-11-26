import {
  type DbCtx,
  requireOwnedConversation,
  executionHead,
  executionBinding,
  fencedMessages,
  advanceNonterminalHead,
  clearPendingFlagIfQuiet,
} from "./execution-binding.state";
import {
  type ReadyBindingFence,
  claimedPermitWire,
  type PermitFence,
  attemptMatchesFence,
  startedPermitWire,
  matchesRetryableDeliveryReplay,
  deliveryRejectionCodes,
  requeueDeliveryBeforeEffect,
  blockDeliveryAsAmbiguous,
} from "./delivery-slot.state";
import { fail, requireNonEmpty } from "./execution-binding.validators";
import { assertActiveRunLease } from "./edge/runLease";
import type { Id } from "../_generated/dataModel";
import { isConversationSafetyBlocked } from "../conversationSafety";
import { orderedNonterminalMessages } from "./executionQueue";
import { reviveConversationOnDelivery } from "../pendingMessageWrites";
import {
  type FinalDeliveryReceipt,
  finalDeliveryReceipt,
} from "./edge/final-delivery.receipt";

export async function assertReadyFence(
  ctx: DbCtx,
  head: any,
  binding: any,
  fence: ReadyBindingFence & { now: number },
): Promise<void> {
  if (
    head.protocol_state !== "fenced" ||
    head.current_epoch !== fence.executionEpoch
  ) {
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "delivery epoch is not current");
  }
  if (
    !binding ||
    binding.state !== "ready" ||
    binding.epoch !== fence.executionEpoch ||
    binding.configuration_revision !== fence.configurationRevision ||
    binding.applied_configuration_revision !== fence.configurationRevision ||
    binding.owner_device_id !== fence.ownerDeviceId ||
    binding.daemon_boot_id !== fence.daemonBootId ||
    binding.runtime_id !== fence.runtimeId ||
    binding.requested_agent !== binding.actual_agent
  ) {
    fail(
      "DELIVERY_BINDING_FENCE_MISMATCH",
      "ready binding does not match epoch, configuration, owner device, daemon boot, runtime, or agent",
    );
  }
  await assertActiveRunLease(ctx, binding, fence.fencingToken, fence.now);
}

export async function claimNextDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: ReadyBindingFence & {
    conversationId: Id<"conversations">;
    expectedMessageId?: Id<"pending_messages">;
    now: number;
  },
): Promise<any> {
  const conversation = await requireOwnedConversation(
    ctx,
    args.conversationId,
    userId,
  );
  if (isConversationSafetyBlocked(conversation))
    return { state: "busy", reason: "safety" };
  const head = await executionHead(ctx, args.conversationId);
  const binding = await executionBinding(
    ctx,
    args.conversationId,
    args.executionEpoch,
  );
  if (!head)
    fail("EXECUTION_HEAD_MISSING", "conversation has no execution head");
  await assertReadyFence(ctx, head, binding, args);

  if (head.active_delivery_attempt_id !== undefined) {
    const activeAttempt = await ctx.db.get(head.active_delivery_attempt_id);
    if (
      activeAttempt?.state === "claimed" &&
      activeAttempt.execution_epoch === args.executionEpoch &&
      activeAttempt.configuration_revision === args.configurationRevision &&
      activeAttempt.owner_device_id === args.ownerDeviceId &&
      activeAttempt.daemon_boot_id === args.daemonBootId &&
      activeAttempt.runtime_id === args.runtimeId &&
      (!args.expectedMessageId ||
        String(activeAttempt.message_id) === String(args.expectedMessageId))
    ) {
      const activeMessage = await ctx.db.get(activeAttempt.message_id);
      return {
        state: "claimed" as const,
        recovered: true,
        permit: claimedPermitWire(activeAttempt),
        message: activeMessage
          ? {
              _id: activeMessage._id,
              content: activeMessage.content,
              image_storage_id: activeMessage.image_storage_id,
              image_storage_ids: activeMessage.image_storage_ids,
              client_id: activeMessage.client_id,
            }
          : undefined,
      };
    }
    return {
      state: "busy" as const,
      attemptId: String(head.active_delivery_attempt_id),
      activeState: head.active_delivery_state,
    };
  }

  const messages = orderedNonterminalMessages(
    await fencedMessages(ctx, args.conversationId),
    head,
  );
  const message = messages[0];
  if (!message) {
    if (head.next_nonterminal_sequence !== head.next_conversation_sequence) {
      await ctx.db.patch(head._id, {
        next_nonterminal_sequence: head.next_conversation_sequence,
        updated_at: args.now,
      });
    }
    return { state: "empty" as const };
  }
  if (message.conversation_sequence !== head.next_nonterminal_sequence) {
    fail(
      "DELIVERY_SEQUENCE_HEAD_MISMATCH",
      `durable head ${head.next_nonterminal_sequence} differs from first nonterminal ${message.conversation_sequence}`,
    );
  }
  if (
    args.expectedMessageId &&
    String(args.expectedMessageId) !== String(message._id)
  ) {
    return {
      state: "waiting-for-earlier-message" as const,
      messageId: String(message._id),
    };
  }
  if (message.execution_epoch !== head.current_epoch) {
    return {
      state: "waiting-for-successor" as const,
      messageId: String(message._id),
      executionEpoch: message.execution_epoch,
    };
  }
  if (
    message.delivery_status !== "pending" ||
    message.delivery_protocol_version !== head.protocol_version ||
    !message.delivery_id ||
    !message.client_id ||
    message.delivery_id !== message.client_id
  ) {
    fail(
      "DELIVERY_MESSAGE_INVARIANT",
      "head message is not a pending fenced message with one stable client/delivery id",
    );
  }

  const attemptId = await ctx.db.insert("delivery_attempts", {
    conversation_id: args.conversationId,
    message_id: message._id,
    delivery_id: message.delivery_id,
    conversation_sequence: message.conversation_sequence,
    execution_epoch: args.executionEpoch,
    configuration_revision: args.configurationRevision,
    owner_user_id: userId,
    owner_device_id: args.ownerDeviceId,
    daemon_boot_id: args.daemonBootId,
    runtime_id: args.runtimeId,
    state: "claimed" as const,
    claimed_at: args.now,
  });
  await ctx.db.patch(message._id, {
    delivery_status: "claimed" as const,
    active_delivery_attempt_id: attemptId,
  });
  await ctx.db.patch(head._id, {
    active_delivery_attempt_id: attemptId,
    active_delivery_state: "claimed" as const,
    updated_at: args.now,
  });
  const attempt = await ctx.db.get(attemptId);
  return {
    state: "claimed" as const,
    permit: claimedPermitWire(attempt),
    message: {
      _id: message._id,
      content: message.content,
      image_storage_id: message.image_storage_id,
      image_storage_ids: message.image_storage_ids,
      client_id: message.client_id,
    },
  };
}

export async function rejectHeadDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    messageId: Id<"pending_messages">;
    deliveryId: string;
    conversationSequence: number;
    executionEpoch: number;
    reason: string;
    fencingToken?: string;
    now: number;
  },
): Promise<{ rejected: true }> {
  const { conversationId, executionEpoch } = args;
  requireNonEmpty(args.reason, "reason");
  await requireOwnedConversation(ctx, conversationId, userId);
  const head = await executionHead(ctx, conversationId);
  if (!head || head.protocol_state !== "fenced")
    fail(
      "EXECUTION_NOT_FENCED",
      "delivery rejection requires fenced authority",
    );
  if (head.active_delivery_attempt_id !== undefined) {
    fail(
      "DELIVERY_SLOT_BUSY",
      "an active attempt must reach its own explicit disposition",
    );
  }
  const existingMessage = await ctx.db.get(args.messageId);
  if (
    existingMessage?.delivery_status === "rejected" &&
    existingMessage.delivery_id === args.deliveryId &&
    existingMessage.client_id === args.deliveryId &&
    existingMessage.conversation_sequence === args.conversationSequence &&
    existingMessage.execution_epoch === executionEpoch &&
    existingMessage.delivery_disposition_reason === args.reason
  ) {
    return { rejected: true };
  }
  if (head.current_epoch !== executionEpoch)
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "delivery epoch is not current");
  const binding = await executionBinding(ctx, conversationId, executionEpoch);
  await assertActiveRunLease(ctx, binding, args.fencingToken, args.now);
  const message = orderedNonterminalMessages(
    await fencedMessages(ctx, conversationId),
    head,
  )[0];
  if (
    !message ||
    String(message._id) !== String(args.messageId) ||
    message.delivery_id !== args.deliveryId ||
    message.client_id !== args.deliveryId ||
    message.conversation_sequence !== args.conversationSequence ||
    message.execution_epoch !== executionEpoch ||
    message.delivery_status !== "pending"
  ) {
    fail(
      "DELIVERY_SEQUENCE_HEAD_MISMATCH",
      "only the exact pending global head may be rejected",
    );
  }
  await ctx.db.patch(message._id, {
    delivery_status: "rejected" as const,
    delivery_disposition_reason: args.reason,
    status: "cancelled" as const,
  });
  await advanceNonterminalHead(ctx, head, args.now);
  await clearPendingFlagIfQuiet(ctx, conversationId);
  return { rejected: true };
}

export async function verifyAttemptFence(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { now: number },
  expectedAttemptStates: readonly string[],
): Promise<{
  conversation: any;
  head: any;
  binding: any;
  message: any;
  attempt: any;
}> {
  const conversation = await requireOwnedConversation(
    ctx,
    fence.conversationId,
    userId,
  );
  const [head, binding, message, attempt] = await Promise.all([
    executionHead(ctx, fence.conversationId),
    executionBinding(ctx, fence.conversationId, fence.executionEpoch),
    ctx.db.get(fence.messageId),
    ctx.db.get(fence.attemptId),
  ]);
  if (!head || !message || !attempt) {
    fail("DELIVERY_PERMIT_NOT_FOUND", "head, message, or attempt is missing");
  }
  await assertReadyFence(ctx, head, binding, fence);
  const exact =
    attemptMatchesFence(attempt, fence, userId) &&
    String(head.active_delivery_attempt_id) === String(fence.attemptId) &&
    String(message.active_delivery_attempt_id) === String(fence.attemptId) &&
    message.delivery_id === fence.deliveryId &&
    message.client_id === fence.deliveryId &&
    message.conversation_sequence === fence.conversationSequence &&
    message.execution_epoch === fence.executionEpoch;
  if (!exact)
    fail(
      "DELIVERY_PERMIT_FENCE_MISMATCH",
      "permit no longer owns the exact durable slot",
    );
  if (!expectedAttemptStates.includes(attempt.state)) {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", `attempt is ${attempt.state}`);
  }
  return { conversation, head, binding, message, attempt };
}

export async function startDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { now: number },
): Promise<any> {
  const { conversation, head, message, attempt } = await verifyAttemptFence(
    ctx,
    userId,
    fence,
    ["claimed", "delivery-started"],
  );
  if (isConversationSafetyBlocked(conversation))
    fail("CONVERSATION_SAFETY_BLOCKED", "Delivery is held for safety review");
  if (
    attempt.state === "delivery-started" &&
    head.active_delivery_state === "delivery-started" &&
    message.delivery_status === "delivery-started"
  ) {
    return startedPermitWire(attempt);
  }
  if (
    head.active_delivery_state !== "claimed" ||
    message.delivery_status !== "claimed"
  ) {
    fail(
      "DELIVERY_ATTEMPT_STATE_MISMATCH",
      "conversation slot or message is not claimed",
    );
  }
  await ctx.db.patch(attempt._id, {
    state: "delivery-started" as const,
    delivery_started_at: fence.now,
  });
  await ctx.db.patch(message._id, {
    delivery_status: "delivery-started" as const,
  });
  await ctx.db.patch(head._id, {
    active_delivery_state: "delivery-started" as const,
    updated_at: fence.now,
  });
  // The effect is now landing in the pane, so the conversation is alive by
  // definition — clear any kill/dismiss stamps it still carries (the fenced
  // twin of the legacy status path's revival). A fenced delivery that outlived
  // a kill otherwise runs a session the record still calls retired.
  await reviveConversationOnDelivery(ctx, head.conversation_id);
  return startedPermitWire({ ...attempt, state: "delivery-started" });
}

export async function releaseClaimBeforeEffectInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { reason: string; evidence: string; now: number },
): Promise<{ retryable: true; deliveryId: string } | FinalDeliveryReceipt> {
  requireNonEmpty(fence.reason, "reason");
  requireNonEmpty(fence.evidence, "evidence");
  await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingAttempt = await ctx.db.get(fence.attemptId);
  const final = finalDeliveryReceipt(existingAttempt);
  if (final && attemptMatchesFence(existingAttempt, fence, userId))
    return final;
  if (matchesRetryableDeliveryReplay(existingAttempt, fence, userId)) {
    return { retryable: true, deliveryId: existingAttempt.delivery_id };
  }
  const { head, message, attempt } = await verifyAttemptFence(
    ctx,
    userId,
    fence,
    ["claimed"],
  );
  if (
    head.active_delivery_state !== "claimed" ||
    message.delivery_status !== "claimed"
  ) {
    fail(
      "DELIVERY_ALREADY_STARTED",
      "only a claim that never crossed delivery-started can be safely released",
    );
  }
  await requeueDeliveryBeforeEffect(ctx, head._id, message, attempt._id, {
    failure_code: "CLAIM_RELEASED_BEFORE_EFFECT",
    failure_message: fence.reason,
    resolution_evidence: fence.evidence,
    completed_at: fence.now,
  });
  return { retryable: true, deliveryId: message.delivery_id };
}

export async function finishTerminalDelivery(
  ctx: DbCtx,
  head: any,
  message: any,
  attempt: any,
  args: {
    attemptState:
      | "delivered"
      | "correlated-delivered"
      | "abandoned-ambiguous"
      | "failed-before-effect";
    messageState:
      | "delivered"
      | "correlated-delivered"
      | "abandoned-ambiguous"
      | "rejected";
    externalDeliveryId?: string;
    resolutionEvidence?: string;
    rejection?: { code: string; reason: string };
    now: number;
  },
): Promise<void> {
  const cancelled =
    args.messageState === "abandoned-ambiguous" || args.rejection !== undefined;
  await ctx.db.patch(attempt._id, {
    state: args.attemptState,
    external_delivery_id: args.externalDeliveryId,
    resolution_evidence: args.resolutionEvidence,
    completed_at: args.now,
    ...(args.rejection && {
      failure_code: args.rejection.code,
      failure_message: args.rejection.reason,
    }),
  });
  await ctx.db.patch(message._id, {
    delivery_status: args.messageState,
    active_delivery_attempt_id: undefined,
    // Legacy status is projection-only for fenced rows. Keeping terminal rows
    // out of legacy indexes prevents healer/backlog amplification.
    status: cancelled ? "cancelled" : "delivered",
    delivered_at: cancelled ? undefined : args.now,
    ...(args.rejection && {
      delivery_disposition_reason: args.rejection.reason,
    }),
  });
  await ctx.db.patch(head._id, {
    active_delivery_attempt_id: undefined,
    active_delivery_state: undefined,
    updated_at: args.now,
  });
  await advanceNonterminalHead(ctx, head, args.now);
  await clearPendingFlagIfQuiet(ctx, head.conversation_id);
}

export async function completeDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { externalDeliveryId?: string; now: number },
): Promise<{ accepted: true }> {
  await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingAttempt = await ctx.db.get(fence.attemptId);
  if (
    existingAttempt?.state === "delivered" &&
    attemptMatchesFence(existingAttempt, fence, userId)
  ) {
    if (
      fence.externalDeliveryId !== undefined &&
      existingAttempt.external_delivery_id !== fence.externalDeliveryId
    ) {
      fail(
        "DELIVERY_COMPLETION_CONFLICT",
        "external delivery id differs from durable completion",
      );
    }
    return { accepted: true };
  }
  const { head, message, attempt } = await verifyAttemptFence(
    ctx,
    userId,
    fence,
    ["delivery-started"],
  );
  if (
    head.active_delivery_state !== "delivery-started" ||
    message.delivery_status !== "delivery-started"
  ) {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery was not durably started");
  }
  await finishTerminalDelivery(ctx, head, message, attempt, {
    attemptState: "delivered",
    messageState: "delivered",
    externalDeliveryId: fence.externalDeliveryId,
    now: fence.now,
  });
  return { accepted: true };
}

function requireUnreservedFailureCode(failureCode: string): void {
  if (
    failureCode === deliveryRejectionCodes.rejected ||
    failureCode === deliveryRejectionCodes.finalFailure
  ) {
    fail(
      "RESERVED_DELIVERY_FAILURE_CODE",
      "failure code is reserved for edge settlement",
    );
  }
}

export async function failDeliveryBeforeEffectInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & {
    failureCode: string;
    failureMessage: string;
    now: number;
  },
): Promise<{ retryable: true; deliveryId: string } | FinalDeliveryReceipt> {
  requireUnreservedFailureCode(fence.failureCode);
  await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingAttempt = await ctx.db.get(fence.attemptId);
  const final = finalDeliveryReceipt(existingAttempt);
  if (final && attemptMatchesFence(existingAttempt, fence, userId))
    return final;
  if (matchesRetryableDeliveryReplay(existingAttempt, fence, userId)) {
    return { retryable: true, deliveryId: existingAttempt.delivery_id };
  }
  const { head, message, attempt } = await verifyAttemptFence(
    ctx,
    userId,
    fence,
    ["delivery-started"],
  );
  if (
    head.active_delivery_state !== "delivery-started" ||
    message.delivery_status !== "delivery-started"
  ) {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery was not durably started");
  }
  await requeueDeliveryBeforeEffect(ctx, head._id, message, attempt._id, {
    failure_code: fence.failureCode,
    failure_message: fence.failureMessage,
    completed_at: fence.now,
  });
  // Deliberately do not advance next_nonterminal_sequence: the same deliveryId
  // and sequence are retryable only because the driver proved no effect.
  return { retryable: true, deliveryId: message.delivery_id };
}

export async function markDeliveryAmbiguousInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & {
    failureCode: string;
    failureMessage: string;
    now: number;
  },
): Promise<{ blocked: true; deliveryId: string }> {
  requireUnreservedFailureCode(fence.failureCode);
  const { head, message, attempt } = await verifyAttemptFence(
    ctx,
    userId,
    fence,
    ["delivery-started", "ambiguous"],
  );
  if (
    attempt.state === "ambiguous" &&
    head.active_delivery_state === "ambiguous" &&
    message.delivery_status === "ambiguous"
  ) {
    return { blocked: true, deliveryId: message.delivery_id };
  }
  if (
    head.active_delivery_state !== "delivery-started" ||
    message.delivery_status !== "delivery-started"
  ) {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery was not durably started");
  }
  await blockDeliveryAsAmbiguous(
    ctx,
    head._id,
    message._id,
    attempt._id,
    fence.now,
    {
      failure_code: fence.failureCode,
      failure_message: fence.failureMessage,
    },
  );
  // The slot remains owned. A timeout can never be silently reclassified as a
  // pre-effect failure or allow a successor/later message to pass.
  return { blocked: true, deliveryId: message.delivery_id };
}

export async function resolveAmbiguousDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & {
    resolution:
      | "correlated-delivered"
      | "proven-no-effect"
      | "abandoned-ambiguous";
    resolutionEvidence: string;
    now: number;
  },
): Promise<{ state: string }> {
  requireNonEmpty(fence.resolutionEvidence, "resolutionEvidence");
  const states =
    fence.fencingToken !== undefined &&
    fence.resolution !== "abandoned-ambiguous"
      ? ["ambiguous", "delivery-started"]
      : ["ambiguous"];
  const { head, message, attempt } = await verifyAttemptFence(
    ctx,
    userId,
    fence,
    states,
  );
  if (
    head.active_delivery_state !== attempt.state ||
    message.delivery_status !== attempt.state
  ) {
    fail(
      "DELIVERY_ATTEMPT_STATE_MISMATCH",
      "delivery is not ambiguity-blocked",
    );
  }
  if (fence.resolution === "proven-no-effect") {
    await requeueDeliveryBeforeEffect(ctx, head._id, message, attempt._id, {
      resolution_evidence: fence.resolutionEvidence,
      completed_at: fence.now,
    });
    return { state: "pending" };
  }
  const state = fence.resolution;
  await finishTerminalDelivery(ctx, head, message, attempt, {
    attemptState: state,
    messageState: state,
    resolutionEvidence: fence.resolutionEvidence,
    now: fence.now,
  });
  return { state };
}
