import { expect, test } from "bun:test";
import { watchProblem } from "../../packages/ingest/src/ingest";
import { parseDuration } from "../../packages/time/src/index";
import { nextMonitorState } from "../../packages/ingest/src/metricMonitor";
import { syncAlarms } from "./sync-alarms";

test.each([
  ["digestMismatchRate", 0.01, 0.0101, 900_000],
  ["selfHealSpend", 1, 1.1, 900_000],
  ["forcedResyncs", 5, 6, 900_000],
  ["oldestPendingAge", 120_000, 120_001, 60_000],
] as const)(
  "%s alerts above its limit and recovers at the limit",
  (key, at, above, interval) => {
    const alarm = syncAlarms[key];
    expect(parseDuration(alarm.every)).toBe(interval);
    expect(alarm.no_data_after).toBe(3);
    expect(
      watchProblem("posthog", "hogql", alarm.query, alarm.threshold),
    ).toBeNull();
    expect(nextMonitorState("ok", [at], alarm)).toBe("ok");
    expect(nextMonitorState("ok", [above], alarm)).toBe("alert");
    expect(nextMonitorState("alert", [at], alarm)).toBe("ok");
  },
);
