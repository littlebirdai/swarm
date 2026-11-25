import { afterEach, describe, expect } from "bun:test";
import { currentTimeMillis } from "effect/Clock";
import { addFinalizer, forkChild, gen, sleep, sync } from "effect/Effect";
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

describe("Effect test scope", () => {
  const events: string[] = [];

  afterEach(() => {
    expect(events).toEqual(["body", "finalized"]);
  });

  it.effect("runs scoped finalizers before the Bun test ends", () =>
    gen(function* () {
      yield* addFinalizer(() =>
        sync(() => {
          events.push("finalized");
        }),
      );
      events.push("body");
      expect(events).toEqual(["body"]);
    }),
  );
});
