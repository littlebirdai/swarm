# Timed row caps

Cap the cache in each web and desktop window. Start with document details and
keep the current boot rules for Git events until Activity can fetch its outcomes
without their history. Treat a row's removal from a cache as a change to the
cache alone.

## Why boot retention cannot run on a timer

1. **Git event relevance changes.** The boot loader applies
   `COLLECTION_RETENTION` to persisted rows. The Git event rule keeps an old
   merge when a newer event makes its pull request or a linked session live.
   Activity reads those same rows to derive pull request state and session
   commit counts. The counterexample has 2,002 events. A pull request merge comes first,
   followed by 2,000 unrelated events and a later check for that pull request.
   The timer discards the old merge before the check arrives. After the check,
   the timed cache holds 2,000 rows, while boot retention over full history
   keeps 2,001 because the check makes the merge relevant again.
   `apps/web/store/persistence/boot-loader.ts:145`,
   `apps/web/store/cacheRetention.ts:314`,
   `apps/web/store/cacheRetention.ts:344`,
   `apps/web/store/cacheRetention.ts:369`,
   `apps/web/components/activity/useActivityItems.ts:119`.
2. **An open document can lose its body.** The boot rule keeps 200 recent
   document details at most, plus explicit pins and optimistic IDs. The detail
   hook records a recency stamp. It does not pin the row while the reader is
   mounted. Document details also use `syncRecord`, outside the
   `syncTable` cap for the keys in `DETAIL_ROW_CAPS`.
   `apps/web/store/cacheRetention.ts:123`,
   `apps/web/hooks/useSyncDocs.ts:324`,
   `apps/web/lib/detailRows.ts:57`,
   `apps/web/store/inboxStore.ts:17423`,
   `apps/web/store/inboxStore.ts:17770`.
3. **A host removal has no cause on the wire.** The host sends the same row
   patches to persistence and replication. Followers receive a single
   `removes` list. The follower protects pinned details even if the removal
   came from the server. On disk, the existing detail eviction helper adds its
   IDs to the same ledger that authorizes snapshot drops.
   `apps/web/store/sync-replication.ts:617`,
   `apps/web/store/sync-replication.ts:524`,
   `apps/web/store/inboxStore.ts:13343`,
   `apps/web/store/idb-collection-diff.ts:65`.
4. **Followers add their own rows.** Followers skip global feeds but run
   per-view queries. A follower can add a document body or scoped Git events
   the host never holds. A host-only sweep leaves those rows in the follower.
   `docs/architecture/sync-host.md:25`,
   `apps/web/hooks/useSyncDocs.ts:324`,
   `apps/web/hooks/useSyncExternalEvents.ts:39`,
   `apps/web/store/clientSyncRegistry.ts:1603`.

## Which rows stay resident

- **Pin active readers.** Use one reader hook to select, pin, and feed a
  document detail by ID. Call it from every mounted `docDetails` reader,
  including `DocDetailPage`, `StagePinTile`, `ScopeTabs`, `HostedMadeLine`,
  and `useDrafting`. `HostedMadeLine` currently reads the cache without a
  detail feeder. Mount the feeder there too when the document ID is valid.
  Acquire a reference-counted pin in the React commit phase. Release it on ID
  change or unmount. After the pin lands, recheck the store. If a sweep removed
  the row between render and commit, seed it from the latest authorized live
  query result. This check runs even if the result reference stays the same.
  The feeder effect in `useConvexSync` does not run again for that reference.
  A null result goes through authoritative invalidation. Call
  `resetDetailPins()` in `clearProtectedInboxMemory`. Scope the release and
  query result to the account so an old view cannot affect a new account.
  Keep the focused session, the authoritative inbox set, explicit pins, and
  rows with pending writes, including optimistic rows and their dependent
  detail. Count pins separately from the cap on inactive rows.
  `apps/web/app/docs/[id]/page.tsx:116`,
  `apps/web/components/calls/StagePinTile.tsx:241`,
  `apps/web/components/org/scope/ScopeTabs.tsx:860`,
  `apps/web/components/conversation/HostedMadeLine.tsx:34`,
  `apps/web/components/docs/drafting/useDrafting.ts:48`,
  `apps/web/lib/detailRows.ts:80`,
  `apps/web/lib/detailRows.ts:100`,
  `apps/web/hooks/useConvexSync.ts:54`,
  `apps/web/store/inboxStore.ts:22248`.
- **Give Activity an authoritative Git outcome feed.** Compute history-dependent
  pull request outcomes, session ties, and commit counts from server history.
  Git events leave `workspace` unset, and PR events can lack
  `conversation_id`. Keep Git events without a workspace key.

  Require an explicit scope. For `team:<id>`, require access to the named
  team and scan `by_team_source_created` with that routing ID and an unset
  `source_id`. This excludes ingestion rows. Use the index only to find
  candidates and filter for Git event kinds. Confirm the PR belongs to the
  named team on its own record. Confirm session scope with
  `workspaceForConversation`. Also consider direct Git events from readable
  sessions in that scope if those rows have no routing ID.

  For `user:<authenticated user ID>`, start from readable conversations whose
  canonical scope is that personal workspace. Read their direct Git events
  through `by_conversation_created`. Follow `pull_request_sessions.by_conversation`
  and read the history of those PRs through `by_pr_created`. A PR can
  contribute to a personal outcome only through an explicit link to one of
  those conversations. A personal request never falls back to an active team.
  A missing or unknown scope returns no rows.

  Check access to each event that contributes to an outcome, including the
  history that supports a late check. Resolve `pr_id` through `pull_requests`
  and use `canAccessPullRequest`. Resolve `conversation_id` and use
  `canAccessConversation`. Require both checks for an event with both links.
  Omit events with no readable source. Independently check each session tie
  with `canAccessConversation` before adding a session ID, label, or count
  to the projection. The event's routing `team_id` grants no access.
  `apps/server/convex/schema/events.tables.ts:83`,
  `apps/server/convex/schema/events.tables.ts:94`,
  `apps/server/convex/schema/pull-requests.tables.ts:185`,
  `apps/server/convex/externalEvents.ts:264`,
  `apps/server/convex/lib/access.ts:136`,
  `apps/server/convex/lib/access.ts:369`,
  `apps/server/convex/lib/access.ts:544`,
  `CLAUDE.md:169`.

  Register `activityGitOutcomes` in `CLIENT_SYNC_REGISTRY` with
  `DATA_SCOPE: workspace` and `REPLICATION_CLASSIFICATION: local`. Keep this
  collection in memory per window. Key rows by scope and outcome ID. Use a
  per-view feeder and read the result from the store through the workspace
  selector. Start with a cap of 500 inactive outcomes per window and protect
  the current page.
  Keep task and decision outcomes and the live `pr_status` overlay derived
  from current store rows. The Git feed supplies only history-dependent facts.
  `apps/web/store/clientSyncRegistry.ts:137`,
  `apps/web/store/clientSyncRegistry.scope.ts:7`,
  `apps/web/store/clientSyncRegistry.ts:2595`,
  `apps/web/components/activity/useActivityItems.ts:100`,
  `apps/web/components/activity/useActivityItems.ts:219`,
  `CLAUDE.md:284`.

- **Bound raw history by a stable order.** Use an immutable server timestamp
  and row ID as the tie breaker for the recent range. A new event can move an
  older event out of that range. It cannot make the older row a prerequisite
  for an outcome. Pin the bounded page an open history view needs and fetch
  older pages by cursor. Confirm that repository summaries and plan, project,
  and task views can fetch their own rows before that collection enters the
  timed sweep. A sparse delta only adds or updates rows. Advance a history
  page boundary from a complete page response.
  `apps/web/store/cacheRetention.ts:216`,
  `apps/web/store/clientSyncRegistry.ts:1597`.

## Eviction and deletion

Use explicit transaction metadata for a cache eviction. Include the collection
key, row ID, and the observed row version. Use a local generation if the row
has no server version. Check the version, pins, and pending writes again
before removal. Keep the metadata scoped to the operation and keep it out
of cached rows, sync cursors, and pending excludes.

### Memory eviction and replication

A memory eviction removes the row from one window. Filter its patch before
the replication tee and IndexedDB write-through. The host also removes those
IDs from its replication shadow in the same store commit. Copy the affected
shadow entries without changing the store objects they reference. Remove only
the evicted IDs, before any whole-collection diff for the same write. This
shadow change does not advance the sequence or broadcast an update. The next
whole-collection `syncTable` diff then has no stale ID to convert into an
authoritative removal. Keep the pending-write rules for all normal writes.
`platform/packages/engine/src/replicationRuntime.ts:96`,
`platform/packages/engine/src/replicationRuntime.ts:162`,
`platform/packages/engine/src/replication.ts:119`.

### Authoritative detail invalidation

`docDetails` has `localFirst: false`. `dropDocDetail` only deletes a resident
row. It creates no pending exclude, so `deleteAllowed` can refuse the IndexedDB
delete. An evicted row produces no memory patch at all. A follower's
`dropDocDetail` is a sync write, so that operation does not ask the host to
invalidate its copy.
`apps/web/store/clientSyncRegistry.ts:374`,
`apps/web/store/inboxStore.ts:17846`,
`apps/web/store/idb-collection-diff.ts:132`,
`apps/web/store/persistence/collection-writer.ts:106`,
`apps/web/hooks/useSyncDocs.ts:346`.

Authorize a disk delete with an explicit detail invalidation for the current
principal, document ID, and authoritative result. Accept a resolved detail
query that returns null, a confirmed `archiveDoc` success, or absence from
the complete workspace `docs` crawl. An optimistic archive can hide the
row before its response. If the server rejects it, retain the ordinary
rollback. In the complete crawl, include persisted detail IDs of the same
workspace even when their thin rows are absent from memory. Use the persisted
scope stamp or verify the document with the detail query if its scope is
unknown. Never authorize a delete from a partial crawl, loading state, or
absence from a capped replication snapshot.
`apps/web/hooks/useSyncDocs.ts:240`,
`apps/web/hooks/useSyncDocs.ts:262`,
`apps/web/store/inboxStore.ts:20789`.

Give the host a dedicated delete path that accepts those authorized IDs even
if neither the in-memory row nor a diff exists. Delete by ID in IndexedDB
and update the disk shadow after commit. Clear memory despite a cache pin.
Cancel queued stale writes for the ID and reject delayed older data from
hydration or the detail feeder. Respect pending creates and newer confirmed
restores. Keep this authorization separate from pending excludes, cache-only
reclamation, and the snapshot-drop ledger.

When a follower receives a resolved null for the current account and detail
request, it hides the body immediately. It also sends a dedicated
authoritative invalidation request with the ID, cause, and request ID to the
current host. Use the same request for a confirmed archive or complete
prune that a follower observes. The host checks for a current null detail,
confirmed archive, or absence from a complete crawl of the relevant workspace. It drops stale requests after an
account or host change. Apply once per request, delete from disk by ID, and broadcast the
authoritative removal even when the host held no copy. The follower can
reoffer the invalidation after promotion if it received no confirmation.

### Mixed builds

Replication partitions channels by principal and `CACHE_SCHEMA_VERSION`.
The messages carry no protocol version, so two app builds can share a channel.
Add a distinct `authoritativeRemoval` kind to `ReplicationUpdate`, with its
own IDs field. A supporting follower bypasses the cache pin only for that
kind. For legacy unmarked `removes`, keep the existing pin guard. Advertise
support in the follower's `hello` and the host's snapshot reply. Use the new
invalidation request and the new removal kind only in a compatible cohort.
If a peer lacks support or its capability is unknown, keep the new cap off
and retain the legacy wire behavior and detail query checks. Recheck peer
support when a window joins. Test both directions of mixed builds and
preserve snapshot sequence and gap recovery. During recovery, replay the
explicit invalidations that the follower missed. If the bounded invalidation
log cannot cover the gap, drop unverified `docDetails` rows from memory,
including pinned rows. Refill them from current authoritative query results.
This recovery drop grants no disk delete. A snapshot omission alone grants
no delete.
`apps/web/store/storage-transport.ts:15`,
`platform/packages/engine/src/replication.ts:19`,
`apps/web/store/sync-replication.ts:524`,
`apps/web/store/inboxStore.ts:13343`.

### Disk reclamation

Add disk reclamation separately. The elected host can remove a persisted
cache payload after it rechecks the version and protection in the write
transaction. Use explicit cache authorization for this transaction and bypass
the authoritative snapshot-drop ledger. Skip IDs with queued or in-flight
liveness writes. A queued liveness flush can put the row back within 60
seconds. For an authoritative invalidation, cancel any queued liveness put
and wait for an in-flight put before the delete. Use compact row versions or
fingerprints for the disk shadow so it does not keep the reclaimed payloads
in memory. For collections with `liveFields`, also keep a digest of the
non-liveness fields. Compare that digest to distinguish a liveness-only
update from a change that needs an immediate write. On host promotion,
refresh the shadow from IndexedDB before reclamation. A follower's `lastPersisted` only describes disk at boot.
Preserve disk rows that the promoted window evicted only from memory.

Reject delayed work after a host or account change. Keep reclamation
idempotent and let a fresh feed or open view restore the row. Before
reclamation ships, protect a document that an active follower has open with
a renewable pin that expires if the window disappears.
`apps/web/store/persistence/idb-liveness-lane.ts:164`,
`apps/web/store/persistence/idb-liveness-lane.ts:258`,
`apps/web/store/clientSyncRegistry.ts:2360`,
`apps/web/store/persistence/collection-writer.ts:68`,
`apps/web/store/sync-replication.ts:328`,
`docs/architecture/sync-host.md:157`.

## Per-window caps

Use the same admission and eviction rules in the host and every follower.
Apply them to rows from local view queries, replication updates, and snapshot
chunks. Run bounded batches on the timer, after hydration, and after a
snapshot settles. Limit the scan as well as the removals. Carry a cursor
between batches and yield between them.
Admit rows for active readers and authoritative live views first. Decline
optional rows outside the retained range so an unchanged feed cannot refill
the cache after every sweep. Apply the cap to unpinned rows. Track pin counts
and bytes so open views and pending writes can account for any excess.

Followers keep shared IDB state read-only. Host promotion can resume the
change feed at the replicated cursor. It must preserve disk rows that are
absent only because the promoted window evicted them. Keep the snapshot
sequence and gap recovery rules. In the sync simulation, check sequence
convergence and equal values for common resident rows. Permit different
resident sets only for capped keys. Check that an authoritative removal still
clears every window.
`apps/web/store/storage-transport.ts:137`,
`docs/architecture/sync-host.md:74`,
`docs/architecture/sync-host.md:186`,
`docs/architecture/sync-host.md:217`.

## Measurement

Run a seven-day replay without reloads for flag-off and flag-on windows.
Include a host, two followers with different open views, and a host
promotion. Include document prefetch and reopen, out-of-order Git events,
and an optimistic write during a sweep. Compare rendered Activity outcomes
against a fresh full-history reference after each batch. Replay an old merge,
2,000 newer unrelated events, and a late check for the same pull request. Also remove a document on the server while one
window has it open and the host has evicted it.

Record row counts and estimated bytes per affected collection per window.
Record peak and settled memory, including the disk shadow, and persistent
row counts and bytes separately. Sample throughout the run so the final
count cannot hide growth. Compare the inactive working set with the cap and
report the pinned excess separately. Record cache misses, refetches and
bytes sent so the sweep does not trade memory for repeated reads.
`apps/web/lib/telemetry/client-resource-report.ts:43`.

Measure p50, p95, and maximum active CPU time per sweep and per batch.
Measure wall time separately, including time between batches. Use a
low-priority job after the existing input-quiet interval. Recheck input
before each batch and defer it if keys resume. Run the typing guard with
the sweep due during a typing burst. Keep the existing budget of one React
commit per keystroke, zero store writes, zero DOM tree changes, and zero
layout reads. Record long tasks and key-to-paint latency with both flag
settings on the same workload.
`apps/web/lib/inputQuiet.ts:23`,
`CLAUDE.md:319`.

## PR order

Each PR ships alone with its own flag off by default. Enable a later flag
only when its dependencies are available. Keep the boot policy as the
fallback for keys whose live caps are off.

1. Add eviction metadata and filter cache removals from the persistence and
   replication paths. Test that an eviction followed by a whole-collection
   diff emits no removal for the evicted ID. Test a follower invalidation when the host has
   no memory patch, including access loss, archive, and complete crawl
   absence. Test mixed builds and pinned readers. Test a gap beyond the
   invalidation log and confirm that affected details leave memory. Leave the
   timer off.
2. Add document pins and enable memory caps for document details in each
   window behind a separate flag. Cover every reader, eviction between
   render and commit, an unchanged query result, rapid navigation, and
   account reset. Cover open documents
   during host promotion.
3. Add the Activity outcome feed and compare its results with the current
   projection in replay. Cover unstamped PR events with no conversation link,
   ingestion noise, private or revoked ties, scope switches, and a personal
   request without a team. Verify that a personal session can include history
   from a readable linked PR. A routing ID alone grants no access. Verify that
   task, decision, and live PR changes still paint from the store. Add the view
   queries for older history.
   Leave timed Git event eviction off.
4. Enable the timed sweep for eligible collections one at a time. Require
   per-window caps, outcome parity, and a passing typing guard.
5. Add host-only disk reclamation. Require version checks, protection for
   active readers, and tests for promotion with a stale disk shadow, queued
   liveness writes, account changes, and reopening reclaimed rows. Verify that
   the compact shadow still distinguishes an immediate write from a liveness
   update.
