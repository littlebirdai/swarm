import { timedDocCapsEnabled } from "../cache-eviction";
import {
  deferredCacheReadsEnabled,
  deferredSharedCacheSource,
  HYDRATION_EAGER_DEFERRED_KEYS,
  HYDRATION_ON_READ_KEYS,
} from "../deferred-cache-policy";
import { authPrincipal } from "../../lib/authPrincipal";
import {
  COLLECTION_RETENTION,
  MAX_CACHED_MY_SENDS,
  pendingDocDetailIds,
  partitionDocDetailRetention,
  expireExcludeTombstones,
  partitionSessionRetention,
} from "../cacheRetention";
import {
  REPLICATED_STORE_KEYS,
  collectionRowHydrator,
  collectionRowValidator,
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../clientSyncRegistry";
import { queuedMessagesFromPending } from "../pendingMessageJournal";
import {
  lastPersisted,
  noteConversationRetentionDrops,
} from "./collection-writer";
import { COLLECTION_TABLES, db } from "./db";
import { setHydrationReadPhase } from "./hydration";
import { ensureCacheOwnership as resolveOwnership } from "./ownership";
import { loadPendingInput } from "./pendingInputJournal";
import { purgeLocalCache } from "./purge";
import { deleteInBatches } from "./retention";
import { META_KEYS } from "./schema";
import { timeBootRead } from "./storage-timings";

// Old bundles can still write these values to the web meta table.
export const RETIRED_META_KEYS = [
  "messages",
  "pagination",
  "sidePanelOpen",
  "sidePanelUserClosed",
  "teamUnreadCount",
  "conversations",
];
let retiredMetaSwept = false;

function ensureCacheOwnership(): Promise<string | null> {
  return resolveOwnership(purgeLocalCache);
}

async function readRetainedMySends() {
  const table = COLLECTION_TABLES.mySends;
  const epoch = authPrincipal.epoch();
  return db.transaction("rw", table, async () => {
    const count = await table.count();
    if (
      count <= MAX_CACHED_MY_SENDS ||
      count !== (await table.orderBy("timestamp").count())
    )
      return table.toArray();
    const latest = await table
      .orderBy("timestamp")
      .reverse()
      .limit(MAX_CACHED_MY_SENDS)
      .toArray();
    const cutoff = latest.at(-1).timestamp;
    const newer = latest.filter((row) => row.timestamp > cutoff);
    const tied = await table.where("timestamp").equals(cutoff).toArray();
    const remaining = MAX_CACHED_MY_SENDS - newer.length;
    if (
      epoch === authPrincipal.epoch() &&
      deferredSharedCacheSource() === "disk"
    ) {
      await table.where("timestamp").below(cutoff).delete();
      if (remaining < tied.length)
        await table.bulkDelete(tied.slice(remaining).map((row) => row._id));
    }
    return [...newer, ...tied.slice(0, remaining)];
  });
}

export async function loadCache(
  keys?: readonly string[],
  context: Record<string, any> = {},
): Promise<Record<string, any> | null> {
  try {
    const phase =
      keys === HYDRATION_CRITICAL_READ_KEYS
        ? "critical"
        : keys === HYDRATION_DEFERRED_KEYS ||
            keys === HYDRATION_EAGER_DEFERRED_KEYS
          ? "deferred"
          : undefined;
    if (phase === "deferred") setHydrationReadPhase(phase);
    const wanted = keys ? new Set(keys) : null;
    const owner = await ensureCacheOwnership();
    if (owner === null) {
      // No collection row is served without a matching persisted user row.
      // Pending input is keyed by its owner, so the principal's own rows are
      // theirs whatever the rest of the disk holds; they are served even
      // before the user row commits (a read right after sign-in) so a typed
      // message is never withheld. Fail closed on whose rows: only the
      // stored token's principal, never a caller's claim about someone else.
      const principal = await authPrincipal.resolve();
      const wantsPending =
        !wanted ||
        wanted.has("pendingMessages") ||
        wanted.has("queuedMessages");
      const claimed = context.currentUser?._id;
      if (
        !principal ||
        !wantsPending ||
        (claimed !== undefined && claimed !== principal)
      )
        return null;
      const pendingMessages = await timeBootRead(phase, "pendingInput", () =>
        loadPendingInput(principal),
      );
      if (Object.keys(pendingMessages).length === 0) return null;
      return {
        pendingMessages,
        queuedMessages: queuedMessagesFromPending(pendingMessages),
      };
    }
    const epoch = authPrincipal.epoch();
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionEntries = Object.entries(COLLECTION_TABLES).filter(
      ([key]) => !wanted || wanted.has(key),
    );
    const metaKeys = (keys ?? [...META_KEYS]).filter((key) =>
      META_KEYS.has(key),
    );
    const onRead =
      deferredCacheReadsEnabled() &&
      keys?.length === 1 &&
      HYDRATION_ON_READ_KEYS.has(keys[0]);
    const shadowAtRead = onRead
      ? new Map(lastPersisted.get(keys[0]))
      : undefined;
    const [collectionResults, metaRows, pending, pendingArchives] = await Promise.all([
      Promise.all(
        collectionEntries.map(([key, table]) =>
          timeBootRead(phase, key, () =>
            key === "mySends" && deferredCacheReadsEnabled()
              ? readRetainedMySends()
              : table.toArray(),
          ),
        ),
      ),
      timeBootRead(phase, "meta", () =>
        db.meta.bulkGet(metaKeys.filter((key) => key !== "pending")),
      ),
      !wanted || wanted.has("pending")
        ? timeBootRead(phase, "meta", async () =>
            Object.fromEntries(
              (await db.pendingEntries.toArray()).map(({ key, value }) => [
                key,
                value,
              ]),
            ),
          )
        : undefined,
      timedDocCapsEnabled() && (!wanted || wanted.has("docDetails"))
        ? timeBootRead(phase, "archiveOutbox", async () => {
            const rows = await db.dispatchOutbox.toArray();
            const archives = new Set<string>();
            for (const entry of rows.sort((a, b) => a.ts - b.ts)) {
              if (entry.accountId !== undefined && entry.accountId !== owner)
                continue;
              const id = Array.isArray(entry.args) ? entry.args[0] : undefined;
              if (typeof id !== "string") continue;
              if (entry.action === "archiveDoc") archives.add(id);
              if (entry.action === "restoreArchivedDoc") archives.delete(id);
            }
            return archives;
          })
        : undefined,
    ]);
    if (
      epoch !== authPrincipal.epoch() ||
      (onRead &&
        REPLICATED_STORE_KEYS.includes(keys[0]) &&
        deferredSharedCacheSource() !== "disk")
    )
      return null;
    if (!retiredMetaSwept) {
      retiredMetaSwept = true;
      void db.meta.bulkDelete(RETIRED_META_KEYS).catch(() => {});
    }

    // Meta lookup first — the session and conversation retention pass needs
    // liveInboxIdList and lastFocusedConversationId from the same snapshot.
    const metaByKey: Record<string, any> = { ...context };
    if (pending && Object.keys(pending).length) {
      result.pending = pending;
      metaByKey.pending = pending;
      hasData = true;
    }
    for (const row of metaRows) {
      if (row) metaByKey[row.key] = row.value;
    }

    collectionEntries.forEach(([key, table], i) => {
      let rows = collectionResults[i];
      // Seed the persistence shadow with what's on disk (even an empty table) so
      // the first write after hydrate diffs against reality and can prune rows
      // the server has since deleted.
      const shadow = new Map<string, any>();
      const current = onRead ? lastPersisted.get(key) : undefined;
      const unchanged = (id: string) =>
        !onRead || current?.get(id) === shadowAtRead?.get(id);
      const validRow = collectionRowValidator(key);
      // Trim rows on the way in (see hydrateRow in the registry). Trimmed rows
      // are written straight back so disk shrinks with memory; the shadow then
      // holds the trimmed row (holding the on-disk original would pin the very
      // bytes we just dropped until the collection's next persist).
      const hydrateRow = collectionRowHydrator(key);
      const hydrateCtx = {
        pending: (metaByKey.pending as Record<string, any> | undefined) ?? {},
      };
      const trimmed: any[] = [];
      // Foreign documents persisted under the wrong collection (see validRow in
      // the registry) are excluded from hydration AND removed from disk, so the
      // cache self-heals instead of resurrecting phantoms on every load.
      const invalid: string[] = [];
      if ((key === "sessions" || key === "conversations") && rows.length > 0) {
        const { keep, drop } = partitionSessionRetention(
          rows,
          metaByKey.liveInboxIdList,
          metaByKey.lastFocusedConversationId,
          Date.now(),
        );
        rows = keep;
        if (drop.length) {
          if (key === "conversations") noteConversationRetentionDrops(drop);
          else table.bulkDelete(drop).catch(() => {});
        }
      }
      // Collections that bound themselves at boot (COLLECTION_RETENTION).
      const retain = COLLECTION_RETENTION[key];
      if (retain && rows.length > 0) {
        const memoryOnly = key === "docDetails" && timedDocCapsEnabled();
        const { keep, drop } = memoryOnly
          ? partitionDocDetailRetention(
              rows,
              Date.now(),
              pendingDocDetailIds(hydrateCtx.pending),
            )
          : retain(rows, Date.now());
        if (memoryOnly && drop.length) {
          const dropped = new Set(drop);
          for (const row of rows) {
            if (dropped.has(row._id))
              shadow.set(row._id, { _id: row._id, workspace: row.workspace });
          }
        } else if (drop.length) {
          void deleteInBatches(table, drop.filter(unchanged));
        }
        rows = keep;
      }
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) {
          if (validRow && !validRow(row)) {
            invalid.push(row._id);
            continue;
          }
          if (key === "docDetails" && pendingArchives?.has(row._id)) {
            shadow.set(row._id, { _id: row._id, workspace: row.workspace });
            continue;
          }
          const kept = hydrateRow ? hydrateRow(row, hydrateCtx) : row;
          if (kept !== row) trimmed.push(kept);
          map[row._id] = kept;
          shadow.set(row._id, kept);
        }
        if (Object.keys(map).length > 0) {
          result[key] = map;
          hasData = true;
        }
      } else if (key === "conversations" && collectionResults[i].length > 0) {
        result[key] = {};
        hasData = true;
      }
      if (invalid.length)
        table.bulkDelete(invalid.filter(unchanged)).catch(() => {});
      if (trimmed.length)
        table
          .bulkPut(trimmed.filter((row) => unchanged(row._id)))
          .catch(() => {});
      if (current) {
        for (const [id, row] of shadow)
          if (!current.has(id) && !shadowAtRead?.has(id)) current.set(id, row);
      } else {
        lastPersisted.set(key, shadow);
      }
    });

    for (const row of metaRows) {
      if (!row) continue;
      result[row.key] = row.value;
      hasData = true;
    }

    if (
      !wanted ||
      wanted.has("pendingMessages") ||
      wanted.has("queuedMessages")
    ) {
      const ownerId =
        context.currentUser?._id ??
        result.currentUser?._id ??
        (await db.meta.get("currentUser"))?.value?._id;
      if (ownerId) {
        result.pendingMessages = await timeBootRead(phase, "pendingInput", () =>
          loadPendingInput(ownerId),
        );
        result.queuedMessages = queuedMessagesFromPending(
          result.pendingMessages,
        );
        hasData = true;
      }
    }

    if (result.pending && typeof result.pending === "object") {
      result.pending = expireExcludeTombstones(result.pending, Date.now());
    }

    return hasData ? result : null;
  } catch {
    return null;
  }
}
