import { test } from "bun:test";
import { provide, runPromise, scoped, type Effect } from "effect/Effect";
import type { Scope } from "effect/Scope";
import { layer, type TestClock } from "effect/testing/TestClock";

export const it = {
  effect<A, E>(
    name: string,
    body: () => Effect<A, E, Scope | TestClock>,
    timeout?: number,
  ): void {
    test(
      name,
      async () => {
        await runPromise(provide(scoped(body()), layer()));
      },
      timeout,
    );
  },
};
