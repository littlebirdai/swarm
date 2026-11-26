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
   commit counts. In the earlier seven-day replay of 2,002 events, the timed
   cache held 2,000 rows and a fresh pass held 2,001. A late check made the old
   merge relevant again after the timer removed it.
   [boot-loader.ts:145](../../apps/web/store/persistence/boot-loader.ts#L145),
   [cacheRetention.ts:314](../../apps/web/store/cacheRetention.ts#L314),
   [cacheRetention.ts:344](../../apps/web/store/cacheRetention.ts#L344),
   [cacheRetention.ts:369](../../apps/web/store/cacheRetention.ts#L369),
   [useActivityItems.ts:119](../../apps/web/components/activity/useActivityItems.ts#L119).
2. **An open document can lose its body.** The boot rule keeps 200 recent
   document details at most, plus explicit pins and optimistic IDs. The detail
   hook records a recency stamp. It does not pin the row while the reader is
   mounted. Document details also use `syncRecord`, outside the
   `syncTable` cap for the keys in `DETAIL_ROW_CAPS`.
   [cacheRetention.ts:123](../../apps/web/store/cacheRetention.ts#L123),
   [useSyncDocs.ts:324](../../apps/web/hooks/useSyncDocs.ts#L324),
   [detailRows.ts:57](../../apps/web/lib/detailRows.ts#L57),
   [inboxStore.ts:17423](../../apps/web/store/inboxStore.ts#L17423),
   [inboxStore.ts:17770](../../apps/web/store/inboxStore.ts#L17770).
3. **A host removal has no cause on the wire.** The host sends the same row
   patches to persistence and replication. Followers receive a single
   `removes` list. The follower protects pinned details even if the removal
   came from the server. On disk, the existing detail eviction helper adds its
   IDs to the same ledger that authorizes snapshot drops.
   [sync-replication.ts:617](../../apps/web/store/sync-replication.ts#L617),
   [sync-replication.ts:524](../../apps/web/store/sync-replication.ts#L524),
   [inboxStore.ts:13343](../../apps/web/store/inboxStore.ts#L13343),
   [idb-collection-diff.ts:65](../../apps/web/store/idb-collection-diff.ts#L65).
4. **Followers add their own rows.** Followers skip global feeds but run
   per-view queries. A follower can add a document body or scoped Git events
   the host never holds. A host-only sweep leaves those rows in the follower.
   [sync-host.md:25](sync-host.md#L25),
   [useSyncDocs.ts:324](../../apps/web/hooks/useSyncDocs.ts#L324),
   [useSyncExternalEvents.ts:39](../../apps/web/hooks/useSyncExternalEvents.ts#L39),
   [clientSyncRegistry.ts:1603](../../apps/web/store/clientSyncRegistry.ts#L1603).

## Which rows stay resident

- **Pin active readers.** Use the reference-counted detail pins for an open
  document. Acquire a pin before the view relies on the cache. Release it
  when the view changes ID or unmounts. Clear pins on account change.
  Keep the focused session, the authoritative inbox set, explicit pins, and
  rows with pending writes, including optimistic rows and their dependent
  detail. Count pins separately from the cap on inactive rows. Reopen an
  evicted detail through its existing query and retain it while the view is
  open. A server deletion or access revocation invalidates an open row even
  while a cache pin protects it from eviction.
  [detailRows.ts:68](../../apps/web/lib/detailRows.ts#L68),
  [useSyncDocs.ts:346](../../apps/web/hooks/useSyncDocs.ts#L346).
- **Give Activity an authoritative outcome feed.** Compute the pull request
  state, session ties, and session commit counts from server history. Use the
  same access checks and scope as the current views. Send projections for
  the sessions and pull requests in the requested view. A late check then
  returns the correct merge state with its outcome. The client reads each
  outcome from the projection and uses the event rows for history.
  [activityModel.ts:138](../../apps/web/components/activity/activityModel.ts#L138),
  [activityModel.ts:235](../../apps/web/components/activity/activityModel.ts#L235),
  [externalEvents.ts:264](../../apps/server/convex/externalEvents.ts#L264).
- **Bound raw history by a stable order.** Use an immutable server timestamp
  and row ID as the tie breaker for the recent range. A new event can move an
  older event out of that range. It cannot make the older row a prerequisite
  for an outcome. Pin the bounded page an open history view needs and fetch
  older pages by cursor. Confirm that repository summaries and plan, project,
  and task views can fetch their own rows before that collection enters the
  timed sweep. A sparse delta only adds or updates rows. Advance a history
  page boundary from a complete page response.
  [cacheRetention.ts:216](../../apps/web/store/cacheRetention.ts#L216),
  [clientSyncRegistry.ts:1597](../../apps/web/store/clientSyncRegistry.ts#L1597).

## Eviction and deletion

Use explicit transaction metadata for a cache eviction. Include the collection
key, row ID, and the observed row version. Use a local generation if the row
has no server version. Check the version, pins, and pending writes again
before removal. Keep the metadata scoped to the operation and keep it out
of cached rows, sync cursors, and pending excludes.

A memory eviction removes the row from one window. Filter that patch before
the replication tee and IDB write-through. Send no `removes` entry for it.
Keep authoritative removals on the existing wire path. Mark a detail
query's explicit deletion or access revocation as authoritative even if
the reader has already evicted the row. Clear it from memory and disk
despite a cache pin. Move existing detail evictions to the cache-only
path before dropping the follower's pin check for authoritative removals.
Keep the pending-write reconciliation rules. An omitted row in a capped
host snapshot is a cache miss.
Only a complete authoritative feed for the relevant scope can use absence
as a removal signal.
[sync-host.md:46](sync-host.md#L46),
[idb-collection-diff.ts:48](../../apps/web/store/idb-collection-diff.ts#L48).

Add disk reclamation separately. The elected host can remove a persisted
cache payload after it rechecks the version and protection in the write
transaction. Use explicit cache authorization for this transaction and bypass
the authoritative snapshot-drop ledger. Keep the disk shadow in sync with
successful writes. Use compact row versions or fingerprints for that shadow
on capped collections so it does not keep the evicted payloads in memory.
Reject delayed work after a host or account change. Keep the operation
idempotent and let a fresh feed or open view restore the row. Before disk
reclamation ships, protect a document that an active follower has open with
a renewable pin that expires if the window disappears.
[collection-writer.ts:68](../../apps/web/store/persistence/collection-writer.ts#L68),
[sync-host.md:157](sync-host.md#L157).

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
[storage-transport.ts:137](../../apps/web/store/storage-transport.ts#L137),
[sync-host.md:74](sync-host.md#L74),
[sync-host.md:186](sync-host.md#L186),
[sync-host.md:217](sync-host.md#L217).

## Measurement

Run a seven-day replay without reloads for flag-off and flag-on windows.
Include a host, two followers with different open views, and a host
promotion. Include document prefetch and reopen, out-of-order Git events,
and an optimistic write during a sweep. Compare rendered Activity outcomes
against a fresh full-history reference after each batch. Include the original
2,002-event case and a server removal while a document is open.

Record row counts and estimated bytes per affected collection per window.
Record peak and settled memory, including the disk shadow, and persistent
row counts and bytes separately. Sample throughout the run so the final
count cannot hide growth. Compare the inactive working set with the cap and
report the pinned excess separately. Record cache misses, refetches and
bytes sent so the sweep does not trade memory for repeated reads.
[client-resource-report.ts:43](../../apps/web/lib/telemetry/client-resource-report.ts#L43).

Measure p50, p95, and maximum active CPU time per sweep and per batch.
Measure wall time separately, including time between batches. Use a
low-priority job after the existing input-quiet interval. Recheck input
before each batch and defer it if keys resume. Run the typing guard with
the sweep due during a typing burst. Keep the existing budget of one React
commit per keystroke, zero store writes, zero DOM tree changes, and zero
layout reads. Record long tasks and key-to-paint latency with both flag
settings on the same workload.
[inputQuiet.ts:23](../../apps/web/lib/inputQuiet.ts#L23),
[CLAUDE.md:319](../../CLAUDE.md#L319).

## PR order

Each PR ships alone with its own flag off by default. Enable a later flag
only when its dependencies are available. Keep the boot policy as the
fallback for keys whose live caps are off.

1. Add eviction metadata and filter cache removals from the persistence and
   replication paths. Test authoritative invalidation of a pinned or evicted
   detail. Enable these semantics only for hosts and followers that support
   them. Keep snapshot gap recovery and leave the timer off.
2. Add document pins and enable memory caps for document details in each
   window behind a separate flag. Cover rapid navigation and open documents
   during host promotion.
3. Add the Activity outcome feed and compare its results with the current
   projection in replay. Add the view queries needed for older history.
   Leave timed Git event eviction off.
4. Enable the timed sweep for eligible collections one at a time. Require
   per-window caps, outcome parity, and a passing typing guard.
5. Add host-only disk reclamation. Require version checks, protection for
   active readers, and tests for promotion, account changes, and reopening
   reclaimed rows.
