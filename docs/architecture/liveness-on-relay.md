# Liveness on the relay

Convex owns session status and the liveness lease. The relay carries short-lived observations of machine contact. A fresh observation can add a recent-contact indicator to a live row. The durable lease determines whether the row is live or disconnected.

## Server lease

With `INBOX_LIVENESS_LEASES=1`, routine heartbeats update `session_heartbeats`. This table also holds the write fence that rejects delayed status writes. The single status writer updates `managed_sessions` on a lease transition or an actual status change.

A scheduled check reads the latest heartbeat. If it is fresh, the check schedules the next check without a write to the inbox read set. If it is stale, the writer records expiry at 120 seconds after the last heartbeat. Scheduler delay can delay delivery of the transition. Each activation gets a new generation so a check from an earlier activation cannot renew it.

The inbox sends `LIVE_INBOX_LEASE_END` (`Number.MAX_SAFE_INTEGER`) in `liveness_lease_end` for a live lease. For an expired lease, it sends the expiry time. Clients fall back to `last_heartbeat` if the lease field is absent. The inbox gains independence from routine heartbeat writes. A separate [bounded liveness scan](https://github.com/littlebirdai/swarm/pull/129) exceeded its read budget, so it is outside this change.

## Recovery before flag enablement

The personal and team inbox hooks use `useRecoveryPoll` with `INBOX_RECOVERY_STALE_MS` set to 15 seconds. A quiet subscription can pass that threshold while it is healthy. The polls then cause fresh list or liveness reads. These reads include `querySplitWhole` calls. [Personal inbox hook](../../apps/web/hooks/useSyncInboxSessions.ts) · [Team inbox hook](../../apps/web/hooks/useSyncTeamInboxSessions.ts) · [Recovery controller](../../apps/web/hooks/useRecoveryPoll.ts).

Replace the time-since-last-payload test with recovery on disconnect, resume, or error. Wait until Convex is reachable. Delay the read by a random 0–15 seconds to spread requests when many clients recover together. Share a cap of one recovery read per 15 seconds per sync host across personal and team views. Combine triggers and cancel queued reads when the active scope changes. A quiet healthy subscription needs zero recovery reads.

At cold boot, detect a cached live marker directly in `liveness_lease_end`. The marker has no usable clock deadline. A cache timestamp tells when the facts were current but cannot validate the marker now. Validate it once on boot through the same rate limit. Apply the check to both personal and team inbox rows. Resume and Convex reconnect must also validate the affected scopes.

Show **Unknown** if the only evidence of liveness is a cached marker or facts from an earlier run. Keep **Unknown** until the read succeeds. Keep an explicit stop visible.

The current personal hold probes `sessionsLiveness`. Use the team liveness query until both scopes can use the new authorized inbox facts snapshot. After the overlay drops lease and status reads, use that snapshot for the probe and apply it through the durable feed. Release the hold only after fresh facts for the affected scope arrive. [Personal inbox hold and probe](../../apps/web/hooks/useSyncInboxSessions.ts).

## Machine contact

The Edge handshake negotiates relay support. Issue a signed grant only to the machine with the current fenced run. The run comes from `conversation_execution_heads.current_epoch`. The server uses `ownedRun()` to check ownership and the ready binding, then checks the run lease and its fence. An unfenced or hosted session uses Convex lease and status only. [Edge routes](../../apps/server/convex/lib/edge/routes.ts) · [Run ownership and lease](../../apps/server/convex/lib/edge/runLease.ts).

Limit each machine grant to `session_liveness` for its authorized session and run. Cap the grant lifetime at the run lease deadline.

Return the public relay WebSocket URL with the grant from server deployment configuration. Advertise support only when the server has a valid `wss:` URL and can sign a grant. The machine uses that URL to connect to `/relay`. Deploy the relay parser before machines use run-scoped grants. [Relay service](../../apps/relay/README.md) · [Grant contract](../../packages/relay-contract/src/authorization.ts).

The machine publisher uses an Effect runtime in `packages/edge-client`. Its relay handshake offers only `capabilities: ["session_liveness"]`, which excludes fan-out of viewer presence, cursors, and baton signals. Publish after the relay accepts the hub subscription and publish again after reconnect.

The current `@codecast/relay-client` offers a fixed capability list. It lacks a readiness hook and a queue for `session_liveness` before the subscription is ready. Add capability selection and readiness if the publisher reuses that client. `machine_liveness` is deferred. [Relay client](../../packages/relay-client/src/index.ts) · [Relay fan-out](../../packages/relay/src/connection.ts).

The relay stores signals in memory. A new subscriber needs a fresh signal. The default lifetime is 15 seconds, and grant deadlines can shorten it. Publish often enough to refresh the signal before it expires. `HEARTBEAT_FLUSH_INTERVAL_MS` is 30 seconds, so the Convex heartbeat cannot provide that cadence. [Relay defaults](../../apps/relay/src/config.ts) · [Heartbeat constants](../../packages/sessions/src/agentStatus.ts).

The web presence provider mounts in every window. Run inbox-wide subscriptions on the sync host only. Start with up to 64 visible, eligible session hubs and leave room for ordinary presence.

The relay permits 256 hubs per connection, 16 grants per token, and by default 8 connections per subject. The viewer grant endpoint permits 120 mints per minute. Batch grants, budget refresh and reconnect requests with ordinary presence, and keep the combined load well below those limits. [Provider mount](../../apps/web/src/providers.tsx) · [Grant limits](../../packages/relay-contract/src/authorization.ts) · [Viewer grant rate](../../apps/server/convex/relayGrants.ts) · [Connection limits](../../apps/relay/src/config.ts).

The viewer accepts an observation only for the current run and expected machine. It removes the observation on a run change, signal expiry, or socket close. While the durable lease is live, show **Live** whether the relay is up or down. Show **Disconnected** at the durable expiry time. A relay observation cannot revive an expired lease or change status or placement. [Observation lifetime](../../packages/relay-client/src/observations.ts) · [Shared inbox projection](../../packages/inbox/src/inboxProjection.ts).

## Inbox contract and field ownership

Add the current run epoch to the inbox row, snapshot, log payload, and overlay contract. Associate each fenced lease with that epoch. Use the same transaction that changes run ownership to invalidate the prior lease and publish the new epoch. A delayed heartbeat or expiry check for the old epoch cannot change the new lease. Clear the old relay observation at the same boundary. The new run starts with unknown liveness until the writer accepts its first valid heartbeat.

`managed_sessions` has no access key and does not publish to `sync_actions`. The status writer publishes lease and status transitions as facts on the linked `conversations` entity, in the same transaction as the durable write. Personal delivery uses the owner and explicit session owners' user scopes.

Today, conversation changes do not fan out to team scopes. Add team inbox delivery only for facts that all readers of that scope can see under the conversation visibility rules. Use authorized user scopes where access differs by viewer. Apply the same visibility and redaction rules to the snapshot and log.

Publish removals when a viewer loses access. Team routing alone does not grant access. [Conversation scope and range rules](../../apps/server/convex/syncLog.ts) · [Sync log access rules](./sync-log-cargo.md).

Use a bounded snapshot of authorized session IDs. Apply log changes after its read position. The personal and team overlays own the fields listed in `INBOX_FACT_FIELDS` today. During comparison, read the new feed into a temporary copy for comparison only. Keep one writer per field in the session store.

At cutover, establish the new snapshot position, move the relevant fields to the durable feed, and make the overlay appliers leave those fields alone. Keep child rollups and other overlay fields until their replacements supply equivalent facts. [Inbox field ownership](../../packages/inbox/src/inboxFields.ts).

Keep `InboxProjection.set_digest` and `useInboxDigestCompare` on the same facts and projection time. Move the server digest to the durable facts snapshot or its companion response when the overlay drops lease and status reads. Pair the digest with the snapshot position.

The comparer waits for that position, then uses the server's projection time. Point mismatch recovery to the authorized snapshot. Relay observations stay outside the digest. Keep the base list for membership and order until the later inbox snapshot and log change. [Digest comparison](../../apps/web/hooks/useInboxDigestCompare.ts) · [Sync convergence](./sync-convergence.md).

## Measurement and rollout

Use the [socket and server baseline](./sync-measurements.md#socket-baseline). Match active sessions, batch size, sync hosts, scopes, and duration before and after the change. Include personal and team views. Count routine heartbeat batches in a window without status transitions.

| Measure per routine heartbeat batch | Method                                                                                                                                                                | Acceptance with lease writes enabled                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inbox query executions              | Use Convex usage for the personal and team list and liveness queries. Report explicit CLI reads separately.                                                           | Zero executions caused by routine heartbeats or renewals. Quiet healthy subscriptions cause zero recovery reads.                                       |
| Inbox payload bytes                 | Use `scripts/perf/ws-bytes.mjs` for Convex. Extend `scripts/perf/ws-frame-meter.mjs` or pair it with a relay meter. The current frame meter ignores `/relay` sockets. | Zero Convex inbox bytes due to routine heartbeats or renewals. Compare combined Convex and relay bytes with the baseline before relay display rollout. |
| Client IndexedDB writes             | Count committed inbox row puts and deletes at `writePatchesToIDB` in the collection writer. Let the write queue drain before the count ends.                          | Zero inbox cache writes due to routine heartbeats or renewals.                                                                                         |

Report relay observations and bytes separately as well as in the combined count. Sample lease transitions, grant refresh, and recovery separately. Record server time, database reads, and IndexedDB writes for those samples.

The read-set test proves that routine writes miss inbox documents. Use the socket meter for payload bytes. The save-to-screen probe measures a docs mutation. Use a session status mutation for a session latency probe. [IndexedDB write hook](../../apps/web/store/persistence/collection-writer.ts) · [Save-to-screen probe](../../apps/web/scripts/sync-probe.ts).

Keep `INBOX_LIVENESS_LEASES` off by default. With the flag off, Convex keeps the heartbeat timestamps that old web and mobile clients require. Old daemons use the same heartbeat requests with the flag on. Enable it only after recovery passes and client version data shows that all active web and mobile clients understand leases. Turn it off if an older client must connect again. Use a separate flag for relay display.

## Tests and PR order

1. Ship the server lease and lease-aware readers with the flag off. Keep tests for both flag modes, expiry after the last beat, the stale status fence, and disjoint inbox reads and writes.
2. Remove periodic polls for quiet subscriptions in both scopes. Check that a healthy subscription causes zero recovery reads. Use a fake clock and random source to check the delay and rate cap. Test cached boot, resume, reconnect, and failed reads in both scopes. Verify the lease flag against the socket baseline before enablement.
3. Add the Edge capability and machine grants. Test wrong owners, unfenced and hosted sessions, stale epochs and fences, and grant expiry. Check that the relay drops signals outside the grant.
4. Add the inbox epoch contract, authorized snapshot, and log delivery through the single status writer. Compare personal and team access, placements, digests, and leases across run changes. Switch the field owners and probe together after the feeds agree.
5. Add the machine publisher and viewer display behind the relay flag. Use relay client tests for late join, socket failure, and reconnect. Put the prior-run rejection test in the viewer liveness mount, where the viewer knows the current run. Compare the Convex writes with the relay up and down. Confirm that relay contact cannot revive an expired lease. Measure bytes and writes before enablement.
6. Replace the base inbox subscription with its snapshot and log after relay liveness works.

Use the [relay clock tests](../../packages/relay/test/relay.test.ts), [relay client recovery tests](../../packages/relay-client/test/client-recovery.test.ts), and [inbox projection tests](../../apps/server/convex/conversations.projection.test.ts).
