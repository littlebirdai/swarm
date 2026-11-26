import {
  EDGE_ERROR_CODES,
  EDGE_PROTOCOL_VERSION as v1,
  type DeliverySettleResponse,
  type DeliveryStartResponse,
  type PermitsNextResponse,
} from "@codecast/edge-contract";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  assertReadyFence,
  claimNextDeliveryInDb,
  completeDeliveryInDb,
  ExecutionAuthorityError,
  failDeliveryBeforeEffectInDb,
  finishTerminalDelivery,
  markDeliveryAmbiguousInDb,
  resolveAmbiguousDeliveryInDb,
  startDeliveryInDb,
  verifyAttemptFence,
} from "./executionBindings";
import { internalMutation, internalQuery } from "./functions";
import { isConversationSafetyBlocked } from "./conversationSafety";
import {
  attemptMatchesFence,
  deliveryRejectionCodes,
  type PermitFence,
} from "./lib/delivery-slot.state";
import { ownedRun, runForDeliverySettlement } from "./lib/edge/runLease";
import { finalDeliveryReceipt } from "./lib/edge/final-delivery.receipt";
import {
  assertMoveSettlement,
  DEVICE_MOVE_FENCE,
} from "./lib/edge/device-move.state";
import {
  inspectPermitImage,
  permitImageIds,
} from "./lib/edge/blob-policy.rules";

const runFence = {
  v: v.literal(v1),
  bearer: v.string(),
  session: v.string(),
  run: v.number(),
  fencing_token: v.string(),
};
type RunFence = {
  bearer: string;
  session: string;
  run: number;
  fencing_token: string;
};
const deliveryFence = {
  ...runFence,
  delivery_id: v.string(),
  attempt_id: v.string(),
  seq: v.number(),
  intent: v.union(v.literal("queue"), v.literal("steer")),
  sender: v.object({
    kind: v.union(v.literal("person"), v.literal("agent")),
    id: v.string(),
  }),
};
const stale = { v: v1, status: "stale" } as const;
const rejected = { v: v1, status: "rejected", reason: "stale" } as const;
const refusedFences = new Set([
  "EXECUTION_EPOCH_FENCE_MISMATCH",
  "DELIVERY_BINDING_FENCE_MISMATCH",
  "DELIVERY_PERMIT_NOT_FOUND",
  "DELIVERY_PERMIT_FENCE_MISMATCH",
  "DELIVERY_ATTEMPT_STATE_MISMATCH",
]);
const { rejected: rejectedCode, finalFailure: finalFailureCode } =
  deliveryRejectionCodes;

async function withFence<T>(
  refusal: T,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      (error instanceof ExecutionAuthorityError &&
        refusedFences.has(error.code)) ||
      (error instanceof ConvexError &&
        (error.data?.code === "STALE_RUN_LEASE" ||
          error.data?.code === DEVICE_MOVE_FENCE))
    )
      return refusal;
    throw error;
  }
}

async function runContext(
  ctx: Pick<QueryCtx, "db">,
  args: RunFence,
  loadRun = ownedRun,
) {
  const owned = await loadRun(ctx, {
    bearer: args.bearer,
    conversation_id: args.session,
  });
  if (!owned || owned.binding.epoch !== args.run || !owned.binding.runtime_id)
    return null;
  const { binding, head } = owned;
  const fence = {
    conversationId: binding.conversation_id,
    executionEpoch: binding.epoch,
    configurationRevision: binding.configuration_revision,
    ownerDeviceId: binding.owner_device_id,
    daemonBootId: binding.daemon_boot_id,
    runtimeId: owned.binding.runtime_id,
    fencingToken: args.fencing_token,
    now: Date.now(),
  };
  await assertReadyFence(ctx, head, binding, fence);
  const moved =
    !!owned.conversationDeviceId &&
    owned.conversationDeviceId !== binding.owner_device_id;
  return { head, fence, owner: binding.owner_user_id, moved };
}

function deliveryFields(
  attempt: Doc<"delivery_attempts">,
  message: Doc<"pending_messages">,
) {
  return {
    delivery_id: attempt.delivery_id,
    attempt_id: attempt._id,
    seq: attempt.conversation_sequence,
    intent: "queue" as const,
    sender: message.from_conversation_id
      ? { kind: "agent" as const, id: message.from_conversation_id }
      : { kind: "person" as const, id: message.from_user_id },
  };
}

async function deliveryInput(
  ctx: MutationCtx,
  message: Doc<"pending_messages">,
  requireValidAttachments: boolean,
) {
  const ids = permitImageIds(message);
  const images = [];
  for (const blob_id of ids) {
    const image = await inspectPermitImage(ctx, blob_id);
    if (requireValidAttachments && image.status === "too_large")
      return { reason: "An image exceeds the 8 MiB delivery limit." };
    if (requireValidAttachments && image.status === "invalid")
      return { reason: "An image has an unsupported content type." };
    if (image.status === "ready")
      images.push({
        type: "blob" as const,
        blob_id,
        content_type: image.contentType,
      });
  }
  const hasText =
    message.content.replace(/\[image(?:\s+\d+)?\]/gi, "").trim().length > 0;
  if (requireValidAttachments && ids.size && !images.length && !hasText)
    return {
      reason: "The attached images are missing and the message has no text.",
    };
  const text =
    !ids.size || hasText
      ? [{ type: "text" as const, text: message.content }]
      : [];
  return { input: [...text, ...images], hasAttachments: ids.size > 0 };
}

async function deliveryContext(
  ctx: MutationCtx,
  args: RunFence & {
    attempt_id: string;
    delivery_id: string;
    seq: number;
    intent: string;
    sender: { kind: string; id: string };
  },
  settling = false,
) {
  const run = await runContext(
    ctx,
    args,
    settling ? runForDeliverySettlement : ownedRun,
  );
  if (!run) return null;
  const attemptId = ctx.db.normalizeId("delivery_attempts", args.attempt_id);
  if (!attemptId) return null;
  const attempt = await ctx.db.get(attemptId);
  if (
    !attempt ||
    attempt.conversation_id !== run.fence.conversationId ||
    (run.moved && attempt.delivery_started_at === undefined)
  )
    return null;
  const fence = {
    ...run.fence,
    attemptId,
    messageId: attempt.message_id,
    deliveryId: args.delivery_id,
    conversationSequence: args.seq,
  };
  if (!attemptMatchesFence(attempt, fence, run.owner)) return null;
  if (settling) await assertMoveSettlement(ctx, run.head, attempt, fence);
  const message = await ctx.db.get(attempt.message_id);
  if (!message) return null;
  const fields = deliveryFields(attempt, message);
  if (
    fields.intent !== args.intent ||
    fields.sender.kind !== args.sender.kind ||
    fields.sender.id !== args.sender.id
  )
    return null;
  return { owner: run.owner, fence, attempt, fields, message };
}

export const next = internalMutation({
  args: runFence,
  handler: (ctx, args): Promise<PermitsNextResponse> =>
    withFence<PermitsNextResponse>(stale, async () => {
      const run = await runContext(ctx, args);
      if (!run) return stale;
      const result = await claimNextDeliveryInDb(ctx, run.owner, run.fence);
      if (result.state === "empty" || result.state === "waiting-for-successor")
        return { v: v1, status: "empty" };

      const attemptId =
        result.state === "claimed"
          ? ctx.db.normalizeId("delivery_attempts", result.permit.attemptId)
          : run.head.active_delivery_attempt_id;
      const attempt = attemptId && (await ctx.db.get(attemptId));
      if (
        !attempt ||
        (result.state !== "claimed" &&
          (result.reason === "safety" ||
            (attempt.state !== "delivery-started" &&
              attempt.state !== "ambiguous")))
      )
        throw new ConvexError("edge-delivery-unavailable");
      const fence = {
        ...run.fence,
        attemptId: attempt._id,
        messageId: attempt.message_id,
        deliveryId: attempt.delivery_id,
        conversationSequence: attempt.conversation_sequence,
      };
      if (result.state !== "claimed") {
        await verifyAttemptFence(ctx, run.owner, fence, [attempt.state]);
      }
      const message = await ctx.db.get(attempt.message_id);
      if (!message) throw new Error("Delivery message is missing");
      if (message.delivery_status !== attempt.state)
        throw new Error("Delivery message and attempt state differ");
      const prepared = await deliveryInput(
        ctx,
        message,
        attempt.state === "claimed",
      );
      if (prepared.reason !== undefined) {
        await finishEdgeDelivery(ctx, run.owner, fence, {
          code: rejectedCode,
          reason: prepared.reason,
          attachment: true,
        });
        return { v: v1, status: "empty" };
      }
      return {
        v: v1,
        status: "permit",
        session: run.fence.conversationId,
        run: run.fence.executionEpoch,
        fencing_token: args.fencing_token,
        ...deliveryFields(attempt, message),
        state: attempt.state === "claimed" ? "new" : "started",
        input: prepared.input,
      };
    }),
});

export const start = internalMutation({
  args: deliveryFence,
  handler: (ctx, args): Promise<DeliveryStartResponse> =>
    withFence<DeliveryStartResponse>(rejected, async () => {
      const delivery = await deliveryContext(ctx, args);
      if (!delivery) return rejected;
      const { owner, fence, attempt, fields, message } = delivery;
      if (
        message.delivery_status === "rejected" &&
        attempt.failure_code === rejectedCode &&
        attempt.failure_message
      )
        return { ...rejected, reason: attempt.failure_message };
      const prepared = await deliveryInput(
        ctx,
        message,
        attempt.state === "claimed",
      );
      if (prepared.reason !== undefined) {
        await finishEdgeDelivery(ctx, owner, fence, {
          code: rejectedCode,
          reason: prepared.reason,
          attachment: true,
        });
        return { ...rejected, reason: prepared.reason };
      }
      await startDeliveryInDb(ctx, owner, fence);
      return {
        ...fields,
        v: v1,
        status: attempt.state === "claimed" ? "started" : "already_started",
        session: fence.conversationId,
        run: fence.executionEpoch,
        fencing_token: args.fencing_token,
        ...(prepared.hasAttachments ? { input: prepared.input } : {}),
      };
    }),
});

type PermitImage = { storageId: Id<"_storage">; contentType: string };

export const getBlob = internalQuery({
  args: { ...runFence, attempt_id: v.string(), blob_id: v.string() },
  handler: (ctx, args): Promise<PermitImage | null> =>
    withFence<PermitImage | null>(null, async () => {
      const run = await runContext(ctx, args);
      if (!run || run.head.active_delivery_attempt_id !== args.attempt_id)
        return null;
      const attempt = await ctx.db.get(run.head.active_delivery_attempt_id);
      if (!attempt) return null;
      const { message, head } = await verifyAttemptFence(
        ctx,
        run.owner,
        {
          ...run.fence,
          attemptId: attempt._id,
          messageId: attempt.message_id,
          deliveryId: attempt.delivery_id,
          conversationSequence: attempt.conversation_sequence,
        },
        ["claimed", "delivery-started", "ambiguous"],
      );
      const storageId = ctx.db.system.normalizeId("_storage", args.blob_id);
      if (
        !storageId ||
        !permitImageIds(message).has(storageId) ||
        head.active_delivery_state !== attempt.state ||
        message.delivery_status !== attempt.state
      )
        return null;
      const image = await inspectPermitImage(ctx, storageId);
      if (image.status === "missing") return null;
      if (image.status === "too_large")
        throw new ConvexError(EDGE_ERROR_CODES.TOO_LARGE);
      if (image.status === "invalid")
        throw new ConvexError(EDGE_ERROR_CODES.INVALID);
      return { storageId, contentType: image.contentType };
    }),
});

async function finishEdgeDelivery(
  ctx: MutationCtx,
  owner: Doc<"users">["_id"],
  fence: PermitFence & { now: number },
  rejection?: {
    code: string;
    reason: string;
    evidence?: string;
    attachment?: true;
  },
) {
  const states = !rejection
    ? ["delivery-started"]
    : rejection.attachment
      ? ["claimed"]
      : rejection.evidence === undefined
        ? ["claimed", "delivery-started"]
        : ["delivery-started", "ambiguous"];
  const { conversation, head, message, attempt } = await verifyAttemptFence(
    ctx,
    owner,
    fence,
    states,
    rejection?.attachment ? undefined : "settle",
  );
  if (rejection?.attachment && isConversationSafetyBlocked(conversation))
    throw new ExecutionAuthorityError(
      "CONVERSATION_SAFETY_BLOCKED",
      "Delivery is held for safety review",
    );
  if (
    head.active_delivery_state !== attempt.state ||
    message.delivery_status !== attempt.state
  )
    throw new ExecutionAuthorityError(
      "DELIVERY_ATTEMPT_STATE_MISMATCH",
      "delivery slot does not match its attempt",
    );
  await finishTerminalDelivery(ctx, head, message, attempt, {
    attemptState: rejection ? "failed-before-effect" : "correlated-delivered",
    messageState: rejection ? "rejected" : "correlated-delivered",
    rejection,
    resolutionEvidence: rejection?.evidence,
    now: fence.now,
  });
}

export const settle = internalMutation({
  args: {
    ...deliveryFence,
    outcome: v.union(
      v.literal("applied"),
      v.literal("duplicate"),
      v.literal("failed"),
      v.literal("in_doubt"),
      v.literal("rejected"),
    ),
    detail: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
    resolution_evidence: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<DeliverySettleResponse> =>
    withFence<DeliverySettleResponse>(stale, async () => {
      const delivery = await deliveryContext(ctx, args, true);
      if (!delivery) return stale;
      const { owner, fence, attempt } = delivery;
      const { outcome, resolution_evidence: evidence } = args;
      if (
        outcome === "failed" &&
        args.retryable !== false &&
        evidence === undefined &&
        finalDeliveryReceipt(attempt)
      )
        return { v: v1, status: "duplicate" };
      const applied = outcome === "applied" || outcome === "duplicate";
      const rejection =
        outcome === "rejected"
          ? rejectedCode
          : outcome === "failed" && args.retryable === false
            ? finalFailureCode
            : undefined;
      const recordedRejection =
        attempt.failure_code === rejectedCode ||
        attempt.failure_code === finalFailureCode
          ? attempt.failure_code
          : undefined;
      const completedState = applied
        ? outcome === "duplicate" || evidence !== undefined
          ? "correlated-delivered"
          : "delivered"
        : "failed-before-effect";
      if (
        (outcome === "in_doubt" && attempt.state === "ambiguous") ||
        (outcome !== "in_doubt" &&
          attempt.state === completedState &&
          attempt.resolution_evidence === evidence &&
          recordedRejection === rejection)
      )
        return { v: v1, status: "duplicate" };
      if (attempt.state === "ambiguous" && evidence === undefined)
        throw new ConvexError("resolution_evidence_required");
      if (outcome === "in_doubt") {
        await markDeliveryAmbiguousInDb(ctx, owner, {
          ...fence,
          failureCode: "EDGE_DELIVERY_IN_DOUBT",
          failureMessage: args.detail ?? "The daemon could not verify delivery",
        });
      } else if (rejection) {
        await finishEdgeDelivery(ctx, owner, fence, {
          code: rejection,
          reason: "The daemon could not deliver this message",
          evidence,
        });
      } else if (evidence !== undefined) {
        await resolveAmbiguousDeliveryInDb(ctx, owner, {
          ...fence,
          resolution: applied ? "correlated-delivered" : "proven-no-effect",
          resolutionEvidence: evidence,
        });
      } else if (outcome === "duplicate") {
        await finishEdgeDelivery(ctx, owner, fence);
      } else if (applied) {
        await completeDeliveryInDb(ctx, owner, fence);
      } else {
        if (attempt.state === "failed-before-effect") return stale;
        await failDeliveryBeforeEffectInDb(ctx, owner, {
          ...fence,
          failureCode: "EDGE_DELIVERY_FAILED",
          failureMessage:
            args.detail ?? "The daemon reported no delivery effect",
        });
      }
      return { v: v1, status: "recorded" };
    }),
});
