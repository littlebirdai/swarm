import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import type { CacheStorage } from "../storage";
import { collectionStorage } from "./collections";
import { messageStorage } from "./messages";
import type { SqliteFlushBatchPayload } from "./protocol";
import { openSchema, type AfterCommit, type SqliteDriver } from "./schema";

export type SqliteCacheStorage = Omit<
  CacheStorage,
  | "enqueueDispatch"
  | "removeDispatch"
  | "loadOutbox"
  | "outboxAccountId"
  | "persistPendingMessageChanges"
  | "loadPaintCache"
  | "loadPaintCacheSync"
> & {
  flushBatch(batch: SqliteFlushBatchPayload): void;
  ownerState(): { named: string[]; blocked: boolean };
};

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
  let blockedOwner: string | null = null;
  let purging: Promise<void> | undefined;
  let inspected: ReturnType<typeof ownerEvidence> | null = null;
  function ownerEvidence() {
    const owner = collections.getMeta("cacheOwner");
    const stamp = owner?.principal;
    const user = collections.getMeta("currentUser")?._id;
    const named = [stamp, user].filter(
      (id): id is string => typeof id === "string",
    );
    return { stamp, named, blocked: owner?.blocked === true };
  }
  function stamp(principal: string | null, reason: string, blocked = false) {
    collections.setMeta("cacheOwner", {
      principal,
      at: Date.now(),
      reason,
      blocked,
    });
  }
  function acceptsWrite(
    { named }: ReturnType<typeof ownerEvidence>,
    principal: string,
  ) {
    return (
      (named.length && named.every((id) => id === principal)) || !residue.get()
    );
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
  function reset(owner: string | null) {
    boundOwner = owner;
    epoch++;
    blockedOwner = null;
    collections.resetRetention();
    messages.resetRetention();
  }
  function transact<Result>(
    body: (afterCommit: AfterCommit) => Result,
  ): Result {
    const committed: Array<() => void> = [];
    const result = db.transaction(() =>
      body((callback) => committed.push(callback)),
    )();
    for (const callback of committed) callback();
    return result;
  }
  async function read<Result>(
    load: (afterCommit: AfterCommit) => Result,
  ): Promise<Result | null> {
    const preread = inspected;
    inspected = null;
    if (purging) return null;
    const before = epoch;
    const authEpoch = auth.epoch();
    try {
      const principal = await auth.resolve();
      if (
        purging ||
        before !== epoch ||
        authEpoch !== auth.epoch() ||
        auth.current() !== principal
      )
        return null;
      const previousOwner = boundOwner ?? blockedOwner;
      return transact((afterCommit) => {
        const evidence = preread ?? ownerEvidence();
        if (
          principal !== null &&
          evidence.named.length &&
          evidence.named.every((id) => id === principal)
        ) {
          if (!readOnly && evidence.stamp !== principal)
            stamp(principal, "confirmed");
          afterCommit(() => {
            if (previousOwner && previousOwner !== principal) reset(principal);
            boundOwner = principal;
          });
          return load(afterCommit);
        }
        if (readOnly) return null;
        const token = auth.tokenState();
        if (token === "unreadable" || token === "unparsable") return null;
        const hasResidue = residue.get();
        if (hasResidue) clear(principal);
        else if (principal !== null) stamp(principal, "fresh");
        afterCommit(() => {
          if (hasResidue || (previousOwner && previousOwner !== principal))
            reset(principal);
          boundOwner = principal;
        });
        return null;
      });
    } catch {
      return null;
    }
  }
  function write(
    scope: "collections" | "transcript" | "navigator",
    change: (afterCommit: AfterCommit, blocked: boolean) => boolean | void,
    stateOwner?: unknown,
  ) {
    inspected = null;
    if (readOnly || hydrating || purging) return;
    const principal = auth.current();
    if (
      principal === null ||
      (boundOwner !== null && boundOwner !== principal) ||
      (stateOwner !== undefined && stateOwner !== principal)
    )
      return;
    try {
      transact((afterCommit) => {
        const evidence = ownerEvidence();
        if (!acceptsWrite(evidence, principal)) return;
        const diskBlocked = evidence.stamp === principal && evidence.blocked;
        const blocked = diskBlocked || blockedOwner === principal;
        if (evidence.stamp !== principal || blocked !== diskBlocked)
          stamp(principal, "write", blocked);
        if (change(afterCommit, blocked) === false && !blocked)
          stamp(principal, "write-failed", true);
        if (scope !== "collections") messages.retain(afterCommit);
        afterCommit(() => {
          boundOwner = principal;
          blockedOwner = null;
        });
      });
    } catch (error) {
      if (scope === "collections") {
        blockedOwner = principal;
        try {
          const saved = db.transaction(() => {
            if (!acceptsWrite(ownerEvidence(), principal)) return false;
            stamp(principal, "write-failed", true);
            return true;
          })();
          if (saved) blockedOwner = null;
        } catch {}
      }
      recordCacheEvent("write-failed", {
        engine: "sqlite",
        scope,
        error: String(error),
      });
    }
  }

  return {
    ownerState() {
      inspected = ownerEvidence();
      return { named: inspected.named, blocked: inspected.blocked };
    },
    loadCache(keys, context = {}) {
      return read((afterCommit) =>
        collections.load(keys, context, readOnly ? undefined : afterCommit),
      );
    },
    setHydrating(value) {
      hydrating = value;
    },
    writePatches(patches, state) {
      const stateOwner = (state as { currentUser?: { _id?: string } })
        .currentUser?._id;
      write(
        "collections",
        (afterCommit, blocked) =>
          collections.write(patches, state, blocked, afterCommit),
        stateOwner,
      );
    },
    flushPersistence: () => purging ?? Promise.resolve(),
    loadConversationMessages: (id) => read(() => messages.load(id)),
    writeConversationMessages(id, rows, pagination) {
      write("transcript", () => messages.write(id, rows, pagination));
    },
    writeConversationUserMessages(id, rows) {
      write("navigator", () => messages.writeUserMessages(id, rows));
    },
    flushBatch(batch) {
      const stateOwner = (
        batch.state as { currentUser?: { _id?: string } } | undefined
      )?.currentUser?._id;
      const hasConversations = Boolean(batch.conversations?.length);
      write(
        "collections",
        (afterCommit, blocked) => {
          let complete = true;
          const hasPatches = Boolean(batch.patches?.length && batch.state);
          if (hasPatches) {
            complete = collections.write(
              batch.patches!,
              batch.state!,
              blocked,
              afterCommit,
              {
                evictions: batch.evictions,
                deferSyncMeta: true,
              },
            );
          }
          if (batch.conversations?.length) {
            for (const item of batch.conversations) {
              if (item.messages) {
                messages.write(
                  item.conversationId,
                  item.messages.rows,
                  item.messages.pagination,
                );
              }
              if (item.userMessages) {
                messages.writeUserMessages(
                  item.conversationId,
                  item.userMessages,
                );
              }
            }
            messages.retain(afterCommit);
          }
          const wantsSyncMeta =
            hasPatches &&
            batch.patches!.some((p) => p.path[0] === "syncMeta") &&
            Object.hasOwn(batch.state!, "syncMeta");
          if (complete && !blocked && wantsSyncMeta) {
            return collections.setMeta("syncMeta", batch.state!.syncMeta);
          }
          return complete;
        },
        stateOwner,
      );
      void hasConversations;
    },
    deleteInvalidatedDocDetails(ids, current) {
      if (readOnly) return Promise.resolve([]);
      let deleted: string[] = [];
      write("collections", () => {
        const confirmed = ids.filter(current);
        deleted = collections.deleteDocDetails(confirmed);
      });
      return Promise.resolve(deleted);
    },
    readCachedDocDetails() {
      return read(() => collections.readDocDetailRefs()).then(
        (rows) => rows ?? [],
      );
    },
    async purgeLocalCache(options) {
      inspected = null;
      if (readOnly) return;
      const owner = options?.keepPendingInputFor ?? null;
      purging ??= Promise.resolve()
        .then(() => {
          db.transaction(() => clear(owner))();
          reset(owner);
        })
        .finally(() => {
          purging = undefined;
        });
      return purging;
    },
  };
}
