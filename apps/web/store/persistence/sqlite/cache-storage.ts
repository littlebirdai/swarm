import type { AuthPrincipalTracker } from "@platform/auth/web";
import { HYDRATION_PAINT_KEYS } from "../../clientSyncRegistry";
import type { CacheStorage } from "../storage";
import { collectionStorage } from "./collections";
import { messageStorage } from "./messages";
import { openSchema, type SqliteDriver } from "./schema";

type SqliteCacheStorage = Omit<
  CacheStorage,
  | "enqueueDispatch"
  | "removeDispatch"
  | "loadOutbox"
  | "outboxAccountId"
  | "persistPendingMessageChanges"
  | "loadPaintCacheSync"
>;

export function createSqliteCache(
  db: SqliteDriver,
  auth: Pick<
    AuthPrincipalTracker,
    "current" | "resolve" | "tokenState" | "epoch"
  >,
  mode: "read-write" | "read-only" = "read-write",
): SqliteCacheStorage {
  const readOnly = mode === "read-only";
  openSchema(db, readOnly);
  const collections = collectionStorage(db);
  const messages = messageStorage(db);
  const residue = db.prepare(`
    SELECT 1 WHERE EXISTS (SELECT 1 FROM meta WHERE key <> 'cacheOwner')
      OR EXISTS (SELECT 1 FROM collection_rows)
      OR EXISTS (SELECT 1 FROM conversation_meta)
      OR EXISTS (SELECT 1 FROM message_rows)
  `);
  let boundOwner: string | null = null;
  let epoch = 0;
  let hydrating = false;
  let failed: { error: unknown } | undefined;

  function namedOwners() {
    const stamp = collections.getMeta("cacheOwner")?.principal;
    const user = collections.getMeta("currentUser")?._id;
    return [stamp, user].filter((id): id is string => typeof id === "string");
  }

  function stamp(principal: string | null, reason: string) {
    collections.setMeta("cacheOwner", { principal, at: Date.now(), reason });
  }

  function clear(principal: string | null) {
    db.exec(`
      DELETE FROM message_rows;
      DELETE FROM conversation_meta;
      DELETE FROM collection_rows;
      DELETE FROM meta;
    `);
    stamp(
      principal,
      principal ? "purged-for-principal" : "purged-leaving-account",
    );
  }

  function resetAfterPurge() {
    epoch++;
    collections.resetRetention();
    failed = undefined;
  }

  async function read<Result>(load: () => Result): Promise<Result | null> {
    const before = epoch;
    const authEpoch = auth.epoch();
    try {
      const principal = await auth.resolve();
      if (
        before !== epoch ||
        authEpoch !== auth.epoch() ||
        auth.current() !== principal
      )
        return null;
      let purged = false;
      const result = db.transaction(() => {
        boundOwner = principal;
        const owners = namedOwners();
        if (
          principal !== null &&
          owners.length &&
          owners.every((id) => id === principal)
        ) {
          if (
            !readOnly &&
            !failed &&
            collections.getMeta("cacheOwner")?.principal !== principal
          )
            stamp(principal, "confirmed");
          return load();
        }
        if (readOnly) return null;
        const token = auth.tokenState();
        if (token === "unreadable" || token === "unparsable") return null;
        if (residue.get()) {
          clear(principal);
          purged = true;
        } else if (principal !== null) {
          stamp(principal, "fresh");
        }
        return null;
      })();
      if (purged) resetAfterPurge();
      return result;
    } catch {
      return null;
    }
  }

  function write(change: (principal: string) => void) {
    if (readOnly || hydrating) return;
    if (failed) throw failed.error;
    const principal = auth.current();
    if (principal === null || (boundOwner !== null && boundOwner !== principal))
      return;
    try {
      db.transaction(() => {
        const owners = namedOwners();
        if (
          owners.some((id) => id !== principal) ||
          (!owners.length && residue.get())
        )
          return;
        if (collections.getMeta("cacheOwner")?.principal !== principal)
          stamp(principal, "write");
        change(principal);
      })();
      boundOwner = principal;
    } catch (error) {
      failed = { error };
      throw error;
    }
  }

  return {
    loadCache(keys, context = {}) {
      return read(() => collections.load(keys, context, !readOnly && !failed));
    },
    loadPaintCache() {
      return read(() => collections.load(HYDRATION_PAINT_KEYS, {}, false));
    },
    setHydrating(value) {
      hydrating = value;
    },
    writePatches(patches, state) {
      write((principal) => {
        const current = (state as { currentUser?: { _id?: string } })
          .currentUser?._id;
        if (current === undefined || current === principal)
          collections.write(patches, state);
      });
    },
    async flushPersistence() {
      if (failed) throw failed.error;
    },
    loadConversationMessages(id) {
      return read(() => messages.load(id));
    },
    writeConversationMessages(id, rows, pagination) {
      write(() => messages.write(id, rows, pagination));
    },
    writeConversationUserMessages(id, rows) {
      write(() => messages.writeUserMessages(id, rows));
    },
    async purgeLocalCache(options) {
      if (readOnly) return;
      const owner = options?.keepPendingInputFor ?? null;
      db.transaction(() => clear(owner))();
      resetAfterPurge();
      boundOwner = owner;
    },
  };
}
