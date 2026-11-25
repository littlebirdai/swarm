import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import { HYDRATION_PAINT_KEYS } from "../../clientSyncRegistry";
import type { CacheStorage } from "../storage";
import { collectionStorage } from "./collections";
import { messageStorage } from "./messages";
import { openSchema, type AfterCommit, type SqliteDriver } from "./schema";

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
  let blockedOwner: string | null = null;
  let purging: Promise<void> | undefined;
  function ownerEvidence() {
    const stamp = collections.getMeta("cacheOwner")?.principal;
    const user = collections.getMeta("currentUser")?._id;
    const named = [stamp, user].filter(
      (id): id is string => typeof id === "string",
    );
    return { stamp, named };
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
        const evidence = ownerEvidence();
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
    change: (afterCommit: AfterCommit, principal: string) => boolean | void,
    stateOwner?: unknown,
  ) {
    if (readOnly || hydrating || purging) return;
    const principal = auth.current();
    if (
      principal === null ||
      (boundOwner !== null && boundOwner !== principal) ||
      (stateOwner !== undefined && stateOwner !== principal)
    )
      return;
    try {
      const complete = transact((afterCommit) => {
        const evidence = ownerEvidence();
        if (
          evidence.named.some((id) => id !== principal) ||
          (!evidence.named.length && residue.get())
        )
          return;
        if (evidence.stamp !== principal) stamp(principal, "write");
        const complete = change(afterCommit, principal);
        if (scope !== "collections") messages.retain(afterCommit);
        afterCommit(() => {
          boundOwner = principal;
        });
        return complete;
      });
      if (complete === false) blockedOwner = principal;
      else if (boundOwner === principal && blockedOwner !== principal)
        blockedOwner = null;
    } catch (error) {
      if (scope === "collections") blockedOwner = principal;
      recordCacheEvent("write-failed", {
        engine: "sqlite",
        scope,
        error: String(error),
      });
    }
  }

  return {
    loadCache(keys, context = {}) {
      return read((afterCommit) =>
        collections.load(keys, context, readOnly ? undefined : afterCommit),
      );
    },
    loadPaintCache: () =>
      read(() => collections.load(HYDRATION_PAINT_KEYS, {})),
    setHydrating(value) {
      hydrating = value;
    },
    writePatches(patches, state) {
      const stateOwner = (state as { currentUser?: { _id?: string } })
        .currentUser?._id;
      write(
        "collections",
        (afterCommit, principal) =>
          collections.write(
            patches,
            state,
            blockedOwner === principal,
            afterCommit,
          ),
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
    async purgeLocalCache(options) {
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
