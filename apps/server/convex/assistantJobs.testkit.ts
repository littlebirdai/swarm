import type { convexTest } from "convex-test";
import type schema from "./schema";

const EXPECTED_JOBS = new Set([
  "agentTasks:generateDisplaySummary",
  "assistant/entry:wake",
  "assistant/turns:expire",
  "assistant/turns:run",
  "idleSummary:classifySettle",
  "idleSummary:generateIdleSummary",
  "messages:projectAgentStatusOnAddMessages",
  "notifications:checkNeedsInput",
  "syncOutbox:drain",
  "titleGeneration:generateTitle",

  "userSends:record",
]);

export function scheduledJobProblems(
  t: ReturnType<typeof convexTest<typeof schema>>,
) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter(
        (job) =>
          !EXPECTED_JOBS.has(job.name) ||
          !["success", "canceled"].includes(job.state.kind),
      )
      .map((job) => ({ name: job.name, state: job.state.kind })),
  );
}
