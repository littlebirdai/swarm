import { afterEach, beforeEach, expect, jest } from "bun:test";
import type { ServerTest } from "./database.testkit";

type Backend = Pick<ServerTest, "run" | "finishInProgressScheduledFunctions">;

async function cancelPendingJobs(backend: Backend) {
  return backend.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    const pending = jobs.filter((job) => job.state.kind === "pending");
    for (const job of pending) await ctx.scheduler.cancel(job._id);
    return {
      active: jobs
        .filter((job) => job.state.kind === "inProgress")
        .map((job) => job.name),
      failed: jobs
        .filter((job) => job.state.kind === "failed")
        .map((job) => job.name),
      cancelled:
        pending.length +
        jobs.filter((job) => job.state.kind === "canceled").length,
    };
  });
}

export async function drainScheduledFunctions(
  backends: ReadonlyMap<Backend, readonly string[]>,
) {
  const errors: unknown[] = [];
  let cancelled = 0;
  for (const [backend, expectedFailures] of backends) {
    try {
      await backend.finishInProgressScheduledFunctions();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        const jobs = await cancelPendingJobs(backend);
        cancelled += jobs.cancelled;
        expect(jobs.active).toEqual([]);
        expect(jobs.failed.sort()).toEqual([...expectedFailures].sort());
      } catch (error) {
        errors.push(error);
      }
    }
  }
  try {
    expect(jest.getTimerCount()).toBe(cancelled);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Scheduled function teardown failed");
}

export function isolateScheduledFunctions() {
  const backends = new Map<Backend, readonly string[]>();
  beforeEach(() => jest.useFakeTimers());
  afterEach(async () => {
    try {
      await drainScheduledFunctions(backends);
    } finally {
      backends.clear();
      jest.useRealTimers();
    }
  });
  return <T extends Backend>(
    backend: T,
    expectedFailures: readonly string[] = [],
  ): T => {
    backends.set(backend, expectedFailures);
    return backend;
  };
}
