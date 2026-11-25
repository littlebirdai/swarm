import type { ProviderEvent } from "@codecast/provider-contract";
import { fail, type Done, type Cause } from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { processError, type AdapterError } from "./provider-process";

export type Emit = (event: ProviderEvent) => void;

export const pendingPromptLimit = 32;
const bufferCapacity = 32;
export const makeProviderEvents = Effect.fn("provider.events")(function* (
  name: string,
) {
  const overflow = fail(
    processError("event-overflow", `${name} event buffer is full`),
  );
  const queue = yield* Queue.dropping<ProviderEvent, AdapterError | Done>(
    bufferCapacity + pendingPromptLimit + 8,
  );
  let readerClaimed = false;
  let ended = false;
  let opened = false;
  let overflowed = false;
  let space: Deferred.Deferred<void> | undefined;

  function wakeProducer() {
    if (space) Deferred.doneUnsafe(space, Effect.void);
  }

  const full = () =>
    opened && !ended && Queue.sizeUnsafe(queue) >= bufferCapacity;
  const awaitSpace = Effect.fn("provider.awaitEventSpace")(function* () {
    while (full()) {
      space = Deferred.makeUnsafe();
      yield* Deferred.await(space);
    }
  });

  function emit(event: ProviderEvent) {
    if (ended) return;
    if (
      (!opened && Queue.sizeUnsafe(queue) >= bufferCapacity) ||
      !Queue.offerUnsafe(queue, event)
    ) {
      overflowed = true;
      ended = true;
      Queue.failCauseUnsafe(queue, overflow);
      wakeProducer();
    }
  }

  const unsubscribe = Effect.sync(() => {
    ended = true;
    wakeProducer();
  }).pipe(
    Effect.andThen(Queue.end(queue)),
    Effect.andThen(Effect.ignoreCause(Queue.clear(queue))),
    Effect.asVoid,
  );

  return {
    emit,
    awaitSpace,
    full,
    open: () => {
      opened = true;
      return !overflowed;
    },
    end: Queue.end(queue),
    fail: (cause: Cause<AdapterError>) =>
      Effect.sync(() => {
        ended = true;
        Queue.failCauseUnsafe(queue, cause);
        wakeProducer();
      }),
    events: Stream.unwrap(
      Effect.gen(function* () {
        if (readerClaimed) return Stream.empty;
        readerClaimed = true;
        yield* Effect.addFinalizer(() => unsubscribe);
        return Stream.fromQueue(queue).pipe(
          Stream.tap(() => Effect.sync(wakeProducer)),
        );
      }),
    ),
    unsubscribe,
  };
});
