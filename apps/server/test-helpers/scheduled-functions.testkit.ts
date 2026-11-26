import { afterEach, beforeEach, expect, jest } from "bun:test";
import type { ServerTest } from "./database.testkit";

type Backend = Pick<ServerTest, "run" | "finishInProgressScheduledFunctions">;

export function isolateScheduledFunctions() {
  const backends = new Set<Backend>();
  beforeEach(() => jest.useFakeTimers());
  afterEach(async () => {
    try {
      for (const backend of backends) {
        await backend.finishInProgressScheduledFunctions();
        const active = await backend.run(async (ctx) => {
          const jobs = await ctx.db.system
            .query("_scheduled_functions")
            .collect();
          for (const job of jobs)
            if (job.state.kind === "pending")
              await ctx.scheduler.cancel(job._id);
          return (await ctx.db.system.query("_scheduled_functions").collect())
            .filter(
              (job) =>
                job.state.kind === "pending" || job.state.kind === "inProgress",
            )
            .map((job) => job.name);
        });
        expect(active).toEqual([]);
      }
    } finally {
      backends.clear();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
  return <T extends Backend>(backend: T): T => {
    backends.add(backend);
    return backend;
  };
}
