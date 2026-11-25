import Dexie from "dexie";
import { DOCS_SHOTS } from "../../lib/docsShots/flag";
import { recordCacheEvent } from "../cacheEvents";
import { conversationsToRows } from "./migrations/conversationsToRows";
import type { OutboxEntry } from "./outbox";
import {
  CACHE_SCHEMA_VERSION,
  SYSTEM_TABLES,
  WEB_COLLECTION_INDEXES,
} from "./schema";
import { storageTimings } from "./storage-timings";

// Docs shots (lib/docsShots) render a fixture world and keep nothing.
export const PERSISTENCE_AVAILABLE =
  typeof window !== "undefined" && !DOCS_SHOTS;

export type ConversationMessageRow = {
  convId: string;
  messageKey: string;
  position: number;
  revision: string;
  message: any;
};
type ConversationMessageMeta = {
  convId: string;
  pagination: Record<string, unknown> | undefined;
  latestTimestamp: number;
};

class CacheDB extends Dexie {
  meta!: Dexie.Table<{ key: string; value: any }, string>;
  conversationMessageMeta!: Dexie.Table<ConversationMessageMeta, string>;
  conversationMessageRows!: Dexie.Table<
    ConversationMessageRow,
    [string, string]
  >;
  conversationUserMessages!: Dexie.Table<
    { convId: string; userMessages: any[] },
    string
  >;
  dispatchOutbox!: Dexie.Table<OutboxEntry, string>;

  constructor() {
    super("codecast-store");
    this.version(CACHE_SCHEMA_VERSION)
      .stores({ ...WEB_COLLECTION_INDEXES, ...SYSTEM_TABLES })
      // Keep this callback on the current version for users who skip releases.
      .upgrade(async (tx) => {
        await conversationsToRows(tx);
        // Legacy navigator rows would have no transcript metadata for pruning.
        if (tx.idbtrans.db.objectStoreNames.contains("conversationMessages")) {
          await tx.table("conversationUserMessages").clear();
        }
      });
  }
}

export const db = new CacheDB();
db.use({
  stack: "dbcore",
  create(core) {
    return {
      table(name) {
        const table = core.table(name);
        return {
          ...table,
          mutate(request) {
            const started = performance.now();
            try {
              return table.mutate(request);
            } finally {
              storageTimings.recordWrite(
                request.type,
                performance.now() - started,
              );
            }
          },
        };
      },
    };
  },
});

// A schema upgrade needs every other Codecast tab on this origin to release
// its connection; a tab that is mid-hydration for a few seconds holds the
// upgrader, and every outbox write in THIS tab queues behind the blocked open
// ("durable enqueue still uncommitted"). Dexie's own warning reads as noise —
// name the cause so the fix (close/reload other tabs) is obvious. The store
// hears about it too: of every way a durable write can stall, this is the one
// the user can end themselves, so the storage banner names it instead of
// reporting a generic slowdown.
let upgradeBlockedListener: ((blocked: boolean) => void) | null = null;
// Event bookkeeping for the hooks below: a close this window caused, whether
// it has read a populated cache, and whether its own purge is running.
let closeExpected: "purge" | "versionchange" | null = null;
let cacheServed = false;
let purgeInProgress = false;
export function setUpgradeBlockedListener(
  fn: ((blocked: boolean) => void) | null,
) {
  upgradeBlockedListener = fn;
}
if (PERSISTENCE_AVAILABLE) {
  db.on("blocked", (ev: any) => {
    console.warn(
      `[idbCache] codecast-store upgrade to schema v${CACHE_SCHEMA_VERSION} is blocked by another Codecast tab still on schema v${Math.ceil((ev?.oldVersion ?? 0) / 10)} — close or reload other tabs`,
    );
    upgradeBlockedListener?.(true);
  });
  // "ready" fires once the open (and so the upgrade) went through; sticky so
  // it also fires for a reopen after a versionchange close.
  db.on(
    "ready",
    () => {
      upgradeBlockedListener?.(false);
    },
    true,
  );
  // The other side (this tab is the holder) is Dexie's default versionchange
  // handler: it closes with auto-reopen so the upgrader can proceed.

  // What happens to the database underneath this window, recorded so a lost
  // or purged cache leaves a trace (store/cacheEvents.ts). Dexie fires
  // `close` for every close, its own included, so the closes this window
  // expects (a purge, a versionchange) are named and the rest are the
  // browser force-closing the store.
  db.on("versionchange", (ev: any) => {
    closeExpected = "versionchange";
    recordCacheEvent("db-versionchange", {
      oldVersion: ev?.oldVersion ?? null,
      newVersion: ev?.newVersion ?? null,
    });
  });
  db.on("close", () => {
    const expected = closeExpected;
    closeExpected = null;
    if (expected) return;
    recordCacheEvent("db-closed", { servedCache: cacheServed });
  });
  // A database created from nothing. At first boot that is ordinary; after
  // this window already read a populated cache, and outside its own purge,
  // the store was lost under a running window.
  db.on("populate", () => {
    // The purge's own reopen is covered by its "purge" event. A first boot
    // and a store lost before boot look the same here, so only a loss under
    // a window that was already reading the cache is reported.
    if (purgeInProgress) return;
    recordCacheEvent(
      "db-created",
      { servedCache: cacheServed },
      { report: cacheServed },
    );
  });
}

const COLLECTION_STORE_KEYS = Object.keys(WEB_COLLECTION_INDEXES);
export const COLLECTION_TABLES: Record<
  string,
  Dexie.Table<any, string>
> = Object.fromEntries(
  COLLECTION_STORE_KEYS.filter((key) => (db as any)[key]).map((key) => [
    key,
    (db as any)[key],
  ]),
);

// The schema is derived from the registry, so every registered collection has
// a table by construction; this list should always be empty. Kept as a loud
// runtime guard (a registered collection with no table would reject
// loadCache's Promise.all and silently disable the ENTIRE cache).
export const MISSING_COLLECTION_TABLES: string[] = COLLECTION_STORE_KEYS.filter(
  (key) => !(db as any)[key],
);
if (MISSING_COLLECTION_TABLES.length > 0) {
  console.error(
    `[idbCache] registry collections missing Dexie tables: ${MISSING_COLLECTION_TABLES.join(", ")}`,
  );
}

// Test hook: Dexie copies the IndexedDB API into the instance at construction
// and remembers a failed open, so a test running after another file already
// touched the singleton (no IndexedDB in the process then) must hand the
// instance fake-indexeddb and reopen it.
export function _reopenForTests(deps: {
  indexedDB: unknown;
  IDBKeyRange: unknown;
}): Promise<unknown> {
  Object.assign((db as any)._deps, deps);
  db.close();
  return db.open();
}

export function markCacheServed() {
  cacheServed = true;
}

export function setPurgeInProgress(inProgress: boolean) {
  purgeInProgress = inProgress;
}

export function deleteCacheDatabase() {
  closeExpected = "purge";
  return db.delete();
}

export function reopenAfterPurge() {
  closeExpected = null;
  // Dexie 4 does NOT reopen on its own after delete(): every later access
  // throws DatabaseClosedError. A signed-out page navigates away, but a
  // window that purged on an account boundary keeps running for the next
  // account, so reopen (an empty database with the current schema) now.
  return db.open().catch((error) =>
    recordCacheEvent("db-open-failed", {
      step: "reopen-after-purge",
      error: String(error),
    }),
  );
}
