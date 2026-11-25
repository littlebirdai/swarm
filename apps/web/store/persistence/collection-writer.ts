import type { Patch } from "mutative";
import { partitionSessionRetention } from "../cacheRetention";
import {
  createCoalescedWriter,
  deleteAllowed,
  diffCollection,
  diffPatchedRows,
  durableDeletes,
  hasSnapshotDrops,
  patchedIds,
} from "../idbCollectionDiff";
import {
  connectLivenessLane,
  flushLivenessWrites,
  holdLiveMeta,
  holdLivenessRows,
  holdLivenessSyncMeta,
  resetLivenessLane,
} from "./idb-liveness-lane";
import { COLLECTION_TABLES, db } from "./db";
import { persistenceOwned } from "./ownership";
import { deleteInBatches } from "./retention";
import { META_KEYS } from "./schema";
import { _hydrating } from "./hydration";
import { storageTimings } from "./storage-timings";

// What each collection table currently holds on disk, by id → row reference.
// Lets writePatchesToIDB persist only the rows that actually changed (and delete
// the ones that disappeared) instead of clearing + re-pouring the whole table.
// Seeded from loadCache so the first post-hydrate write diffs against disk, not
// an empty set (which would leave pruned rows stranded as ghosts).
export const lastPersisted = new Map<string, Map<string, any>>();

let conversationRetentionDrops = new Set<string>();

export function noteConversationRetentionDrops(ids: string[]) {
  for (const id of ids) conversationRetentionDrops.add(id);
}

// Test hook: the shadow lives at module scope and would otherwise leak across
// tests that reset the underlying storage out from under it.
export function _resetPersistedShadow() {
  lastPersisted.clear();
}

const metaWriter = createCoalescedWriter((key, value) => {
  db.meta.put({ key, value }).catch(() => {});
}, 250);
connectLivenessLane({
  db,
  tables: COLLECTION_TABLES,
  lastPersisted,
  writable: () => !_hydrating && persistenceOwned(),
  flushMeta: () => metaWriter.flush(),
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    metaWriter.flush();
    flushLivenessWrites();
  });
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    metaWriter.flush();
    flushLivenessWrites();
  });
}
export function writePatchesToIDB(patches: Patch[], state: any) {
  if (_hydrating || !persistenceOwned()) return;

  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  for (const key of affectedKeys) {
    if (key === "pendingMessages" || key === "queuedMessages") continue;
    const table = COLLECTION_TABLES[key];
    if (table) {
      const data = state[key];
      if (data && typeof data === "object") {
        const started = performance.now();
        const prevShadow = lastPersisted.get(key);
        const pending = state.pending || {};
        // NEVER wipe the cache from a store-shrink: durableDeletes keeps every
        // delete that nothing authorized (an exclude, a stub id, a snapshot
        // prune) on disk AND in the shadow, so a whole-collection wipe is
        // structurally impossible. The rule and its reasons live there.
        // The patches name the rows this write touched, so only those are compared: a write
        // of a few rows into a big collection costs the rows. A whole-collection replace,
        // or snapshot drops only a full diff can find, take the full diff.
        // A row whose change is only liveness fields waits for the liveness lane's flush.
        const ids = holdLivenessRows(
          key,
          prevShadow,
          prevShadow && !hasSnapshotDrops(key)
            ? patchedIds(patches, key)
            : null,
          data,
          state,
        );
        let puts: any[];
        let deletes: string[];
        if (prevShadow && ids) {
          ({ puts, deletes } = diffPatchedRows(prevShadow, data, ids, (id) =>
            deleteAllowed(key, id, pending),
          ));
        } else {
          const diff = diffCollection(prevShadow, data);
          puts = diff.puts;
          deletes = durableDeletes(
            key,
            diff.deletes,
            pending,
            prevShadow,
            diff.next,
          );
          lastPersisted.set(key, diff.next);
        }
        if (puts.length || deletes.length) {
          storageTimings.recordWrite(
            "collection_prepare",
            performance.now() - started,
          );
          // One transaction so a row is never momentarily absent: removed rows
          // and changed rows commit together, and unchanged rows are never
          // touched. Replaces the old clear()+bulkPut full-table rewrite.
          db.transaction("rw", table, async () => {
            if (deletes.length) await table.bulkDelete(deletes);
            if (puts.length) await table.bulkPut(puts);
          }).catch(() => {});
        }
        // Followers also hydrate. Leave disk retention to the next host write.
        if (key === "conversations" && conversationRetentionDrops.size) {
          const queued = conversationRetentionDrops;
          const candidates = [...queued];
          queued.clear();
          void deleteInBatches(
            {
              bulkDelete: (batch) =>
                db.transaction("rw", table, async () => {
                  if (
                    queued !== conversationRetentionDrops ||
                    !persistenceOwned()
                  )
                    return;
                  const shadow = lastPersisted.get(key);
                  const absent = batch.filter(
                    (id) => !(id in data) && !shadow?.has(id),
                  );
                  if (!absent.length) return;
                  const rows = (await table.bulkGet(absent)).filter(
                    (row) => row !== undefined,
                  );
                  // Include the held rows so the retention cap still applies to this batch.
                  const { drop } = partitionSessionRetention(
                    [...(shadow?.values() ?? []), ...rows],
                    state.liveInboxIdList,
                    state.lastFocusedConversationId,
                    Date.now(),
                  );
                  const dropped = new Set(drop);
                  const expired = rows
                    .filter((row) => dropped.has(row._id))
                    .map((row) => row._id);
                  if (expired.length) await table.bulkDelete(expired);
                }),
            },
            candidates,
          );
        }
      }
    } else if (key === "pending") {
      // The pending map goes to disk with the action that changed it, as its outbox row does: a lock that
      // waited for a quiet spell was lost with a page killed in between, and the reload showed a stale push
      // over its own parked write. (A big write plants a few hundred locks, never one per field it touches.)
      db.meta.put({ key, value: state[key] }).catch(() => {});
    } else if (key === "syncMeta") {
      holdLivenessSyncMeta(state);
    } else if (META_KEYS.has(key)) {
      if (holdLiveMeta(key, state)) continue;
      // Any other meta blob: its latest value once per quiet spell, never once per action. Page hide flushes it.
      metaWriter.write(key, state[key]);
    }
  }
}

/** Dexie writes only the diffed rows and lands them itself; nothing is held
 *  back. The native engine schedules whole-blob writes and drains them here. */
export async function flushPersistence(): Promise<void> {}

export function resetCollectionWrites() {
  // A meta value still waiting to be written belongs to the cache being purged.
  metaWriter.drop();
  resetLivenessLane();
  lastPersisted.clear();
  conversationRetentionDrops = new Set();
}
