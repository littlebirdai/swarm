import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  spyOn,
} from "bun:test";
import { Database } from "bun:sqlite";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Patch } from "mutative";
import {
  AUTH_JWT_STORAGE_KEY,
  issueFakeToken,
  mapStorage,
} from "../../__tests__/fixtures/fakeAuthToken";
import { MESSAGE_PAGE_SIZE, SESSION_CACHE_TTL_MS } from "../../cacheRetention";
import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../../clientSyncRegistry";
import { createSqliteCache } from "./cache-storage";

const owner = "userA";
const id = "a".repeat(32);
const oldId = "b".repeat(32);
const row = { _id: id, updated_at: Date.now(), message_count: 1 };
const sessionState = { sessions: { [id]: row } };
const patch = (...path: string[]): Patch => ({
  op: "replace",
  path,
  value: null,
});
const writeSessions = (
  store: Pick<typeof dexieStorage, "writePatches">,
  state = sessionState,
) => store.writePatches([patch("sessions")], state);
const signIn = (principal: string) =>
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken(principal));
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
if (!originalStorage)
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: mapStorage(),
  });
const originalToken = localStorage.getItem(AUTH_JWT_STORAGE_KEY);
signIn(owner);
const { readCacheEvents } = await import("../../cache-events");
const { noteSnapshotSync, _resetSnapshotLedger } =
  await import("../../idb-collection-diff");
const { authPrincipal } = await import("../../../lib/authPrincipal");
const { _reopenForTests, db: dexie } = await import("../db");
const dexieStorage = await import("../dexie-storage");
const { flushLivenessWrites } = await import("../idb-liveness-lane");
const { flushConversationMessages } = await import("../message-cache");
beforeEach(() => {
  signIn(owner);
  _resetSnapshotLedger();
});
afterAll(() => {
  if (originalToken === null) localStorage.removeItem(AUTH_JWT_STORAGE_KEY);
  else localStorage.setItem(AUTH_JWT_STORAGE_KEY, originalToken);
  if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
});
for (const engine of ["Dexie", "SQLite"]) {
  describe(engine, () => {
    let sqlite: Database | undefined;
    let store: ReturnType<typeof createSqliteCache>;
    let syncWrites: () => Promise<void>;
    let setMeta: (key: string, value: unknown) => unknown;
    let getMeta: (key: string) => Promise<unknown> | unknown;
    beforeEach(async () => {
      if (engine === "Dexie") {
        await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
        store = dexieStorage;
        setMeta = (key, value) => dexie.meta.put({ key, value });
        getMeta = async (key) => (await dexie.meta.get(key))?.value;
        syncWrites = async () => {
          flushLivenessWrites();
          flushConversationMessages();
          await dexie.transaction("r", dexie.tables, () => dexie.meta.count());
        };
      } else {
        const db = new Database(":memory:");
        sqlite = db;
        store = createSqliteCache(db, authPrincipal);
        setMeta = (key, value) =>
          db
            .query("INSERT OR REPLACE INTO meta VALUES (?, ?)")
            .run(key, JSON.stringify(value));
        getMeta = (key) => {
          const row = db
            .query<{ value: string }, [string]>(
              "SELECT value FROM meta WHERE key = ?",
            )
            .get(key);
          return row && JSON.parse(row.value);
        };
        syncWrites = store.flushPersistence;
      }
      await store.loadCache(["sessions"]);
    });
    afterEach(async () => {
      await store.purgeLocalCache();
      if (sqlite) sqlite.close();
      else dexie.close();
    });
    test("conflicting owner evidence purges rows despite a matching caller", async () => {
      writeSessions(store);
      await syncWrites();
      await setMeta("currentUser", { _id: "userB" });
      expect(
        await store.loadCache(["sessions"], { currentUser: { _id: owner } }),
      ).toBeNull();
      expect(await getMeta("cacheOwner")).toMatchObject({ principal: owner });
      expect(await store.loadCache(["sessions"])).toBeNull();
    });
    test("boot keeps live and focused sessions and drops expired sessions", async () => {
      const focus = "c".repeat(32);
      const expired = "d".repeat(32);
      const updated_at = Date.now() - SESSION_CACHE_TTL_MS - 60_000;
      await setMeta("liveInboxIdList", [oldId]);
      await setMeta("lastFocusedConversationId", focus);
      writeSessions(store, {
        sessions: {
          [id]: row,
          [oldId]: { ...row, _id: oldId, updated_at },
          [focus]: { ...row, _id: focus, updated_at },
          [expired]: { ...row, _id: expired, updated_at },
        },
      });
      await syncWrites();
      const cached = await store.loadCache(HYDRATION_CRITICAL_READ_KEYS);
      expect(Object.keys(cached?.sessions ?? {}).sort()).toEqual([
        id,
        oldId,
        focus,
      ]);
      await syncWrites();
      await setMeta("liveInboxIdList", [expired]);
      expect(
        (await store.loadCache(["sessions"]))?.sessions[expired],
      ).toBeUndefined();
      expect(
        (await store.loadCache(HYDRATION_DEFERRED_KEYS))?.sessions,
      ).toBeUndefined();
    });
    test("patches preserve an unheld row until a durable delete authorizes removal", async () => {
      writeSessions(store);
      await syncWrites();
      store.writePatches([{ op: "remove", path: ["sessions", id] }], {
        sessions: {},
      });
      await syncWrites();
      expect((await store.loadCache(["sessions"]))?.sessions[id]).toEqual(row);
      store.writePatches([{ op: "remove", path: ["sessions", id] }], {
        sessions: {},
        pending: { [`sessions:${id}`]: { type: "exclude" } },
      });
      await syncWrites();
      expect(await store.loadCache(["sessions"])).toBeNull();
    });
    test("cursor and updated liveness row commit in the same batch", async () => {
      writeSessions(store);
      await syncWrites();
      expect((await store.loadCache(["sessions"]))?.sessions[id]).toEqual(row);
      const next = { ...row, message_count: 2 };
      const syncMeta = { s: { cursor: 2 } };
      store.writePatches(
        [patch("syncMeta", "s"), patch("sessions", id, "message_count")],
        { sessions: { [id]: next }, syncMeta },
      );
      const before = await store.loadCache(["sessions", "syncMeta"]);
      if (before?.syncMeta) expect(before.sessions[id]).toEqual(next);
      await syncWrites();
      const after = await store.loadCache(["sessions", "syncMeta"]);
      expect(after?.syncMeta).toEqual(syncMeta);
      expect(after?.sessions[id]).toEqual(next);
    });
    test("transcript tail keeps order, duplicate IDs, cursor and navigator rows", async () => {
      const rows = Array.from(
        { length: MESSAGE_PAGE_SIZE + 1 },
        (_, index) => ({
          _id: "message",
          timestamp: index + 1,
          content: String(index),
        }),
      );
      const userMessages = [{ _id: "user-message" }];
      store.writeConversationUserMessages(id, userMessages);
      await syncWrites();
      expect(await store.loadConversationMessages(id)).toMatchObject({
        messages: [],
        userMessages,
      });
      store.writeConversationMessages(id, rows, { cursor: 41 });
      await syncWrites();
      expect(await store.loadConversationMessages(id)).toMatchObject({
        messages: rows.slice(1),
        pagination: { cursor: 41, hasMoreAbove: true },
      });
      const edited = { ...rows.at(-1), timestamp: 500, content: "updated" };
      const streamed = [...rows.slice(1, -1), edited];
      store.writeConversationMessages(id, streamed, {
        cursor: 42,
        hasMoreAbove: true,
      });
      await syncWrites();
      expect(await store.loadConversationMessages(id)).toEqual({
        messages: streamed,
        pagination: { cursor: 42, hasMoreAbove: true },
        latestTimestamp: 500,
        userMessages,
      });
    });
    test("purge during a write clears the old tail and permits the next epoch", async () => {
      const entered = Promise.withResolvers<Promise<void>>();
      const purge = () =>
        entered.resolve(
          Dexie.ignoreTransaction(() =>
            store.purgeLocalCache({ keepPendingInputFor: owner }),
          ),
        );
      if (sqlite) {
        sqlite.function("purge_in_write", () => {
          purge();
          return 1;
        });
        sqlite.exec(`CREATE TRIGGER overlap BEFORE INSERT ON message_rows
          BEGIN SELECT purge_in_write(); END`);
      } else {
        dexie.conversationMessageRows.hook("creating", purge);
      }
      store.writeConversationMessages(id, [{ _id: "old" }], { cursor: 1 });
      const writing = syncWrites().catch(() => {});
      try {
        await entered.promise;
        await writing;
      } finally {
        if (sqlite) sqlite.exec("DROP TRIGGER overlap");
        else dexie.conversationMessageRows.hook("creating").unsubscribe(purge);
      }
      expect(await store.loadConversationMessages(id)).toBeNull();
      expect(
        sqlite
          ? sqlite
              .query<{ count: number }, []>(
                "SELECT count(*) AS count FROM message_rows",
              )
              .get()?.count
          : await dexie.conversationMessageRows.count(),
      ).toBe(0);
      store.writeConversationMessages(id, [{ _id: "new" }], { cursor: 2 });
      await syncWrites();
      expect(await store.loadConversationMessages(id)).toMatchObject({
        messages: [{ _id: "new" }],
        pagination: { cursor: 2 },
      });
    });
    test("hydration blocks collection and transcript writes", async () => {
      store.setHydrating(true);
      try {
        writeSessions(store);
        store.writeConversationMessages(id, [{ _id: "hydrating" }], {});
        await syncWrites();
      } finally {
        store.setHydrating(false);
      }
      expect(await store.loadCache(["sessions"])).toBeNull();
      expect(await store.loadConversationMessages(id)).toBeNull();
    });
    test("an unparsable token does not purge a foreign cache", async () => {
      writeSessions(store);
      await syncWrites();
      await setMeta("cacheOwner", { principal: "userB" });
      localStorage.setItem(AUTH_JWT_STORAGE_KEY, "unparsable");
      expect(await store.loadCache(["sessions"])).toBeNull();
      expect(await getMeta("cacheOwner")).toMatchObject({ principal: "userB" });
      signIn("userB");
      expect(await store.loadCache(["sessions"])).toEqual(sessionState);
    });
    test("boot removes ownerless residue before accepting new writes", async () => {
      writeSessions(store);
      await syncWrites();
      if (sqlite) sqlite.exec("DELETE FROM meta WHERE key = 'cacheOwner'");
      else await dexie.meta.delete("cacheOwner");
      expect(await store.loadCache(["sessions"])).toBeNull();
      expect(await store.loadCache(["sessions"])).toBeNull();
      writeSessions(store);
      await syncWrites();
      expect(await store.loadCache(["sessions"])).toEqual(sessionState);
    });
    test("snapshot drops extend a row patch to the replaced collection", async () => {
      writeSessions(store);
      await syncWrites();
      noteSnapshotSync("sessions", [oldId], [id]);
      const next = { ...row, _id: oldId };
      store.writePatches([patch("sessions", oldId)], {
        sessions: { [oldId]: next },
      });
      await syncWrites();
      expect(await store.loadCache(["sessions"])).toEqual({
        sessions: { [oldId]: next },
      });
    });
    test("deferred boot removes expired and invalid rows from disk", async () => {
      store.writePatches([patch("taskComments")], {
        taskComments: {
          [id]: { _id: id, comments: [], _cachedAt: 1 },
          [oldId]: { _id: oldId, _cachedAt: Date.now() },
        },
      });
      await syncWrites();
      expect(
        (await store.loadCache(HYDRATION_DEFERRED_KEYS))?.taskComments,
      ).toBeUndefined();
      await syncWrites();
      expect(
        sqlite
          ? sqlite
              .query<{ count: number }, []>(
                "SELECT count(*) AS count FROM collection_rows WHERE collection = 'taskComments'",
              )
              .get()?.count
          : await dexie.table("taskComments").count(),
      ).toBe(0);
    });

    test("account switch blocks stale writes and the new account starts empty", async () => {
      writeSessions(store);
      await syncWrites();
      expect((await store.loadCache(["sessions"]))?.sessions[id]).toEqual(row);
      signIn("userB");
      writeSessions(store, {
        sessions: { [id]: { ...row, message_count: 3 } },
      });
      await syncWrites();
      signIn(owner);
      expect((await store.loadCache(["sessions"]))?.sessions[id]).toEqual(row);
      signIn("userB");
      expect(await store.loadCache(["sessions"])).toBeNull();
      writeSessions(store, {
        sessions: { [id]: { ...row, message_count: 4 } },
      });
      await syncWrites();
      expect(
        (await store.loadCache(["sessions"]))?.sessions[id].message_count,
      ).toBe(4);
    });
  });
}

test("SQLite reports cursor failure, saves later rows and fences later cursors until reset", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  store.writePatches([patch("sessions"), patch("syncMeta")], {
    ...sessionState,
    syncMeta: { cursor: 1 },
  });
  db.exec(`CREATE TRIGGER fail_cursor BEFORE INSERT ON meta
    WHEN new.key = 'syncMeta' BEGIN SELECT RAISE(ABORT, 'cursor failure'); END`);
  const later = (message_count: number) =>
    store.writePatches([patch("sessions", id), patch("syncMeta")], {
      sessions: { [id]: { ...row, message_count } },
      syncMeta: { cursor: message_count },
    });
  expect(() => later(2)).not.toThrow();
  expect(await store.loadCache(["sessions", "syncMeta"])).toEqual({
    ...sessionState,
    syncMeta: { cursor: 1 },
  });
  expect(readCacheEvents().at(-1)?.kind).toBe("write-failed");
  db.exec("DROP TRIGGER fail_cursor");
  later(3);
  expect(await store.loadCache(["sessions", "syncMeta"])).toMatchObject({
    sessions: { [id]: { message_count: 3 } },
    syncMeta: { cursor: 1 },
  });
  await store.flushPersistence();
  await store.purgeLocalCache({ keepPendingInputFor: owner });
  later(4);
  expect(await store.loadCache(["syncMeta"])).toEqual({
    syncMeta: { cursor: 4 },
  });
});

test("SQLite rolls back transcript rows on a pagination failure and keeps other writes live", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  store.writeConversationMessages(id, [{ _id: "first" }], { cursor: 1 });
  db.exec(`CREATE TRIGGER fail_pagination BEFORE UPDATE ON conversation_meta
    BEGIN SELECT RAISE(ABORT, 'pagination failure'); END`);
  expect(() =>
    store.writeConversationMessages(id, [{ _id: "second" }], { cursor: 2 }),
  ).not.toThrow();
  expect(await store.loadConversationMessages(id)).toMatchObject({
    messages: [{ _id: "first" }],
    pagination: { cursor: 1 },
  });
  expect(readCacheEvents().at(-1)?.kind).toBe("write-failed");
  store.writePatches([patch("sessions"), patch("syncMeta")], {
    ...sessionState,
    syncMeta: { cursor: 3 },
  });
  expect(await store.loadCache(["syncMeta"])).toEqual({
    syncMeta: { cursor: 3 },
  });
  db.exec("DROP TRIGGER fail_pagination");
  store.writeConversationMessages(id, [{ _id: "third" }], { cursor: 3 });
  expect(await store.loadConversationMessages(id)).toMatchObject({
    pagination: { cursor: 3 },
  });
});

test("SQLite read-only scope projects paint keys and leaves disk unchanged", async () => {
  using db = new Database(":memory:");
  const writer = createSqliteCache(db, authPrincipal);
  writeSessions(writer, {
    sessions: {
      [id]: row,
      [oldId]: {
        ...row,
        _id: oldId,
        updated_at: Date.now() - SESSION_CACHE_TTL_MS - 1,
      },
    },
  });
  writer.writePatches([patch("currentUser")], { currentUser: { _id: owner } });
  db.exec("DELETE FROM meta WHERE key = 'cacheOwner'");
  const reader = createSqliteCache(db, authPrincipal, "read-only");
  expect(await reader.loadPaintCache()).toEqual(sessionState);
  expect(await reader.loadCache(["sessions"])).toEqual(sessionState);
  writeSessions(reader, { sessions: { [id]: { ...row, message_count: 2 } } });
  await reader.purgeLocalCache();
  expect(
    db.query("SELECT value FROM meta WHERE key = 'cacheOwner'").get(),
  ).toBeNull();
  expect(db.query("SELECT id FROM collection_rows ORDER BY id").all()).toEqual([
    { id },
    { id: oldId },
  ]);
  signIn("userB");
  expect(await reader.loadCache(["sessions"])).toBeNull();
  expect(db.query("SELECT id FROM collection_rows ORDER BY id").all()).toEqual([
    { id },
    { id: oldId },
  ]);
});

test("SQLite drops a read started before an epoch reset", async () => {
  using db = new Database(":memory:");
  const pending = Promise.withResolvers<string>();
  const store = createSqliteCache(db, {
    ...authPrincipal,
    resolve: () => pending.promise,
  });
  writeSessions(store);
  const stale = store.loadCache(["sessions"]);
  await store.purgeLocalCache({ keepPendingInputFor: owner });
  writeSessions(store, { sessions: { [id]: { ...row, message_count: 2 } } });
  pending.resolve(owner);
  expect(await stale).toBeNull();
  expect(
    (await store.loadCache(["sessions"]))?.sessions[id].message_count,
  ).toBe(2);
});

test("SQLite withholds an unreadable owner record without clearing the cache", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  writeSessions(store);
  db.exec("UPDATE meta SET value = 'invalid JSON' WHERE key = 'cacheOwner'");
  expect(await store.loadCache(["sessions"])).toBeNull();
  db.query("UPDATE meta SET value = ? WHERE key = 'cacheOwner'").run(
    JSON.stringify({ principal: owner }),
  );
  expect(await store.loadCache(["sessions"])).toEqual(sessionState);
});

test("SQLite rejects an unknown schema version and keeps its rows", () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  writeSessions(store);
  expect(db.query("SELECT rowid FROM collection_rows").get()).toEqual({
    rowid: 1,
  });

  db.exec("INSERT INTO migrations VALUES (2)");
  expect(() => createSqliteCache(db, authPrincipal)).toThrow(
    "Unsupported SQLite cache version",
  );
  expect(db.query("SELECT id FROM collection_rows").all()).toEqual([{ id }]);
});

test("SQLite throttles pruning of transcript and navigator rows", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  store.writeConversationMessages(
    oldId,
    [{ _id: "old", timestamp: 1 }],
    undefined,
  );
  store.writeConversationUserMessages(oldId, [{ _id: "navigator" }]);
  const now = Date.now();
  const backdated = now - 31 * 24 * 60 * 60 * 1000;
  db.query("UPDATE conversation_meta SET touched_at = ? WHERE id = ?").run(
    backdated,
    oldId,
  );
  const recent = [{ _id: "recent", timestamp: 1 }];
  store.writeConversationMessages(id, recent, undefined);
  expect(await store.loadConversationMessages(oldId)).toMatchObject({
    userMessages: [{ _id: "navigator" }],
  });
  const clock = spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
  try {
    store.writeConversationMessages(id, recent, undefined);
  } finally {
    clock.mockRestore();
  }
  expect(await store.loadConversationMessages(oldId)).toBeNull();
  expect(db.query("SELECT conversation_id FROM message_rows").all()).toEqual([
    { conversation_id: id },
  ]);
});

test("SQLite fences a writer that still belongs to the previous account", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  writeSessions(store);
  signIn("userB");
  const next = createSqliteCache(db, authPrincipal);
  expect(await next.loadCache(["sessions"])).toBeNull();
  writeSessions(store);
  expect(await next.loadCache(["sessions"])).toBeNull();
});

test("SQLite drops a read across a sign-out and sign-in to the same account", async () => {
  using db = new Database(":memory:");
  const pending = Promise.withResolvers<string>();
  let epoch = 0;
  const store = createSqliteCache(db, {
    ...authPrincipal,
    epoch: () => epoch,
    resolve: () => pending.promise,
  });
  writeSessions(store);
  const stale = store.loadCache(["sessions"]);
  epoch += 2;
  pending.resolve(owner);
  expect(await stale).toBeNull();
  expect(await store.loadCache(["sessions"])).toEqual(sessionState);
});

test("SQLite boots only the requested keys and leaves pending locks in IndexedDB", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  const meta = { _id: id, timestamp: Date.now() };
  store.writePatches(
    [
      patch("sessions"),
      patch("mySends"),
      patch("pending"),
      patch("pendingMessages"),
      patch("queuedMessages"),
    ],
    {
      ...sessionState,
      mySends: { [id]: meta },
      pending: { lock: { type: "include" } },
      pendingMessages: { [id]: [{ _id: "pending" }] },
      queuedMessages: { [id]: [{ _id: "queued" }] },
    },
  );
  expect(await store.loadCache(HYDRATION_DEFERRED_KEYS)).toEqual({
    mySends: { [id]: meta },
  });
  expect(await store.loadPaintCache()).toEqual(sessionState);
  expect(
    db
      .query(
        "SELECT key FROM meta WHERE key IN ('pending', 'pendingMessages', 'queuedMessages')",
      )
      .get(),
  ).toBeNull();
});

test("SQLite retries the same boot retention candidates after rollback and uses the saved live list", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  const rescued = "c".repeat(32);
  const newlyExpired = "d".repeat(32);
  const expired = Date.now() - SESSION_CACHE_TTL_MS - 1;
  const old = (key: string) => ({ _id: key, updated_at: expired });
  const kept = { [id]: row };
  store.writePatches([patch("conversations"), patch("liveInboxIdList")], {
    conversations: {
      ...kept,
      [oldId]: old(oldId),
      [rescued]: old(rescued),
      [newlyExpired]: old(newlyExpired),
    },
    liveInboxIdList: [newlyExpired],
  });
  expect((await store.loadCache(["conversations"]))?.conversations).toEqual({
    ...kept,
    [newlyExpired]: old(newlyExpired),
  });
  store.writePatches([patch("liveInboxIdList")], {
    liveInboxIdList: [rescued],
  });
  db.exec(`CREATE TRIGGER reject_retention BEFORE INSERT ON meta
    WHEN new.key = 'syncMeta' BEGIN SELECT RAISE(ABORT, 'retention error'); END`);
  store.writePatches([patch("conversations", id), patch("syncMeta")], {
    conversations: kept,
    syncMeta: { cursor: 1 },
  });
  expect(db.query("SELECT id FROM collection_rows").all()).toHaveLength(4);
  db.exec("DROP TRIGGER reject_retention");
  store.writePatches([patch("conversations", id)], { conversations: kept });
  expect(db.query("SELECT id FROM collection_rows ORDER BY id").all()).toEqual([
    { id },
    { id: rescued },
    { id: newlyExpired },
  ]);
});

test("SQLite treats null and undefined as absent in both patch forms", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  const pending = { [`sessions:${id}`]: { type: "exclude" } };
  for (const paths of [["sessions", id], ["sessions"]]) {
    for (const value of [null, undefined]) {
      writeSessions(store);
      store.writePatches([patch(...paths)], {
        sessions: { [id]: value },
        pending,
      });
      expect(await store.loadCache(["sessions"])).toBeNull();
    }
  }
});

test("SQLite retains snapshot delete authority after rollback", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  writeSessions(store);
  noteSnapshotSync("sessions", [], [id]);
  db.exec(`CREATE TRIGGER reject_snapshot BEFORE INSERT ON meta
    WHEN new.key = 'syncMeta' BEGIN SELECT RAISE(ABORT, 'snapshot error'); END`);
  store.writePatches([patch("sessions"), patch("syncMeta")], {
    sessions: {},
    syncMeta: { cursor: 1 },
  });
  expect(await store.loadCache(["sessions"])).toEqual(sessionState);
  db.exec("DROP TRIGGER reject_snapshot");
  store.writePatches([patch("sessions", oldId)], { sessions: {} });
  expect(await store.loadCache(["sessions"])).toBeNull();
});

test("SQLite rejected reads and writes do not bind the account", async () => {
  using db = new Database(":memory:");
  writeSessions(createSqliteCache(db, authPrincipal));
  const reader = createSqliteCache(db, {
    ...authPrincipal,
    tokenState: () => "unreadable",
  });
  const writer = createSqliteCache(db, authPrincipal);
  signIn("userB");
  expect(await reader.loadCache(["sessions"])).toBeNull();
  writeSessions(writer);
  signIn(owner);
  for (const [store, message_count] of [
    [reader, 4],
    [writer, 5],
  ] as const) {
    store.writePatches([patch("sessions", id)], {
      sessions: { [id]: { ...row, message_count } },
    });
    expect(await store.loadCache(["sessions"])).toMatchObject({
      sessions: { [id]: { message_count } },
    });
  }
});

test("SQLite skips an unencodable collection row and normalizes JSON values", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  store.writePatches([patch("sessions"), patch("syncMeta")], {
    sessions: {
      [id]: {
        ...row,
        nan: NaN,
        date: new Date(0),
        map: new Map([["key", 1]]),
        omitted: undefined,
      },
      [oldId]: { ...row, _id: oldId, big: BigInt(1) },
    },
    syncMeta: { cursor: 2 },
  });
  expect(await store.loadCache(["sessions", "syncMeta"])).toEqual({
    sessions: {
      [id]: { ...row, nan: null, date: new Date(0).toISOString(), map: {} },
    },
  });
  expect(readCacheEvents().at(-1)?.kind).toBe("write-failed");
});

test("SQLite normalized message comparison avoids rewriting an unchanged JSON row", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  store.writeConversationMessages(id, [{ _id: "first" }], { cursor: 1 });
  db.exec(`CREATE TRIGGER fail_rewrite BEFORE INSERT ON message_rows
    BEGIN SELECT RAISE(ABORT, 'unchanged message was rewritten'); END`);
  store.writeConversationMessages(id, [{ _id: "first", omitted: undefined }], {
    cursor: 2,
  });
  expect(await store.loadConversationMessages(id)).toMatchObject({
    messages: [{ _id: "first" }],
    pagination: { cursor: 2 },
  });
});

test("SQLite removes invalid rows by SQL id and ignores non-finite timestamps", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  writeSessions(store, {
    sessions: { [id]: { ...row, updated_at: Infinity } },
  });
  expect(db.query("SELECT timestamp FROM collection_rows").get()).toEqual({
    timestamp: null,
  });
  db.query(
    "INSERT INTO collection_rows VALUES ('taskComments', ?, NULL, ?)",
  ).run(oldId, JSON.stringify({ _id: id, _cachedAt: Date.now() }));
  expect(await store.loadCache(["taskComments"])).toBeNull();
  expect(
    db
      .query("SELECT id FROM collection_rows WHERE collection = 'taskComments'")
      .get(),
  ).toBeNull();
  store.writeConversationMessages(
    id,
    [
      { _id: "first", timestamp: Infinity },
      { _id: "second", timestamp: 2 },
    ],
    undefined,
  );
  expect(await store.loadConversationMessages(id)).toMatchObject({
    latestTimestamp: 2,
  });
});

test("SQLite state for another current user does not enter the cache", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, authPrincipal);
  store.writePatches([patch("sessions"), patch("currentUser")], {
    ...sessionState,
    currentUser: { _id: "userB" },
  });
  expect(db.query("SELECT key FROM meta").all()).toEqual([]);
  expect(await store.loadCache(["sessions"])).toBeNull();
});

test.each([true, false])(
  "SQLite only resets an empty cache cursor fence for another account (boot=%s)",
  async (boot) => {
    using db = new Database(":memory:");
    const store = createSqliteCache(db, authPrincipal);
    db.exec(`CREATE TRIGGER fail_row BEFORE INSERT ON collection_rows
    BEGIN SELECT RAISE(ABORT, 'row failure'); END`);
    writeSessions(store);
    db.exec("DROP TRIGGER fail_row");
    if (boot) {
      expect(await store.loadCache(["sessions"])).toBeNull();
      store.writePatches([patch("syncMeta")], { syncMeta: { cursor: 1 } });
      expect(await store.loadCache(["syncMeta"])).toBeNull();
    }
    signIn("userB");
    if (boot) {
      await store.loadCache(["sessions"]);
      signIn(owner);
      await store.loadCache(["sessions"]);
    }
    store.writePatches([patch("sessions"), patch("syncMeta")], {
      ...sessionState,
      syncMeta: { cursor: 1 },
    });
    expect(await store.loadCache(["syncMeta"])).toEqual({
      syncMeta: { cursor: 1 },
    });
  },
);
