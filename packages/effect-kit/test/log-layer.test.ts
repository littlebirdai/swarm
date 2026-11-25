import { expect, spyOn, test } from "bun:test";
import { fail } from "effect/Cause";
import {
  annotateLogs,
  currentSpan,
  gen,
  logError,
  logInfo,
  logWithLevel,
  provide,
  provideService,
  runPromise,
  runSync,
  withLogSpan,
  withSpan,
} from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { adjust } from "effect/testing/TestClock";
import { NativeSpan } from "effect/Tracer";
import { logLayer } from "@codecast/effect-kit/effect";
import { it } from "@codecast/effect-kit/effect/testing";

test("forwards each log severity to the caller's logger", async () => {
  const entries: Array<[string, string]> = [];
  await runPromise(
    gen(function* () {
      for (const level of [
        "Trace",
        "Debug",
        "Info",
        "Warn",
        "Error",
        "Fatal",
      ] as const) {
        yield* logWithLevel(level)(level);
      }
    }).pipe(
      provideService(MinimumLogLevel, "Trace"),
      provide(logLayer((message, level) => entries.push([message, level]))),
    ),
  );
  expect(entries).toEqual([
    ["Trace", "debug"],
    ["Debug", "debug"],
    ["Info", "info"],
    ["Warn", "warn"],
    ["Error", "error"],
    ["Fatal", "error"],
  ]);
});

it.effect(
  "preserves payload parts, cause, annotations, log spans, and trace events",
  () =>
    gen(function* () {
      const entries: string[] = [];
      const span = yield* gen(function* () {
        yield* adjust("25 millis");
        yield* logInfo(["one", "two"]);
        yield* logError(
          "retry",
          { attempt: 3 },
          fail(new Error("remote offline")),
        );
        return yield* currentSpan;
      }).pipe(
        annotateLogs("task", "delivery"),
        withLogSpan("flush"),
        withSpan("delivery.send"),
        provide(logLayer((message) => entries.push(message))),
      );

      expect(entries[0]).toBe(
        "[ 'one', 'two' ] annotations={ task: 'delivery' } spans={ flush: 25 }",
      );
      expect(entries[1]?.split("\n")[0]).toBe(
        "retry { attempt: 3 } annotations={ task: 'delivery' } spans={ flush: 25 }",
      );
      expect(entries[1]).toContain("Error: remote offline");
      expect(span).toBeInstanceOf(NativeSpan);
      expect((span as NativeSpan).events).toHaveLength(2);
      expect((span as NativeSpan).events[1]?.[2]).toMatchObject({
        task: "delivery",
        "effect.logLevel": "ERROR",
      });
    }),
);

test("a throwing and re-entrant callback preserves trace events and reports once", async () => {
  const report = spyOn(process.stderr, "write").mockReturnValue(true);
  const callbacks: Array<[string, number]> = [];
  let span: NativeSpan | undefined;
  let nestedSpan: NativeSpan | undefined;
  const logger = logLayer((message) => {
    callbacks.push([message, span?.events.length ?? 0]);
    if (message === "outer") {
      nestedSpan = runSync(
        gen(function* () {
          yield* logInfo("re-entrant");
          return (yield* currentSpan) as NativeSpan;
        }).pipe(withSpan("delivery.log.nested"), provide(logger)),
      );
      throw new Error("log sink unavailable");
    }
  });
  try {
    await runPromise(
      gen(function* () {
        const active = yield* currentSpan;
        expect(active).toBeInstanceOf(NativeSpan);
        span = active as NativeSpan;
        yield* logInfo("outer");
        yield* logInfo("later");
      }).pipe(withSpan("delivery.log"), provide(logger)),
    );
    expect(callbacks).toEqual([
      ["outer", 1],
      ["later", 2],
    ]);
    expect(span?.events.map(([name]) => name)).toEqual(["outer", "later"]);
    expect(nestedSpan?.events.map(([name]) => name)).toEqual(["re-entrant"]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain("log sink unavailable");
  } finally {
    report.mockRestore();
  }
});
