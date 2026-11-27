import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  scheduledJobs,
  serverTest,
  type ServerTest,
} from "../test-helpers/database.testkit";
import { drainScheduledFunctions } from "../test-helpers/scheduled-functions.testkit";

const reclaim = internal.mainRed.reclaim;

function schedule(t: ServerTest, delay: number) {
  return t.run((ctx) =>
    ctx.scheduler.runAfter(delay, reclaim, {
      run: "invalid run" as Id<"main_ci_runs">,
      from: 1,
      attempt: 2,
      ok: false,
    }),
  );
}

async function scheduleFailure(t: ServerTest) {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await schedule(t, 0);
    jest.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    expect((await scheduledJobs(t))[0]?.state.kind).toBe("failed");
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("teardown reports an unexpected failed job", async () => {
  const t = serverTest();
  await scheduleFailure(t);
  const drain = drainScheduledFunctions(new Map([[t, []]]));
  await expect(drain).rejects.toBeInstanceOf(AggregateError);
  await expect(drain).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringContaining(getFunctionName(reclaim)),
      }),
    ],
  });
});

test("teardown accepts an explicitly expected failed job", async () => {
  const t = serverTest();
  await scheduleFailure(t);
  await expect(
    drainScheduledFunctions(new Map([[t, [getFunctionName(reclaim)]]])),
  ).resolves.toBeUndefined();
});

test("teardown reports an untracked timer even alongside a cancelled job", async () => {
  const t = serverTest();
  const job = await schedule(t, 60_000);
  await t.run((ctx) => ctx.scheduler.cancel(job));
  const timer = setTimeout(() => {}, 60_000);
  try {
    await expect(
      drainScheduledFunctions(new Map([[t, []]])),
    ).rejects.toMatchObject({
      errors: [expect.any(Error)],
    });
    expect(jest.getTimerCount()).toBe(2);
  } finally {
    clearTimeout(timer);
  }
});

test("teardown accounts for a scheduled timer cancelled before teardown", async () => {
  const t = serverTest();
  const job = await schedule(t, 60_000);
  await t.run((ctx) => ctx.scheduler.cancel(job));
  expect(jest.getTimerCount()).toBe(1);
  await expect(
    drainScheduledFunctions(new Map([[t, []]])),
  ).resolves.toBeUndefined();
});

test("teardown drains and cancels later backends after an earlier one throws", async () => {
  const first = serverTest();
  const later = serverTest();
  await schedule(first, 60_000);
  await schedule(later, 60_000);
  const error = new Error("first drain failed");
  const failing = {
    ...first,
    async finishInProgressScheduledFunctions() {
      throw error;
    },
  };
  const finishLater = spyOn(later, "finishInProgressScheduledFunctions");
  try {
    await expect(
      drainScheduledFunctions(
        new Map([
          [failing, []],
          [later, []],
        ]),
      ),
    ).rejects.toMatchObject({ errors: [error] });
    expect(finishLater).toHaveBeenCalledTimes(1);
    for (const t of [first, later]) {
      expect((await scheduledJobs(t)).map((job) => job.state.kind)).toEqual([
        "canceled",
      ]);
    }
  } finally {
    finishLater.mockRestore();
  }
});
