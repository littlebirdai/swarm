import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

const intervalMs = 100;

export const mainLoopHold = Metric.summary("daemon_main_loop_hold_ms", {
  maxAge: "1 minute",
  maxSize: 600,
  quantiles: [0.5, 0.99],
});

export class Watchdog extends Context.Service<
  Watchdog,
  { run: Effect.Effect<never> }
>()("@codecast/edge-supervisor/Watchdog") {
  static layer(
    now = Effect.map(Clock.monotonicTimeNanos, (ns) => Number(ns) / 1e6),
  ) {
    const sample = Effect.fn("Watchdog.sample")(function* () {
      const before = yield* now;
      yield* Effect.sleep(intervalMs);
      const after = yield* now;
      yield* Metric.update(
        mainLoopHold,
        Math.max(0, after - before - intervalMs),
      );
    });
    return Layer.effect(
      Watchdog,
      Effect.sync(() => Watchdog.of({ run: Effect.forever(sample()) })),
    );
  }
}
