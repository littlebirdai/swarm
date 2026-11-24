import { authPrincipal } from "../../lib/authPrincipal";
import {
  COLLECTION_RETENTION,
  expireExcludeTombstones,
  partitionSessionRetention,
} from "../cacheRetention";
import {
  collectionRowHydrator,
  collectionRowValidator,
} from "../clientSyncRegistry";
import { queuedMessagesFromPending } from "../pendingMessageJournal";
import {
  lastPersisted,
  noteConversationRetentionDrops,
} from "./collectionWriter";
import { COLLECTION_TABLES, db } from "./db";
import { ensureCacheOwnership as resolveOwnership } from "./ownership";
import { loadPendingInput } from "./pendingInputJournal";
import { purgeLocalCache } from "./purge";
import { deleteInBatches } from "./retention";
import { META_KEYS } from "./schema";

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

// Native kv-store can read SQLite on this thread (getItemSync). Web IndexedDB
// cannot; kill-and-reopen on desktop still hydrates under the boot shell via
// the async path. Returning null here makes hydrateInboxCacheFromIDB await
// loadCache as it always has.
export function loadCacheSync(
  _keys?: readonly string[],
  _context?: Record<string, any>,
): Record<string, any> | null {
  return null;
}

export function loadPaintCacheSync(): Record<string, any> | null {
  return null;
}

export function ensureCacheOwnership(): Promise<string | null> {
  return resolveOwnership(purgeLocalCache);
}

export async function loadCache(
  keys?: readonly string[],
  context: Record<string, any> = {},
): Promise<Record<string, any> | null> {
  try {
    const wanted = keys ? new Set(keys) : null;
    if ((await ensureCacheOwnership()) === null) {
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
      const pendingMessages = await loadPendingInput(principal);
      if (Object.keys(pendingMessages).length === 0) return null;
      return {
        pendingMessages,
        queuedMessages: queuedMessagesFromPending(pendingMessages),
      };
    }
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionEntries = Object.entries(COLLECTION_TABLES).filter(
      ([key]) => !wanted || wanted.has(key),
    );
    const metaKeys = (keys ?? [...META_KEYS]).filter((key) =>
      META_KEYS.has(key),
    );
    const [collectionResults, metaRows] = await Promise.all([
      Promise.all(collectionEntries.map(([, table]) => table.toArray())),
      db.meta.bulkGet(metaKeys),
    ]);
    if (!retiredMetaSwept) {
      retiredMetaSwept = true;
      void db.meta.bulkDelete(RETIRED_META_KEYS).catch(() => {});
    }

    // Meta lookup first — the session and conversation retention pass needs
    // liveInboxIdList and lastFocusedConversationId from the same snapshot.
    const metaByKey: Record<string, any> = { ...context };
    for (const row of metaRows) {
      if (row) metaByKey[row.key] = row.value;
    }

    collectionEntries.forEach(([key, table], i) => {
      let rows = collectionResults[i];
      // Seed the persistence shadow with what's on disk (even an empty table) so
      // the first write after hydrate diffs against reality and can prune rows
      // the server has since deleted.
      const shadow = new Map<string, any>();
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
        const { keep, drop } = retain(rows, Date.now());
        rows = keep;
        if (drop.length) void deleteInBatches(table, drop);
      }
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) {
          if (validRow && !validRow(row)) {
            invalid.push(row._id);
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
      if (invalid.length) table.bulkDelete(invalid).catch(() => {});
      if (trimmed.length) table.bulkPut(trimmed).catch(() => {});
      lastPersisted.set(key, shadow);
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
        result.pendingMessages = await loadPendingInput(ownerId);
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
