# Liveness on the relay

Convex owns session liveness. The relay carries short-lived observations of contact with a machine. Clients can display fresh contact as soon as the relay delivers it. The Convex lease remains the record of whether the session is live or disconnected.

## Current code

| Part                                                                         | Current behavior                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Relay contract](../../packages/relay-contract/src/frames.ts)                | `presence` reports a person in a session. `session_liveness` reports machine contact for one run. `machine_liveness` reports contact for one machine.                                               |
| [Relay service](../../apps/relay/README.md)                                  | The service accepts WebSockets at `/relay`. It verifies signed grants. It holds hub and connection state in memory.                                                                                 |
| [Relay fan-out](../../packages/relay/src/connection.ts)                      | The relay checks the hub grant before it sends a signal. It stamps the signal with a connection ID and sequence number. A session liveness signal carries the identity of the machine that sent it. |
| [Relay client](../../packages/relay-client/src/observations.ts)              | The client ignores an older sequence number on the same connection, hub, and signal type. It removes observations at expiry or when the connection closes.                                          |
| [Web presence client](../../apps/web/components/relay-presence-provider.tsx) | The provider uses `VITE_RELAY_PRESENCE=1` and `VITE_RELAY_URL`. It pauses when the page is hidden or offline. It scopes the socket to the signed-in account.                                        |
| [Convex grants](../../apps/server/convex/relayGrants.ts)                     | `relayGrants.mint` issues user grants for session hubs. It gives those users permission to publish `presence`. Grants last up to 60 seconds.                                                        |

The relay uses a default signal lifetime of 15 seconds. The source and recipient grant deadlines can shorten that lifetime. The relay does not replay old signals to a new subscription. A reconnect needs a fresh observation. [Relay signal rules](../../packages/relay/src/signals.ts) · [Relay expiry tests](../../packages/relay/test/relay.test.ts).

The wire contract defines machine liveness signals. The current grant endpoint and web provider do not supply a machine publisher for inbox liveness. Edge `hello` negotiates a version and capabilities independently of the relay handshake. LIVE must connect these parts and check the current run before the client uses a signal. [Grant authorization](../../packages/relay-contract/src/authorization.ts) · [Edge routes](../../apps/server/convex/lib/edge/routes.ts).

### Lease branch

The lease branch replaces the proposed BOUND dependency for this work. [PR #129](https://github.com/littlebirdai/swarm/pull/129) closed after the read budget proved too high. The lease branch keeps the inbox independent of routine heartbeat writes when its flag is on. It makes no claim about the cost of the full inbox scan. [Lease branch read-set test](https://github.com/littlebirdai/swarm/blob/e22b60774e8dd7e6c9270d3a6351939d61dd5999/apps/server/convex/inbox-heartbeat-read-set.test.ts).

With the flag on, the status writer stores routine heartbeat timestamps and the status write fence in `session_heartbeats`. It writes live or expired transitions to `managed_sessions`.

A scheduled check reads the heartbeat row. If the heartbeat is still fresh, the check schedules another check without a write to the inbox read set. Otherwise, the check records expiry at 120 seconds after the last stored heartbeat. Scheduler delay can delay that record. [Status writer on the lease branch](https://github.com/littlebirdai/swarm/blob/e22b60774e8dd7e6c9270d3a6351939d61dd5999/apps/server/convex/lib/sessionStatusWriter.ts).

A live lease sends the stable `LIVE_INBOX_LEASE_END` marker in `liveness_lease_end`. An expired lease sends its expiry time. Clients can use `last_heartbeat` when the lease field is absent. [Shared projection on the lease branch](https://github.com/littlebirdai/swarm/blob/e22b60774e8dd7e6c9270d3a6351939d61dd5999/packages/inbox/src/inboxProjection.ts).

## Proposed data paths

| Writer               | What it writes                                                                                            | When                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine              | A heartbeat to Convex. It also publishes `session_liveness` for the granted session and run on the relay. | Keep the Convex heartbeat path. Send a fresh relay observation after subscribe or reconnect. Renew the observation before its lifetime ends.                        |
| Convex kernel        | The machine relay grant and its scope.                                                                    | Issue a short-lived grant after Edge `hello` confirms support. Check the machine and its current run when the kernel issues or renews the grant.                    |
| Convex status writer | The heartbeat fence, lease transitions, and real status changes.                                          | Update the side row on a heartbeat. Publish the durable lease or status fact only when it changes. Check expiry against the last stored heartbeat.                  |
| Relay                | In-memory copies of live signals for delivery to current subscribers.                                     | Validate the grant and fan out each accepted signal. Remove expired signals.                                                                                        |
| Viewer               | A temporary observation for the display of recent contact.                                                | Accept a fresh signal only for a known session, current run, and expected machine. Remove the observation when the run changes or the relay client emits a removal. |

The current grant names permissions for a hub. The signal carries the run number. Limit the proposed machine grant to the authorized hubs and signals. Check the run number again at the client.

A session liveness signal gives evidence of contact for the run that it names. Person presence reports a person. Baton heartbeats report contact from the baton holder. Relay signals have no effect on claims, delivery, status transitions, or the Convex lease.

Use the relay lifetime in the received frame to expire a display observation. Do not copy the Convex heartbeat interval to the relay publisher. The 30-second flush in the plan exceeds the relay’s default signal lifetime. Measure the proposed relay interval and the number of subscribed hubs before rollout. [Heartbeat constants](../../packages/sessions/src/agentStatus.ts) · [Relay defaults](../../apps/relay/src/config.ts).

## Client rules

The lease branch stores the lease on a managed session. The proposed snapshot and log must associate each lease with its current run. Clear the previous observation when that run changes.

| Convex lease                | Relay observation                     | What the client displays                                                                                        |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Live for the current run    | Fresh and valid for the same run      | Live, with recent contact as soon as the signal arrives.                                                        |
| Live for the current run    | Absent, expired, or relay unavailable | Live from Convex. Clear the recent-contact indication.                                                          |
| Expired for the current run | Any                                   | Disconnected once the client clock reaches the recorded expiry time. A late signal cannot restore a live lease. |
| Unknown for the current run | Any                                   | No confirmed liveness. Read the authorized lease facts before the client shows a verdict.                       |

Use the shared projection to derive status and placement from the lease and the other durable facts. An explicit stop still takes precedence. Relay loss does not make a session disconnected. A new client with a cached live marker needs a fresh lease read after reconnect or resume. [Shared live derivation](../../packages/inbox/src/inboxProjection.ts) · [Liveness hold in current code](../../apps/web/hooks/livenessHold.ts).

If the durable subscription also needs recovery, start one scoped Convex read after a random delay from 0 to 15 seconds. During the outage, use at most one such read per 15 seconds per sync host. Stop the poll when the durable subscription can supply current facts. These intervals come from the plan. The current relay provider does not implement this Convex poll. [Current inbox recovery](../../apps/web/hooks/useSyncInboxSessions.ts).

## Move the inbox off heartbeat reads

Use one authorized snapshot for the sessions that the client holds. After that snapshot, use the authorized change log for lease and status transitions. Add these facts to the log before the client relies on them. Use the relay subscription for display observations.

Cover the other registry facts before you remove the registry reads from the overlay. Examples include the change time of a status, turn completion, and open tasks. Keep the current child rollups and fast fields until their replacement supplies the same facts. Use a bounded batch of authorized session IDs in each recovery read.

Keep the inbox query for membership, order, and other row facts during this change. Remove the overlay’s lease and status reads after the new feed supplies equivalent facts. The base list and the liveness overlay use separate subscriptions today. The later INBOX change replaces the base subscription with a snapshot and the change log. [Inbox subscriptions](../../apps/web/hooks/useSyncInboxSessions.ts) · [Sync convergence](./sync-convergence.md).

Keep `INBOX_LIVENESS_LEASES` off by default. With the flag off, Convex keeps the legacy heartbeat writes for old web tabs and phone builds. Updated clients can read the lease field or fall back to `last_heartbeat`. Turn the flag on only when no client older than the lease-aware change is in use. If an older client needs access again, turn the server flag off.

Use a separate flag for relay display. [Flag and compatibility tests on the lease branch](https://github.com/littlebirdai/swarm/blob/e22b60774e8dd7e6c9270d3a6351939d61dd5999/apps/server/convex/inbox-heartbeat-read-set.test.ts).

## Measure the change

Use the stage-0 [socket and server baseline](./sync-measurements.md#socket-baseline). Record the same active sessions, batch size, sync hosts, scopes, and duration before and after the change. Include a personal view and a team view. Use a window with heartbeats and no status changes to isolate the cost.

- Count Convex executions of `listInboxSessions`, `listTeamInboxSessions`, `sessionsLiveness`, and `teamSessionsLiveness` per routine heartbeat batch. Count any other subscribed inbox queries that the probe finds. Report explicit CLI reads separately.
- Divide Convex inbox payload bytes by the number of routine heartbeat batches. Use `scripts/perf/ws-bytes.mjs` for bytes and Convex usage for executions. A query can execute without a new payload.
- Report relay payload bytes that clients receive over the same interval. Report the number of observations. Also report the sum of Convex inbox bytes and relay bytes per heartbeat batch.
- Record lease transition, grant refresh, and outage recovery costs in separate samples. Include server time, database reads, and IndexedDB writes.

The acceptance limit is zero inbox query executions and zero Convex inbox payload bytes caused by routine heartbeats or renewals with the lease flag on. Compare the combined payload cost against stage 0 before the relay display flag goes on. The in-process read-set test proves disjoint reads and writes. It does not measure live socket bytes. The save-to-screen probe measures write-to-store latency separately. [Stage-0 probe](../../apps/web/scripts/sync-probe.ts).

## Proof before rollout

- Keep the [lease read-set tests](https://github.com/littlebirdai/swarm/blob/e22b60774e8dd7e6c9270d3a6351939d61dd5999/apps/server/convex/inbox-heartbeat-read-set.test.ts). They cover both flag modes, a late heartbeat, the expiry transition, and the stale status fence.
- Extend the [relay clock tests](../../packages/relay/test/relay.test.ts). Use `TestClock` to check grant expiry, stale signals, bounded queues, and relay restart. Confirm that the relay drops signals that lack the required hub grant.
- Extend the [relay client tests](../../packages/relay-client/test/client-recovery.test.ts) and [presence mount tests](../../apps/web/components/relay-presence-provider.mount.test.tsx). Cover a late join, a prior-run signal, a socket failure, and a fresh signal after reconnect.
- Run the same heartbeat trace with the relay up and down. Both traces must write the same Convex status and lease facts. Check that a relay signal cannot revive an expired lease.
- Compare the old and new inbox projection for the same snapshot, status changes, and expiry. Check personal, team, and named reads. Keep the [inbox projection tests](../../apps/server/convex/conversations.projection.test.ts).
- Use a fake clock and random source for the outage poll. Prove the delay and rate cap. Capture the stage-0 comparison with the relay on and off.

## PR order

1. Merge the lease branch with its flag off. Keep the legacy timestamp for clients in use. Use this branch as the base for LIVE in place of BOUND.
2. Add the Edge capability and machine grants on top of RELAY and HELLO. Prove that the owner and run checks work before the machine can publish a signal.
3. Publish durable status and lease changes through the status writer and the authorized log. Add the scoped snapshot and recovery read. This part follows STATUS.
4. Connect the display to the relay behind its own flag. Compare the feed with the inbox overlay. Remove the overlay’s lease and status reads after the comparison passes.
5. Compare runs with stage 0. Enable each flag only after its own rollout checks pass. Do the INBOX snapshot and log change after LIVE.
