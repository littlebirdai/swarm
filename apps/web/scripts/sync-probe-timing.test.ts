import { expect, test } from "bun:test";
import { summarizeSyncProbe, timeSyncProbe } from "./sync-probe-timing";

test("measures each step and computes total percentiles per sample", async () => {
  let now = 0;
  const timer = { now: () => now, after: () => () => {} };
  const samples = [];
  for (const [save, drain] of [
    [100, 1],
    [1, 100],
    [1, 1],
  ]) {
    samples.push(
      await timeSyncProbe(
        async (start) => {
          start("save");
          now += save;
          start("drainAndHeadBump");
          now += drain;
          start("getHeads");
          now += 2;
          start("getRange");
          now += 3;
          start("apply");
          now += 4;
        },
        500,
        timer,
      ),
    );
  }
  expect(summarizeSyncProbe(samples)).toEqual({
    save: { p50: 1, p95: 100 },
    drainAndHeadBump: { p50: 1, p95: 100 },
    getHeads: { p50: 2, p95: 2 },
    getRange: { p50: 3, p95: 3 },
    apply: { p50: 4, p95: 4 },
    total: { p50: 110, p95: 110 },
  });
});

test("names the active step when getRange stalls", async () => {
  const deadlines = new Map<() => void, number>();
  let now = 0;
  const timer = {
    now: () => now,
    after(ms: number, callback: () => void) {
      deadlines.set(callback, now + ms);
      return () => {
        deadlines.delete(callback);
      };
    },
  };
  const result = timeSyncProbe(
    async (start) => {
      start("save");
      start("drainAndHeadBump");
      start("getHeads");
      now = 25;
      start("getRange");
      await new Promise(() => {});
    },
    50,
    timer,
  );
  now = 75;
  for (const [callback, deadline] of deadlines) {
    if (deadline <= now) callback();
  }
  await expect(result).rejects.toThrow(
    "Sync probe stalled at getRange after 50 ms",
  );
  expect(deadlines.size).toBe(0);
});
