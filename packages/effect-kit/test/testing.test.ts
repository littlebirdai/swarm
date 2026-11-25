import { expect } from "bun:test";
import { currentTimeMillis } from "effect/Clock";
import { forkChild, gen, sleep } from "effect/Effect";
import { join } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import { it } from "@codecast/effect-kit/effect/testing";

it.effect(
  "advances an hour of sleep using the TestClock",
  () =>
    gen(function* () {
      const start = yield* currentTimeMillis;
      expect(start).toBe(0);
      const fiber = yield* forkChild(sleep("1 hour"));
      yield* adjust("1 hour");
      yield* join(fiber);
      expect(yield* currentTimeMillis).toBe(start + 3_600_000);
    }),
  1_000,
);
