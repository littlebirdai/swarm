import { expect, test } from "bun:test";
import { keepStartingFencedRuntime } from "./start-fenced-runtime.js";

test("a fenced runtime start that fails at boot is logged and retried until it succeeds", async () => {
  const logs: string[] = [];
  let attempts = 0;
  const runtime = {
    async start() {
      attempts += 1;
      if (attempts < 3) throw new Error(`backend unavailable ${attempts}`);
    },
  };
  await keepStartingFencedRuntime(runtime, (line) => logs.push(line), {
    initialDelayMs: 1,
    maxDelayMs: 2,
  });
  expect(attempts).toBe(3);
  expect(logs).toEqual([
    "[fenced-execution] start failed: backend unavailable 1 -- retrying in 1ms",
    "[fenced-execution] start failed: backend unavailable 2 -- retrying in 2ms",
  ]);
});
