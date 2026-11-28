import type {
  DeliveryResolutionRequest,
  DeliverySettleRequest,
  DeliveryStartRequest,
  PermitsNextRequest,
  TakeoverFence,
} from "@codecast/edge-contract";
import type {
  BusTimeoutError,
  BusValidationError,
  ProviderRecoverOutcome,
  SupervisorBus,
} from "@codecast/edge-supervisor/effect";
import * as Effect from "effect/Effect";
import {
  DeliveryError,
  covers,
  permitIdentity,
  requestId,
  setBoundedMap,
  type makeJournalStore,
} from "./journals";
import type {
  DeliveryOptions,
  DeliveryReceipt,
  DeliveryStepOutcome,
  SettlementReceiptStatus,
} from "./types";

export function makeSettlement(deps: {
  readonly bus: SupervisorBus["Service"];
  readonly options: DeliveryOptions;
  readonly journals: ReturnType<typeof makeJournalStore>;
  readonly activeAttempts: ReadonlySet<string>;
  readonly attemptKey: (
    run: Pick<PermitsNextRequest, "session" | "run">,
    attemptId: string,
  ) => string;
  readonly awaitingReceiptRuns: Map<string, PermitsNextRequest>;
}) {
  const {
    bus,
    options,
    journals,
    activeAttempts,
    attemptKey,
    awaitingReceiptRuns,
  } = deps;

  const mapBusError = (
    operation: DeliveryError["operation"],
    error: BusValidationError | BusTimeoutError,
  ) =>
    new DeliveryError({
      operation,
      code:
        error._tag === "BusTimeoutError"
          ? "bus_timeout"
          : "bus_validation_failed",
      retryable: error._tag === "BusTimeoutError",
      cause: error,
    });

  const clearArtifacts = (attemptId: string) =>
    options.clearArtifacts
      ? Effect.promise(() => options.clearArtifacts!(attemptId).catch(() => {}))
      : Effect.void;

  const publishSettled = (
    session: string,
    run: number,
    deliveryId: string,
    attemptId: string,
    outcome: "delivered" | "duplicate" | "in_doubt" | "failed" | "stale",
    retryAfterMs?: number,
  ) =>
    bus
      .publish({
        kind: "delivery.settled",
        session,
        run,
        delivery_id: deliveryId,
        attempt_id: attemptId,
        outcome,
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      })
      .pipe(Effect.catch(() => Effect.void));

  const settleOnEdge = Effect.fnUntraced(function* (
    run: PermitsNextRequest,
    request: DeliverySettleRequest | DeliveryResolutionRequest,
  ) {
    const reqId = requestId();
    const result = yield* bus
      .request(
        {
          kind: "edge.delivery.settle",
          request_id: reqId,
          request: { ...request, fencing_token: run.fencing_token },
        },
        "edge.delivery.settle.result",
        (reply) => reply.request_id === reqId,
      )
      .pipe(Effect.mapError((error) => mapBusError("delivery.settle", error)));
    if (!result.ok) {
      return result;
    }
    const receipt = result.response;
    if (receipt.status !== "stale" && request.outcome !== "in_doubt") {
      const steer = yield* journals.loadSteer(run);
      if (
        steer.handovers.some((hand) => hand.attempt_id === request.attempt_id)
      ) {
        yield* journals.saveSteer(run, {
          ...steer,
          handovers: steer.handovers.filter(
            (hand) => hand.attempt_id !== request.attempt_id,
          ),
        });
      }
    }
    return { ok: true as const, receipt };
  });

  const settleApplied = Effect.fnUntraced(function* (
    run: PermitsNextRequest,
    permit: Omit<DeliveryStartRequest, "v">,
    receipt: DeliveryReceipt,
    statusKind: "delivered" | "duplicate",
  ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
    yield* journals.saveReceipt(permit.session, receipt);
    const settled = yield* settleOnEdge(run, {
      ...permitIdentity(permit),
      outcome: "applied",
      resolution_evidence: JSON.stringify(receipt),
    });
    if (!settled.ok) {
      if (settled.retryable) {
        return {
          status: "retry_scheduled",
          retryable: true,
          code: settled.code,
          retry_after_ms: settled.retry_after_ms,
        };
      }
      return yield* new DeliveryError({
        operation: "delivery.settle",
        code: settled.code,
      });
    }
    if (settled.receipt.status === "stale") {
      return { status: "lease_stale" };
    }
    yield* journals.forgetReceipt(permit.session, permit.delivery_id);
    yield* clearArtifacts(permit.attempt_id);
    awaitingReceiptRuns.delete(permit.session);
    yield* publishSettled(
      permit.session,
      permit.run,
      permit.delivery_id,
      permit.attempt_id,
      statusKind,
    );
    return {
      status: statusKind,
      delivery_id: permit.delivery_id,
      attempt_id: permit.attempt_id,
      receipt,
      receipt_status: settled.receipt.status,
    };
  });

  const settleNonApplied = Effect.fnUntraced(function* (
    run: PermitsNextRequest,
    permit: Omit<DeliveryStartRequest, "v">,
    outcome:
      | {
          readonly status: "in_doubt";
          readonly code: string;
          readonly message: string;
          readonly retry_after_ms?: number;
        }
      | {
          readonly status: "failed";
          readonly retryable: boolean;
          readonly code: string;
          readonly message: string;
          readonly retry_after_ms?: number;
          readonly resolution_evidence?: string;
        }
      | {
          readonly status: "stale";
          readonly observed: {
            readonly kind: "turn";
            readonly turn: string | null;
          };
        },
  ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
    const base = permitIdentity(permit);
    const payload: DeliverySettleRequest | DeliveryResolutionRequest =
      outcome.status === "in_doubt"
        ? { ...base, outcome: "in_doubt", detail: outcome.message }
        : outcome.status === "stale"
          ? { ...base, outcome: "stale", observed: outcome.observed }
          : outcome.resolution_evidence
            ? {
                ...base,
                outcome: "failed",
                retryable: false,
                resolution_evidence: outcome.resolution_evidence,
              }
            : {
                ...base,
                outcome: "failed",
                retryable: outcome.retryable,
                detail: outcome.message,
              };
    const settled = yield* settleOnEdge(run, payload);
    if (!settled.ok) {
      if (settled.retryable) {
        return {
          status: "retry_scheduled",
          retryable: true,
          code: settled.code,
          retry_after_ms: settled.retry_after_ms,
        };
      }
      return yield* new DeliveryError({
        operation: "delivery.settle",
        code: settled.code,
      });
    }
    const receiptStatus: SettlementReceiptStatus = settled.receipt.status;
    if (receiptStatus === "stale") {
      return { status: "lease_stale" };
    }
    if (outcome.status !== "in_doubt") {
      yield* clearArtifacts(permit.attempt_id);
    } else if (outcome.retry_after_ms === undefined) {
      setBoundedMap(awaitingReceiptRuns, run.session, run);
    }
    const retryAfterMs =
      "retry_after_ms" in outcome ? outcome.retry_after_ms : undefined;
    yield* publishSettled(
      permit.session,
      permit.run,
      permit.delivery_id,
      permit.attempt_id,
      outcome.status,
      retryAfterMs,
    );
    if (outcome.status === "in_doubt") {
      return {
        status: "in_doubt",
        delivery_id: permit.delivery_id,
        attempt_id: permit.attempt_id,
        code: outcome.code,
        message: outcome.message,
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
        receipt_status: receiptStatus,
      };
    }
    if (outcome.status === "stale") {
      return {
        status: "stale",
        delivery_id: permit.delivery_id,
        attempt_id: permit.attempt_id,
        observed: outcome.observed,
        receipt_status: receiptStatus,
      };
    }
    return {
      status: "failed",
      delivery_id: permit.delivery_id,
      attempt_id: permit.attempt_id,
      retryable: outcome.retryable,
      code: outcome.code,
      message: outcome.message,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      receipt_status: receiptStatus,
    };
  });

  const recoverStarted = Effect.fnUntraced(function* (
    run: PermitsNextRequest,
    permit: Omit<DeliveryStartRequest, "v"> & {
      readonly expected?: { readonly kind: "turn"; readonly turn: string };
      readonly baton_token?: number | null;
    },
    wasAlreadyApplied = false,
  ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
    const existing = yield* journals.findReceipt(
      permit.session,
      permit.delivery_id,
    );
    if (existing) {
      return yield* settleApplied(
        run,
        permit,
        existing,
        wasAlreadyApplied ? "duplicate" : "delivered",
      );
    }
    const reqId = requestId();
    const reply = yield* bus
      .request(
        {
          kind: "provider.recover",
          request_id: reqId,
          session: permit.session,
          run: permit.run,
          fencing_token: run.fencing_token,
          delivery_id: permit.delivery_id,
          attempt_id: permit.attempt_id,
          ...(permit.expected ? { expected: permit.expected } : {}),
          ...(permit.baton_token !== undefined
            ? { baton_token: permit.baton_token }
            : {}),
        },
        "provider.recover.result",
        (response) =>
          response.request_id === reqId &&
          response.attempt_id === permit.attempt_id,
      )
      .pipe(
        Effect.catchTag("BusTimeoutError", () => {
          const timedOut: { readonly outcome: ProviderRecoverOutcome } = {
            outcome: {
              status: "in_doubt",
              code: "provider_timeout",
              message: "Provider recovery timed out",
            },
          };
          return Effect.succeed(timedOut);
        }),
        Effect.mapError((error) => mapBusError("bus", error)),
      );

    if (reply.outcome.status === "delivered") {
      if (reply.outcome.receipt.delivery_id !== permit.delivery_id) {
        return yield* settleNonApplied(run, permit, {
          status: "in_doubt",
          code: "receipt_mismatch",
          message: "Recovered receipt did not match delivery_id",
        });
      }
      return yield* settleApplied(
        run,
        permit,
        reply.outcome.receipt,
        "delivered",
      );
    }
    if (reply.outcome.status === "failed") {
      return yield* settleNonApplied(run, permit, {
        status: "failed",
        retryable: false,
        code: "recovery_failed",
        message: reply.outcome.resolution_evidence,
        resolution_evidence: reply.outcome.resolution_evidence,
      });
    }
    return yield* settleNonApplied(run, permit, {
      status: "in_doubt",
      code: reply.outcome.code,
      message: reply.outcome.message,
      retry_after_ms: reply.outcome.retry_after_ms,
    });
  });

  const receiveTakeoverFence = Effect.fnUntraced(function* (
    run: PermitsNextRequest,
    fence: TakeoverFence,
  ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
    if (journals.observedTurn(run).turn !== fence.turn) {
      yield* journals.loadPrunedSteer(run);
      return { status: "fenced" };
    }
    const key = JSON.stringify([run.session, run.run, fence.fence_id]);
    const unrecorded = journals.unrecordedFences.get(key);
    if (!unrecorded) setBoundedMap(journals.unrecordedFences, key, fence);
    let journal = yield* journals.loadSteer(run);
    const old = journal.fences.find((item) => item.fence_id === fence.fence_id);
    if (
      [old, unrecorded].some(
        (item) =>
          item &&
          (item.turn !== fence.turn ||
            item.run !== fence.run ||
            item.session !== fence.session ||
            item.baton_token !== fence.baton_token ||
            item.new_baton_token !== fence.new_baton_token),
      )
    ) {
      if (!unrecorded) journals.unrecordedFences.delete(key);
      return yield* new DeliveryError({
        operation: "takeover.ack",
        code: "takeover_fence_conflict",
      });
    }
    if (!old || old.fencing_token !== fence.fencing_token) {
      journal = {
        ...journal,
        fences: [
          ...journal.fences.filter((item) => item.fence_id !== fence.fence_id),
          old?.acknowledged ? { ...fence, acknowledged: true } : fence,
        ],
      };
      yield* journals.saveSteer(run, journal);
    }
    journals.unrecordedFences.delete(key);
    for (const hand of journal.handovers.filter((item) =>
      covers(fence, item),
    )) {
      if (activeAttempts.has(attemptKey(run, hand.attempt_id))) {
        return { status: "pending" };
      }
      const step = yield* recoverStarted(run, hand);
      if (step.status === "in_doubt" || step.status === "lease_stale") {
        return { status: "pending" };
      }
      journal = yield* journals.loadSteer(run);
    }
    if (journals.observedTurn(run).turn !== fence.turn) {
      return { status: "fenced" };
    }
    const reqId = requestId();
    const ackReply = yield* bus
      .request(
        {
          kind: "edge.takeover.ack",
          request_id: reqId,
          request: {
            v: fence.v,
            session: fence.session,
            run: fence.run,
            fencing_token: fence.fencing_token,
            fence_id: fence.fence_id,
            turn: fence.turn,
            baton_token: fence.baton_token,
          },
        },
        "edge.takeover.ack.result",
        (reply) => reply.request_id === reqId,
      )
      .pipe(Effect.mapError((error) => mapBusError("takeover.ack", error)));
    if (!ackReply.ok) {
      if (ackReply.retryable) {
        return {
          status: "retry_scheduled",
          retryable: true,
          code: ackReply.code,
          retry_after_ms: ackReply.retry_after_ms,
        };
      }
      return yield* new DeliveryError({
        operation: "takeover.ack",
        code: ackReply.code,
      });
    }
    const confirmed =
      ackReply.response.status !== "stale" && !old?.acknowledged
        ? {
            ...journal,
            fences: journal.fences.map((item) =>
              item.fence_id === fence.fence_id
                ? { ...item, acknowledged: true as const }
                : item,
            ),
          }
        : journal;
    const pruned = journals.withoutClosedFences(run, confirmed);
    if (pruned !== journal) yield* journals.saveSteer(run, pruned);
    return { status: "takeover", receipt: ackReply.response };
  });

  return {
    clearArtifacts,
    settleApplied,
    settleNonApplied,
    recoverStarted,
    receiveTakeoverFence,
  };
}
