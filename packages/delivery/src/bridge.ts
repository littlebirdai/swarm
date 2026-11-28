import {
  SupervisorBus,
  type BusMessage,
} from "@codecast/edge-supervisor/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type { DeliveryBridge } from "./types";

function dispatchBusCall<T>(
  run: (signal: AbortSignal) => Promise<T>,
  fallback: (cause: unknown) => T,
  publish: (value: T) => BusMessage,
  bus: SupervisorBus["Service"],
) {
  return Effect.forkChild(
    Effect.result(
      Effect.tryPromise({
        try: (signal) => run(signal),
        catch: fallback,
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        bus.publish(
          publish(
            outcome._tag === "Success" ? outcome.success : outcome.failure,
          ),
        ),
      ),
      Effect.catch(() => Effect.void),
    ),
    { startImmediately: true },
  );
}

export function deliveryBridgeLayer(bridge: DeliveryBridge | undefined) {
  if (!bridge) return Layer.empty;
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const bus = yield* SupervisorBus;
      const subscription = yield* bus.subscribe();
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const message = yield* PubSub.take(subscription);
            switch (message.kind) {
              case "edge.permits.next":
                if (bridge.permitsNext) {
                  const handle = bridge.permitsNext;
                  yield* dispatchBusCall(
                    (signal) => handle(message.request, signal),
                    (cause) => ({
                      ok: false as const,
                      retryable: false,
                      code:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                    (result) => ({
                      kind: "edge.permits.next.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                    bus,
                  );
                }
                break;
              case "edge.delivery.start":
                if (bridge.deliveryStart) {
                  const handle = bridge.deliveryStart;
                  yield* dispatchBusCall(
                    (signal) => handle(message.request, signal),
                    (cause) => ({
                      ok: false as const,
                      retryable: true,
                      code:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                    (result) => ({
                      kind: "edge.delivery.start.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                    bus,
                  );
                }
                break;
              case "edge.delivery.settle":
                if (bridge.deliverySettle) {
                  const handle = bridge.deliverySettle;
                  yield* dispatchBusCall(
                    (signal) => handle(message.request, signal),
                    (cause) => ({
                      ok: false as const,
                      retryable: true,
                      code:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                    (result) => ({
                      kind: "edge.delivery.settle.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                    bus,
                  );
                }
                break;
              case "edge.takeover.ack":
                if (bridge.takeoverAck) {
                  const handle = bridge.takeoverAck;
                  yield* dispatchBusCall(
                    (signal) => handle(message.request, signal),
                    (cause) => ({
                      ok: false as const,
                      retryable: true,
                      code:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                    (result) => ({
                      kind: "edge.takeover.ack.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                    bus,
                  );
                }
                break;
              case "edge.blob.get":
                if (bridge.blobGet) {
                  const fetchBlob = bridge.blobGet;
                  yield* dispatchBusCall(
                    (signal) => fetchBlob(message.request, signal),
                    () => ({
                      ok: false as const,
                      retryable: true,
                      code: "blob_fetch_failed",
                    }),
                    (result) => ({
                      kind: "edge.blob.get.result",
                      request_id: message.request_id,
                      ...result,
                    }),
                    bus,
                  );
                }
                break;
              case "provider.deliver":
                if (bridge.deliver) {
                  yield* dispatchBusCall(
                    (signal) => bridge.deliver!(message, signal),
                    (cause) => ({
                      status: "in_doubt" as const,
                      reason: "unknown" as const,
                      code: "provider_deliver_failed",
                      message:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                    (outcome) => ({
                      kind: "provider.deliver.result",
                      request_id: message.request_id,
                      delivery_id: message.delivery_id,
                      attempt_id: message.attempt_id,
                      outcome,
                    }),
                    bus,
                  );
                }
                break;
              case "provider.recover":
                if (bridge.recover) {
                  yield* dispatchBusCall(
                    (signal) => bridge.recover!(message, signal),
                    (cause) => ({
                      status: "in_doubt" as const,
                      code: "provider_recover_failed",
                      message:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                    (outcome) => ({
                      kind: "provider.recover.result",
                      request_id: message.request_id,
                      delivery_id: message.delivery_id,
                      attempt_id: message.attempt_id,
                      outcome,
                    }),
                    bus,
                  );
                }
                break;
            }
          }),
        ),
        { startImmediately: true },
      );
    }),
  );
}
