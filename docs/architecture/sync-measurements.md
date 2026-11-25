# Sync measurements

## Save to screen

Run the probe from the repository root.

```sh
bun apps/web/scripts/sync-probe.ts --samples 30 --timeout-ms 5000
```

The probe creates a personal document in a fresh in-process Convex database. It checks that a second viewer cannot read the document or its log. It loads the client store once, then edits the title for each sample. It deletes the document through the application mutation after the last sample or on error.

The output gives p50 and p95 in milliseconds. Each sample starts before the save mutation and ends when the expected title and cursor reach the headless store. The total percentiles come from complete samples.

| Step               | Measured work                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `save`             | The edit mutation commits the document and outbox slot together.                                                    |
| `drainAndHeadBump` | The scheduler runs the drain. The log entry and head commit together. The probe observes delivery with a 1 ms poll. |
| `getHeads`         | The owner reads the new head.                                                                                       |
| `getRange`         | The client requests the authorized log page with cargo.                                                             |
| `apply`            | The sync client applies the log page and publishes the store update.                                                |

The timeout applies to each step. A stall exits with the step name. The command accepts only local probe options. The measurements include the local scheduler and test backend. They exclude network latency, live subscription delivery, the client debounce, and browser paint.

## Alarm definitions

Print the HogQL queries and thresholds without creating watches.

```sh
bun scripts/perf/sync-alarms.ts
```

| Alarm                      | Window and unit                                                                               | Alert above |
| -------------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| Inbox digest mismatch rate | Confirmed mismatches divided by completed checks in the last hour                             | 1%          |
| Inbox self-heal spend      | Completed overlay probes plus completed by-ID requests per replica heartbeat in the last hour | 1 request   |
| Forced scope resyncs       | Scope resets after a retention gap or expired legacy cursor in the last hour                  | 5 resets    |
| Oldest pending outbox age  | Maximum age reported by `syncOutbox.status` in the last 5 minutes                             | 120,000 ms  |

The inbox digest heartbeat covers the personal projection. A heartbeat represents roughly one active replica hour. The self-heal figure counts completed requests and excludes failed requests. The outbox sample uses the same pending-slot timestamp as `syncOutbox.status`. An edit that coalesces into a slot updates that timestamp.

After a deployment, pass each definition to the existing watch command with its matching PostHog source. The queries aggregate matching events in that source.

```sh
cast metrics add "$name" --source "$source" --hogql "$query" --above "$threshold" --every "$interval"
```

Use a 15 minute interval for the client alarms and a 1 minute interval for the outbox alarm. Each watch needs telemetry from its source. If the source has no recent samples, the query returns no value.

## Socket baseline

Use a Chrome DevTools Protocol port for the tab that owns sync. Record the commit, environment, workload, and sample duration. Use the same conditions for each comparison. Reconnect to recover query names without releasing the tab's sync-host lock.

```sh
node scripts/perf/ws-bytes.mjs --port "$cdp_port" --url "$tab_url" \
  --seconds 60 --reconnect 1 --json 1 --top 10 --read-sets read-sets.json > socket-baseline.json
```

Make `read-sets.json` from the query handlers and the functions they call at the measured commit. Use full function paths as keys and table names or table-and-index names as values. Include conditional reads. For example, the authorized sync queries use these tables.

```json
{
  "syncLog:getHeads": ["sync_heads", "team_memberships"],
  "syncLog:getRange": [
    "sync_actions",
    "sync_heads",
    "sync_outbox",
    "team_memberships"
  ]
}
```

The report shows decoded inbound payload bytes and query updates. It ranks queries by attributed UTF-8 bytes. The top queries include their supplied read sets. A `null` read set means the inventory needs that query. Convex socket frames do not carry database read sets or server execution time. Use Convex usage data from the same window for server time, database bandwidth, and function calls.
