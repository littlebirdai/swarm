import type { Done } from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RawProviderFrame } from "./options";
import {
  AdapterError,
  processError,
  type spawnProvider,
} from "./provider-process";

type Transport = ReturnType<typeof spawnProvider>;
export type AppServerFrame = Pick<RawProviderFrame, "line" | "base64Fragment">;
type Projection = Effect.Effect<void>;

const frameCapacity = 64;
const byteCapacity = 32 * 1024 * 1024;

export const appServerWire = Effect.fn("app-server.wire")(function* (
  transport: Transport,
  scope: Scope.Scope,
) {
  const queue = yield* Queue.dropping<
    { work: Projection; bytes: number },
    AdapterError | Done
  >(frameCapacity);
  const stopped = yield* Deferred.make<never, AdapterError>();
  let bytes = 0;
  let failure: AdapterError | undefined;

  function offer(work: Projection, size = 0) {
    if (
      failure ||
      bytes + size > byteCapacity ||
      !Queue.offerUnsafe(queue, { work, bytes: size })
    )
      return false;
    bytes += size;
    return true;
  }

  const stop = Effect.fn("app-server.stop-reader")(function* (
    error: AdapterError,
  ) {
    if (failure) return;
    failure = error;
    yield* Deferred.fail(stopped, error);
    yield* transport.failPending(error);
  });

  const read = Effect.fn("app-server.read")(function* (
    receive: (
      frame: AppServerFrame,
    ) => Effect.Effect<
      { work: Projection; acknowledge: Effect.Effect<unknown> } | undefined
    >,
  ) {
    yield* Effect.forkIn(
      Stream.fromAsyncIterable(transport.frames(), (cause) =>
        cause instanceof AdapterError
          ? cause
          : processError(
              "read-failed",
              "Could not read app-server output",
              cause,
            ),
      ).pipe(
        Stream.runForEach(
          Effect.fn("app-server.read-frame")(function* (frame) {
            if (failure) return yield* failure;
            const packet = yield* receive(frame);
            if (!packet) return;
            if (!offer(packet.work, Buffer.byteLength(frame.line, "utf8")))
              return yield* processError(
                "output-overflow",
                "Codex app-server exceeded the stdout read-ahead limit",
              );
            yield* packet.acknowledge;
          }),
        ),
        Effect.matchEffect({
          onSuccess: () =>
            stop(
              processError("channel-ended", "Codex app-server output ended"),
            ).pipe(Effect.andThen(Queue.end(queue))),
          onFailure: (error) =>
            stop(error).pipe(Effect.andThen(Queue.fail(queue, error))),
        }),
        Effect.ignoreCause,
      ),
      scope,
    );
  });

  return {
    read,
    offer,
    stop,
    error: () => failure,
    stopped: Deferred.await(stopped),
    projections: Stream.fromEffectRepeat(
      Queue.take(queue).pipe(
        Effect.map((packet) => {
          bytes -= packet.bytes;
          return packet.work;
        }),
      ),
    ),
  };
});
