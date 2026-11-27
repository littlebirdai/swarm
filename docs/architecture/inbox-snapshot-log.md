# Inbox snapshot and log

[Sync convergence](./sync-convergence.md#c1-facts-and-channels) defines the row and fact writers. Its [working-set rules](./sync-convergence.md#c4-the-working-set) define admission, caps, and fold. The change below replaces the live list transport. It keeps these projection rules.

## Snapshot and replay

The sync host reads an authorized snapshot. The reply gives the viewer’s scope and the log position read in the same Convex transaction. The host merges the rows through the existing inbox applier. A replica can display its cache while the snapshot loads. The snapshot covers the window. The existing completeness crawl supplies older bodies after a cold boot or retention gap.

Keep one ordered cursor per scope. Wait for the debounced replay cursor to reach the snapshot position. If the cursor has already passed it, request a new snapshot to avoid overwriting newer rows. Reuse the pending-write filters when a snapshot or replay reaches the store. The snapshot never moves the cursor. Replay can then apply all actions past the cursor, including writes committed during bootstrap. The server withholds the checkpoint while the scope has pending outbox slots. The host retries after backoff. This keeps a write from entering the replica through the snapshot and then again when the outbox publishes it.

## Changes and coverage

Personal replay uses the authorized conversation entries for creation, status, rename, placement, and deletion. Existing cargo updates held rows. An entry without complete cargo uses the authorized by-ID path. Removing a co-owner logs a revocation in their personal scope. The replica checks current ownership through the authorized by-ID query. If the claim is gone, it clears the personal claim and keeps the cached row for team views. A row can also leave a bounded window while the viewer still owns it.

The current log omits updates that contain only stream fields, including previews. It also does not carry every joined field or window replacement. Before foreground rollout, publish or derive those inputs and prove parity for capped windows, plan handoffs, children, and owner changes. Team rows need a separate access and redaction contract. The ordinary inbox feeds cover these cases today.

## Digest and recovery

Keep the current overlay and digest during the first slice. The final feed carries an independent server digest at a log position and projection epoch. The replica compares at that position, with the same version, epoch, facts, and truncation. If replay has passed that position, wait for a newer digest. A mismatch requests a bounded repair and a new authorized checkpoint. A digest derived from the replica's own rows cannot serve as the server reference.

On reconnect, continue from the last cursor. If retention passed it, use the existing scope reset and completeness crawl. Cancel any in-flight snapshot and start a replacement for the new cursor generation. It retries failed reads, adds jitter to reconnect reads, and drops results after identity loss. Followers get the existing replicated session rows and view state. Only the host opens feeds. A new host checks its cursor and takes a snapshot if it has no valid checkpoint.

## First slice

Set `VITE_INBOX_LOG_SNAPSHOT=1` in a local web development build to replace the personal base list with one positioned snapshot and existing replay. Keep the liveness overlay, digest, and team feeds. Keep the list feeder in production and in windows that do not mount the full sync core. This slice measures transport and server work. It does not establish parity for fields that the log omits.

Run the same saves against both paths. Count Convex query payload bytes and server execution time after bootstrap. Include the shared log work in both totals. Report local fixture measurements separately from deployed socket and server measurements. Retain the cutover only if both costs fall.

### Local result

The [local probe](../../apps/web/scripts/inbox-log-probe.ts) uses the in-process Convex fixture and the client log applier.

```sh
bun apps/web/scripts/inbox-log-probe.ts subscription
bun apps/web/scripts/inbox-log-probe.ts snapshot
```

The fixture holds 24 recent personal sessions. It samples 30 title changes after one warm-up. Both arms include the liveness overlay, heads, and range. The probe omits duplicate subscription replies from the byte count.

| Total per run              | Live list | Snapshot and log |
| -------------------------- | --------: | ---------------: |
| Query executions           |       120 |               90 |
| Convex JSON response bytes | 2,522,208 |           14,217 |
| In-process query wall time | 127.52 ms |         70.50 ms |

The table gives the median of three runs per arm. It excludes bootstrap, socket framing, and network time. The probe verifies that every edited title reaches the client store. This fixture covers renames. Use the [socket and server baseline](./sync-measurements.md#socket-baseline) with more workloads before any rollout.
