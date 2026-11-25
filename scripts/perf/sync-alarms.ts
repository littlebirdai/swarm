const minute = 60_000;

export const syncAlarms = {
  digestMismatchRate: {
    name: "Inbox digest mismatch rate",
    query: `SELECT sum(toFloat(properties.mismatches)) / nullIf(sum(toFloat(properties.checks)), 0)
FROM events WHERE event = 'inbox_digest_heartbeat' AND timestamp >= now() - INTERVAL 1 HOUR
HAVING count() > 0`,
    threshold: 0.01,
    direction: "above",
    interval_ms: 15 * minute,
  },
  selfHealSpend: {
    name: "Inbox self-heal requests per active replica hour",
    query: `SELECT avg(toFloat(properties.heals) + toFloat(properties.heals_missing))
FROM events WHERE event = 'inbox_digest_heartbeat' AND timestamp >= now() - INTERVAL 1 HOUR
HAVING count() > 0`,
    threshold: 1,
    direction: "above",
    interval_ms: 15 * minute,
  },
  forcedResyncs: {
    name: "Forced scope resyncs per hour",
    query: `SELECT sumIf(coalesce(toFloat(properties.count), 0), event = 'synclog_resync')
FROM events WHERE event IN ('synclog_resync', 'synclog_apply') AND timestamp >= now() - INTERVAL 1 HOUR
HAVING count() > 0`,
    threshold: 5,
    direction: "above",
    interval_ms: 15 * minute,
  },
  oldestPendingAge: {
    name: "Oldest pending outbox age in ms",
    query: `SELECT max(toFloat(properties.oldest_age_ms))
FROM events WHERE event = 'sync_outbox_status' AND timestamp >= now() - INTERVAL 5 MINUTE
HAVING count() > 0`,
    threshold: 2 * minute,
    direction: "above",
    interval_ms: minute,
  },
} as const;

if (import.meta.main) console.log(JSON.stringify(syncAlarms, null, 2));
