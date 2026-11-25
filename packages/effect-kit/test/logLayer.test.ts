import { expect, test } from "bun:test";
import {
  logFatal,
  logWarning,
  provide,
  runPromise,
  andThen,
} from "effect/Effect";
import { logLayer } from "@codecast/effect-kit/effect";

test("forwards Effect messages and severity to the caller's logger", async () => {
  const entries: Array<[string, string]> = [];
  await runPromise(
    provide(
      andThen(logWarning("retry", 3), logFatal("stopped")),
      logLayer((message, level) => entries.push([message, level])),
    ),
  );
  expect(entries).toEqual([
    ["retry 3", "warn"],
    ["stopped", "error"],
  ]);
});
