import {
  EdgeClient,
  EdgeParseError,
  EdgeRejected,
  EdgeUnavailable,
} from "@codecast/edge-client/effect";
import type { BlobsGetRequest } from "@codecast/edge-contract";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { SupervisorBus } from "./bus";
import type { EdgeBlobResult, EdgeBusResult } from "./bus-types";

export type EdgeBlobFetcher = (
  request: BlobsGetRequest,
  signal: AbortSignal,
) => Promise<EdgeBlobResult>;

function mapEdgeFailure(
  error: EdgeUnavailable | EdgeRejected | EdgeParseError,
): Extract<EdgeBusResult<never>, { readonly ok: false }> {
  if (error instanceof EdgeUnavailable) {
    return {
      ok: false,
      retryable: true,
      code: error.code,
      ...(error.retry_after_ms === undefined
        ? {}
        : { retry_after_ms: error.retry_after_ms }),
    };
  }
  return {
    ok: false,
    retryable: false,
    code: error.code,
  };
}

export const attachEdgeLinkToBus = Effect.fn(
  "EdgeSupervisor.attachEdgeLinkToBus",
)(function* (fetchBlob?: EdgeBlobFetcher) {
  const bus = yield* SupervisorBus;
  const client = yield* EdgeClient;
  const subscription = yield* bus.subscribe();

  const respond = Effect.fnUntraced(function* <
    T,
    E extends EdgeUnavailable | EdgeRejected | EdgeParseError,
  >(
    effect: Effect.Effect<T, E>,
    publish: (result: EdgeBusResult<T>) => Effect.Effect<void, unknown>,
  ) {
    const outcome = yield* Effect.result(effect);
    const reply: EdgeBusResult<T> =
      outcome._tag === "Success"
        ? { ok: true, response: outcome.success }
        : mapEdgeFailure(outcome.failure);
    yield* publish(reply).pipe(Effect.catch(() => Effect.void));
  });

  const handleBlob = Effect.fnUntraced(function* (
    requestId: string,
    request: BlobsGetRequest,
  ) {
    if (!fetchBlob) {
      yield* bus
        .publish({
          kind: "edge.blob.get.result",
          request_id: requestId,
          ok: false,
          retryable: false,
          code: "blobs_unavailable",
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) => fetchBlob(request, signal),
        catch: () =>
          ({
            ok: false,
            retryable: true,
            code: "blob_fetch_failed",
          }) satisfies EdgeBlobResult,
      }),
    );
    const result: EdgeBlobResult =
      outcome._tag === "Success" ? outcome.success : outcome.failure;
    yield* bus
      .publish({
        kind: "edge.blob.get.result",
        request_id: requestId,
        ...result,
      })
      .pipe(Effect.catch(() => Effect.void));
  });

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const message = yield* PubSub.take(subscription);
        switch (message.kind) {
          case "edge.permits.next":
            yield* Effect.forkChild(
              respond(client.permitsNext(message.request), (result) =>
                bus.publish({
                  kind: "edge.permits.next.result",
                  request_id: message.request_id,
                  ...result,
                }),
              ),
              { startImmediately: true },
            );
            break;
          case "edge.delivery.start":
            yield* Effect.forkChild(
              respond(client.deliveryStart(message.request), (result) =>
                bus.publish({
                  kind: "edge.delivery.start.result",
                  request_id: message.request_id,
                  ...result,
                }),
              ),
              { startImmediately: true },
            );
            break;
          case "edge.delivery.settle":
            yield* Effect.forkChild(
              respond(client.deliverySettle(message.request), (result) =>
                bus.publish({
                  kind: "edge.delivery.settle.result",
                  request_id: message.request_id,
                  ...result,
                }),
              ),
              { startImmediately: true },
            );
            break;
          case "edge.takeover.ack":
            yield* Effect.forkChild(
              respond(client.takeoverAck(message.request), (result) =>
                bus.publish({
                  kind: "edge.takeover.ack.result",
                  request_id: message.request_id,
                  ...result,
                }),
              ),
              { startImmediately: true },
            );
            break;
          case "edge.blob.get":
            yield* Effect.forkChild(
              handleBlob(message.request_id, message.request),
              { startImmediately: true },
            );
            break;
        }
      }),
    ),
    { startImmediately: true },
  );
});
