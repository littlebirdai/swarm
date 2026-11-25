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

test("aborts a pending delivery wait when the drain stalls", async () => {
  let expire: () => void = () => {};
  let aborted: unknown;
  const result = timeSyncProbe(
    async (start, signal) => {
      start("save");
      start("drainAndHeadBump");
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = signal.reason;
            resolve();
          },
          { once: true },
        );
      });
    },
    10,
    {
      now: () => 0,
      after: (_, callback) => {
        expire = callback;
        return () => {};
      },
    },
  );
  expire();
  await expect(result).rejects.toThrow(
    "Sync probe stalled at drainAndHeadBump",
  );
  expect(aborted).toEqual(
    new Error("Sync probe stalled at drainAndHeadBump after 10 ms"),
  );
});

test("keeps the first apply boundary when later range pages arrive", async () => {
  let now = 0;
  const sample = await timeSyncProbe(
    async (start) => {
      start("save");
      start("drainAndHeadBump");
      start("getHeads");
      start("getRange");
      now = 5;
      start("apply");
      now = 10;
      start("apply");
      now = 15;
    },
    50,
    { now: () => now, after: () => () => {} },
  );
  expect(sample.getRange).toBe(5);
  expect(sample.apply).toBe(10);
});

test("the local report excludes its warm-up sample", () => {
  const run = Bun.spawnSync(
    [
      process.execPath,
      new URL("./sync-probe.ts", import.meta.url).pathname,
      "--samples",
      "2",
    ],
    { env: { ...process.env, DO_NOT_TRACK: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout.toString())).toMatchObject({
    samples: 2,
    durations: { total: { p50: expect.any(Number), p95: expect.any(Number) } },
  });
});
