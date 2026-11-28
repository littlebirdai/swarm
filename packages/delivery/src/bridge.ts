import {
  SupervisorBus,
  makeHandlerPool,
  type BusMessage,
  type HandlerPool,
} from "@codecast/edge-supervisor/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type { DeliveryBridge, DeliveryBridgeLimits } from "./types";

const BUSY_RETRY_MS = 250;

function causeCode(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function edgeFailure(code: string, retryable: boolean) {
  return { ok: false as const, retryable, code };
}

const edgeBusy = {
  ok: false as const,
  retryable: true,
  code: "delivery_bridge_busy",
  retry_after_ms: BUSY_RETRY_MS,
};

export function deliveryBridgeLayer(
  bridge: DeliveryBridge | undefined,
  limits: DeliveryBridgeLimits = {},
) {
  if (!bridge) return Layer.empty;
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const bus = yield* SupervisorBus;
      const subscription = yield* bus.subscribe();
      const edgePool = makeHandlerPool(limits.edge);
      const providerPool = makeHandlerPool(limits.provider);
      const cancellable = new Map<string, AbortController>();

      const publishQuietly = (message: BusMessage) =>
        bus.publish(message).pipe(Effect.catch(() => Effect.void));

      const serve = <T>(
        requestId: string,
        run: (signal: AbortSignal) => Promise<T>,
        failure: (cause: unknown) => NoInfer<T>,
        busy: NoInfer<T>,
        reply: (value: T) => BusMessage,
        pool: HandlerPool = edgePool,
        cancelable = false,
      ) => {
        const controller = new AbortController();
        const handler = Effect.tryPromise({
          try: (signal) => {
            signal.addEventListener("abort", () => controller.abort(), {
              once: true,
            });
            if (cancelable) cancellable.set(requestId, controller);
            return run(controller.signal);
          },
          catch: failure,
        }).pipe(
          Effect.result,
          Effect.flatMap((outcome) =>
            publishQuietly(
              reply(
                outcome._tag === "Success" ? outcome.success : outcome.failure,
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (cancellable.get(requestId) === controller) {
                cancellable.delete(requestId);
              }
            }),
          ),
        );
        return pool.dispatch(handler, publishQuietly(reply(busy)));
      };

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const message = yield* PubSub.take(subscription);
            switch (message.kind) {
              case "edge.permits.next":
                if (bridge.permitsNext) {
                  const handle = bridge.permitsNext;
                  yield* serve(
                    message.request_id,
                    (signal) => handle(message.request, signal),
                    (cause) => edgeFailure(causeCode(cause), false),
                    edgeBusy,
                    (result) => ({
                      kind: "edge.permits.next.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                  );
                }
                break;
              case "edge.delivery.start":
                if (bridge.deliveryStart) {
                  const handle = bridge.deliveryStart;
                  yield* serve(
                    message.request_id,
                    (signal) => handle(message.request, signal),
                    (cause) => edgeFailure(causeCode(cause), true),
                    edgeBusy,
                    (result) => ({
                      kind: "edge.delivery.start.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                  );
                }
                break;
              case "edge.delivery.settle":
                if (bridge.deliverySettle) {
                  const handle = bridge.deliverySettle;
                  yield* serve(
                    message.request_id,
                    (signal) => handle(message.request, signal),
                    (cause) => edgeFailure(causeCode(cause), true),
                    edgeBusy,
                    (result) => ({
                      kind: "edge.delivery.settle.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                  );
                }
                break;
              case "edge.takeover.ack":
                if (bridge.takeoverAck) {
                  const handle = bridge.takeoverAck;
                  yield* serve(
                    message.request_id,
                    (signal) => handle(message.request, signal),
                    (cause) => edgeFailure(causeCode(cause), true),
                    edgeBusy,
                    (result) => ({
                      kind: "edge.takeover.ack.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                  );
                }
                break;
              case "edge.blob.get":
                if (bridge.blobGet) {
                  const fetchBlob = bridge.blobGet;
                  yield* serve(
                    message.request_id,
                    (signal) => fetchBlob(message.request, signal),
                    () => edgeFailure("blob_fetch_failed", true),
                    edgeBusy,
                    (result) => ({
                      kind: "edge.blob.get.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                  );
                }
                break;
              case "provider.deliver":
                if (bridge.deliver) {
                  const deliver = bridge.deliver;
                  yield* serve(
                    message.request_id,
                    (signal) => deliver(message, signal),
                    (cause) => ({
                      status: "in_doubt" as const,
                      reason: "unknown" as const,
                      code: "provider_deliver_failed",
                      message: causeCode(cause),
                    }),
                    {
                      status: "failed" as const,
                      retryable: true,
                      code: "delivery_bridge_busy",
                      message: "The delivery bridge is at capacity",
                      retry_after_ms: BUSY_RETRY_MS,
                    },
                    (outcome) => ({
                      kind: "provider.deliver.result",
                      request_id: message.request_id,
                      delivery_id: message.delivery_id,
                      attempt_id: message.attempt_id,
                      outcome,
                    }),
                    providerPool,
                    true,
                  );
                }
                break;
              case "provider.deliver.cancel":
                cancellable.get(message.request_id)?.abort();
                break;
              case "provider.recover":
                if (bridge.recover) {
                  const recover = bridge.recover;
                  yield* serve(
                    message.request_id,
                    (signal) => recover(message, signal),
                    (cause) => ({
                      status: "in_doubt" as const,
                      code: "provider_recover_failed",
                      message: causeCode(cause),
                    }),
                    { status: "busy" as const, retry_after_ms: BUSY_RETRY_MS },
                    (outcome) => ({
                      kind: "provider.recover.result",
                      request_id: message.request_id,
                      delivery_id: message.delivery_id,
                      attempt_id: message.attempt_id,
                      outcome,
                    }),
                    providerPool,
                  );
                }
                break;
            }
          }),
          { disableYield: true },
        ),
        { startImmediately: true },
      );
    }),
  );
}
