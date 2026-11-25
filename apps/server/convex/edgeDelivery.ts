import {
  EDGE_PROTOCOL_VERSION as v1,
  type DeliverySettleResponse,
  type DeliveryStartResponse,
  type PermitsNextResponse,
} from "@codecast/edge-contract";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
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
import { internalMutation } from "./functions";
import {
  attemptMatchesFence,
  deliveryRejectionCodes,
  type PermitFence,
} from "./lib/delivery-slot.state";
import { ownedRun } from "./lib/edge/runLease";

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
      (error instanceof ConvexError && error.data?.code === "STALE_RUN_LEASE")
    )
      return refusal;
    throw error;
  }
}

async function runContext(ctx: MutationCtx, args: RunFence) {
  const owned = await ownedRun(ctx, {
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
  return { head, fence, owner: binding.owner_user_id };
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

function requireTextDelivery(message: Doc<"pending_messages">) {
  if (message.image_storage_id || message.image_storage_ids?.length)
    throw new ConvexError("edge-delivery-unsupported");
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
) {
  const run = await runContext(ctx, args);
  if (!run) return null;
  const attemptId = ctx.db.normalizeId("delivery_attempts", args.attempt_id);
  if (!attemptId) return null;
  const attempt = await ctx.db.get(attemptId);
  if (!attempt || attempt.conversation_id !== run.fence.conversationId)
    return null;
  const fence = {
    ...run.fence,
    attemptId,
    messageId: attempt.message_id,
    deliveryId: args.delivery_id,
    conversationSequence: args.seq,
  };
  if (!attemptMatchesFence(attempt, fence, run.owner)) return null;
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
      if (result.state !== "claimed") {
        await verifyAttemptFence(
          ctx,
          run.owner,
          {
            ...run.fence,
            attemptId: attempt._id,
            messageId: attempt.message_id,
            deliveryId: attempt.delivery_id,
            conversationSequence: attempt.conversation_sequence,
          },
          [attempt.state],
        );
      }
      const message = await ctx.db.get(attempt.message_id);
      if (!message) throw new Error("Delivery message is missing");
      if (message.delivery_status !== attempt.state)
        throw new Error("Delivery message and attempt state differ");
      requireTextDelivery(message);
      return {
        v: v1,
        status: "permit",
        session: run.fence.conversationId,
        run: run.fence.executionEpoch,
        fencing_token: args.fencing_token,
        ...deliveryFields(attempt, message),
        state: attempt.state === "claimed" ? "new" : "started",
        input: [{ type: "text", text: message.content }],
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
      await startDeliveryInDb(ctx, owner, fence);
      requireTextDelivery(message);
      return {
        ...fields,
        v: v1,
        status: attempt.state === "claimed" ? "started" : "already_started",
        session: fence.conversationId,
        run: fence.executionEpoch,
        fencing_token: args.fencing_token,
      };
    }),
});

async function finishEdgeDelivery(
  ctx: MutationCtx,
  owner: Doc<"users">["_id"],
  fence: PermitFence & { now: number },
  rejection?: { code: string; reason: string; evidence?: string },
) {
  const states = !rejection
    ? ["delivery-started"]
    : rejection.evidence === undefined
      ? ["claimed", "delivery-started"]
      : ["delivery-started", "ambiguous"];
  const { head, message, attempt } = await verifyAttemptFence(
    ctx,
    owner,
    fence,
    states,
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
      const delivery = await deliveryContext(ctx, args);
      if (!delivery) return stale;
      requireTextDelivery(delivery.message);
      const { owner, fence, attempt } = delivery;
      const { outcome, resolution_evidence: evidence } = args;
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
