import { METRIC_WATCH_LIMITS } from "../../packages/ingest/src/ingest";
import { monitorProblem } from "../../packages/ingest/src/metricMonitor";
import { parseDuration } from "../../packages/time/src/index";

const minute = 60_000;

export const syncAlarms = {
  digestMismatchRate: {
    name: "Inbox digest mismatch rate",
    query: `SELECT sum(toFloat(properties.mismatches)) / nullIf(sum(toFloat(properties.checks)), 0)
FROM events WHERE event = 'inbox_digest_heartbeat' AND timestamp >= now() - INTERVAL 1 HOUR
HAVING count() > 0`,
    threshold: 0.01,
    direction: "above",
    every: "15m",
    no_data_after: 3,
  },
  selfHealSpend: {
    name: "Inbox self-heal requests per active replica hour",
    query: `SELECT avg(toFloat(properties.heals) + toFloat(properties.heals_missing))
FROM events WHERE event = 'inbox_digest_heartbeat' AND timestamp >= now() - INTERVAL 1 HOUR
HAVING count() > 0`,
    threshold: 1,
    direction: "above",
    every: "15m",
    no_data_after: 3,
  },
  forcedResyncs: {
    name: "Forced scope resyncs per hour",
    query: `SELECT sumIf(coalesce(toFloat(properties.count), 0), event = 'synclog_resync')
FROM events WHERE event IN ('synclog_resync', 'synclog_apply') AND timestamp >= now() - INTERVAL 1 HOUR
HAVING count() > 0`,
    threshold: 5,
    direction: "above",
    every: "15m",
    no_data_after: 3,
  },
  oldestPendingAge: {
    name: "Oldest pending outbox age in ms",
    query: `SELECT max(toFloat(properties.oldest_age_ms))
FROM events WHERE event = 'sync_outbox_status' AND timestamp >= now() - INTERVAL 5 MINUTE
HAVING count() > 0`,
    threshold: 2 * minute,
    direction: "above",
    every: "1m",
    no_data_after: 3,
  },
} as const;

for (const alarm of Object.values(syncAlarms)) {
  const interval = parseDuration(alarm.every);
  const problem = monitorProblem(alarm);
  if (problem) throw new Error(`${alarm.name}: ${problem}`);
  if (
    interval < METRIC_WATCH_LIMITS.interval_min_ms ||
    interval > METRIC_WATCH_LIMITS.interval_max_ms
  )
    throw new Error(
      `${alarm.name}: the poll interval is outside the watch limits`,
    );
}

if (import.meta.main) console.log(JSON.stringify(syncAlarms, null, 2));
