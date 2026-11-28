import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export type HandlerLimits = {
  readonly maxConcurrent?: number;
  readonly handlerTimeoutMs?: number;
};

export const DEFAULT_MAX_CONCURRENT_HANDLERS = 64;
export const DEFAULT_HANDLER_TIMEOUT_MS = 120_000;

export type HandlerPool = {
  dispatch(
    handler: Effect.Effect<void>,
    refuse: Effect.Effect<void>,
  ): Effect.Effect<void>;
};

export function makeHandlerPool(limits: HandlerLimits = {}): HandlerPool {
  const semaphore = Semaphore.makeUnsafe(
    limits.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_HANDLERS,
  );
  const timeoutMs = limits.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  return {
    dispatch: (handler, refuse) =>
      Effect.gen(function* () {
        const acquired = yield* Semaphore.takeIfAvailable(semaphore, 1);
        if (!acquired) {
          yield* Effect.forkChild(refuse);
          return;
        }
        yield* Effect.forkChild(
          handler.pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () => Effect.void,
            }),
            Effect.ensuring(Semaphore.release(semaphore, 1)),
          ),
          { startImmediately: true },
        );
      }),
  };
}
