import { expect, test } from "bun:test";
import { watchProblem } from "../../packages/ingest/src/ingest";
import { nextMonitorState } from "../../packages/ingest/src/metricMonitor";
import { syncAlarms } from "./sync-alarms";

test.each([
  ["digestMismatchRate", 0.01, 0.0101],
  ["selfHealSpend", 1, 1.1],
  ["forcedResyncs", 5, 6],
  ["oldestPendingAge", 120_000, 120_001],
] as const)(
  "%s alerts above its limit and recovers at the limit",
  (key, at, above) => {
    const alarm = syncAlarms[key];
    expect(
      watchProblem("posthog", "hogql", alarm.query, alarm.threshold),
    ).toBeNull();
    expect(nextMonitorState("ok", [at], alarm)).toBe("ok");
    expect(nextMonitorState("ok", [above], alarm)).toBe("alert");
    expect(nextMonitorState("alert", [at], alarm)).toBe("ok");
  },
);
