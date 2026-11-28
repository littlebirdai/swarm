import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { adjust } from "effect/testing/TestClock";
import { makeHandlerPool } from "../src/handler-pool";

it.effect(
  "the handler pool refuses work over its limit and ends a handler at its time limit",
  () =>
    Effect.gen(function* () {
      const pool = makeHandlerPool({
        maxConcurrent: 1,
        handlerTimeoutMs: 1_000,
      });
      const events: string[] = [];
      const never = yield* Deferred.make<void>();
      const record = (event: string) => Effect.sync(() => events.push(event));

      yield* pool.dispatch(
        Deferred.await(never).pipe(
          Effect.onInterrupt(() => record("first ended")),
        ),
        record("first refused"),
      );
      yield* pool.dispatch(record("second ran"), record("second refused"));
      yield* Effect.yieldNow;
      expect(events).toEqual(["second refused"]);

      yield* adjust(1_000);
      expect(events).toEqual(["second refused", "first ended"]);

      yield* pool.dispatch(record("third ran"), record("third refused"));
      yield* Effect.yieldNow;
      expect(events).toEqual(["second refused", "first ended", "third ran"]);
    }),
);
