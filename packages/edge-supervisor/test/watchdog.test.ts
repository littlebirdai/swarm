import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import { adjust } from "effect/testing/TestClock";
import { mainLoopHold, Watchdog } from "../src/effect";

it.effect("records an injected main-loop hold at p50 and p99", () =>
  Effect.gen(function* () {
    let hold = 0;
    const now = Effect.map(
      Clock.monotonicTimeNanos,
      (ns) => Number(ns) / 1e6 + hold,
    );
    yield* Effect.gen(function* () {
      const watchdog = yield* Watchdog;
      yield* Effect.forkScoped(watchdog.run, { startImmediately: true });
      hold = 175;
      yield* adjust(100);
      const sample = yield* Metric.value(mainLoopHold);
      expect(sample.count).toBe(1);
      expect(sample.quantiles).toEqual([
        [0.5, 175],
        [0.99, 175],
      ]);
    }).pipe(Effect.provide(Watchdog.layer(now)));
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
);
