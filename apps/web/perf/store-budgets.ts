import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import type { ReplicationChannel } from "@platform/engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../store/__tests__/fixtures/signedInPrincipal";
import { COLLECTION_RETENTION } from "../store/cacheRetention";
import { REGISTERED_COLLECTION_KEYS } from "../store/clientSyncRegistry";
import { deployDetailRows } from "../hooks/useDeployDetail";
import { applyCollectionFeed } from "../hooks/useSyncCollection";
import { clearProtectedInboxMemory, useInboxStore } from "../store/inboxStore";
import { resetDetailPins } from "../lib/detail-rows";
import { authPrincipal } from "../lib/authPrincipal";
import { cacheStorage, loadCache, writePatchesToIDB } from "../store/idb-cache";
import { _reopenForTests, db } from "../store/persistence/db";
import { createSqliteCache } from "../store/persistence/sqlite/cache-storage";
import {
  enqueueDispatch,
  loadOutbox,
  removeDispatch,
} from "../store/persistence/outbox";
import { writeOwnerStamp } from "../store/persistence/ownership";
import {
  replicationFollowerFor,
  replicationHostFor,
} from "../store/sync-replication";
import { measureDetailRows } from "./detail-rows-size";
import { measureIndexedDB } from "./measure-indexeddb";
import {
  budgetMessages,
  budgetTail,
  calibratedConversationRows,
  calibratedDeployDetailRows,
  calibratedDeployReachRows,
  calibratedDocDetailRows,
  calibratedDocRows,
  calibratedExternalEventRows,
  calibratedMySendRows,
  calibratedRunGraphRows,
  calibratedSessionRows,
  calibratedSettingsDataRows,
  fixtureSizes,
  id,
  now,
  retainedRows,
  session,
} from "./store-budget-fixture";
import { checkStoreBudget } from "./store-budget-limits";

const state = useInboxStore.getState;

function measureMessages() {
  clearProtectedInboxMemory();
  assert.deepEqual(state().messages, {});
  for (let conversation = 0; conversation < 400; conversation++) {
    state().setMessages(
      id(conversation),
      budgetMessages(conversation),
      undefined,
      "cache",
    );
  }
  const { messages, userMessages } = state();
  checkStoreBudget(
    "Cached conversation message JSON bytes",
    Buffer.byteLength(JSON.stringify({ messages, userMessages })),
  );
  assert.equal(messages[id(399)]?.length, 250);
  assert.equal(messages[id(0)], undefined);
  assert.equal(messages[id(399)][100].images?.[0].data, undefined);
  checkStoreBudget(
    "Cached conversation message rows",
    Object.values(messages).reduce((n, rows) => n + rows.length, 0),
  );
  checkStoreBudget(
    "Cached conversation message bytes",
    state().messageCacheBytes,
  );
}

async function measureRetention() {
  assert.deepEqual(
    Object.keys(fixtureSizes).sort(),
    [...Object.keys(COLLECTION_RETENTION), "sessions", "conversations"].sort(),
  );
  const seedState: Record<string, any> = {
    currentUser: { _id: TEST_PRINCIPAL },
  };
  for (const [key, size] of Object.entries(fixtureSizes)) {
    const rows =
      key === "docDetails"
        ? calibratedDocDetailRows(size)
        : retainedRows(key, size);
    seedState[key] = Object.fromEntries(rows.map((row) => [row._id, row]));
  }
  seedState.docs = Object.fromEntries(
    calibratedDocRows(1000).map((row) => [row._id, row]),
  );
  const sqliteDb = new Database(":memory:");
  try {
    const sqlite = createSqliteCache(sqliteDb, authPrincipal);
    await sqlite.loadCache([]);
    sqlite.setHydrating(false);
    sqlite.writePatches(
      Object.keys(seedState)
        .filter((key) => key !== "currentUser")
        .map((key) => ({ op: "replace", path: [key], value: seedState[key] })),
      seedState,
    );
    const retained = await sqlite.loadCache([
      ...Object.keys(fixtureSizes),
      "docs",
    ]);
    assert(retained);
    for (const key of Object.keys(
      fixtureSizes,
    ) as (keyof typeof fixtureSizes)[]) {
      checkStoreBudget(
        `Retained ${key}`,
        Object.keys(retained[key] ?? {}).length,
      );
    }
    const jsonBytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value ?? {}));
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      externalEvents: {},
      mySends: {},
      deployReach: {},
      runGraphs: {},
      deployDetails: {},
      settingsData: {},
      pending: {},
    } as any);
    resetDetailPins();
    state().syncTable("sessions", calibratedSessionRows(1200), {
      isDelta: true,
    });
    state().syncTable("conversations", calibratedConversationRows(1200), {
      isDelta: true,
    });
    state().syncTable("externalEvents", calibratedExternalEventRows(2000));
    state().syncTable("mySends", calibratedMySendRows(10000));
    state().syncTable("deployReach", calibratedDeployReachRows(320));
    state().syncTable("runGraphs", calibratedRunGraphRows(60));
    for (const row of calibratedDeployDetailRows(70)) {
      applyCollectionFeed("deployDetails", row, deployDetailRows);
    }
    state().syncTable("settingsData", calibratedSettingsDataRows());
    checkStoreBudget("Session list bytes", jsonBytes(state().sessions));
    checkStoreBudget(
      "Conversation meta bytes",
      jsonBytes(state().conversations),
    );
    checkStoreBudget("Doc list bytes", jsonBytes(retained.docs));
    checkStoreBudget("Doc detail bytes", jsonBytes(retained.docDetails));
    checkStoreBudget(
      "External event list bytes",
      jsonBytes(state().externalEvents),
    );
    checkStoreBudget("My sends list bytes", jsonBytes(state().mySends));
    checkStoreBudget("Deploy reach bytes", jsonBytes(state().deployReach));
    checkStoreBudget("Run graph bytes", jsonBytes(state().runGraphs));
    checkStoreBudget("Deploy detail bytes", jsonBytes(state().deployDetails));
    checkStoreBudget("Settings data bytes", jsonBytes(state().settingsData));
  } finally {
    sqliteDb.close();
  }
}

async function measureWrites({
  writes,
  writtenBytes,
}: ReturnType<typeof measureIndexedDB>) {
  const convId = id(0);
  const tail = budgetTail();
  const sqliteDb = new Database(":memory:");
  try {
    const sqlite = createSqliteCache(sqliteDb, authPrincipal);
    await sqlite.loadCache([]);
    sqlite.setHydrating(false);
    cacheStorage.setHydrating(false);

    state().setMessages(convId, tail, {
      initialized: true,
      hasMoreAbove: false,
    });
    sqlite.writeConversationMessages(convId, tail, {
      initialized: true,
      hasMoreAbove: false,
    });
    await cacheStorage.flushPersistence();
    const totalChanges = sqliteDb.prepare<{ n: number }>(
      "SELECT total_changes() AS n",
    );
    const changesBefore = totalChanges.get()!.n;

    const edited = { ...tail[199], content: "Updated" };
    const appended = { ...tail[199], _id: "new-message", timestamp: 201 };
    state().applyTailMessages(convId, 199, [edited, appended], 201);
    const updatedMessages = state().messages[convId];
    const updatedPagination = state().pagination[convId];
    sqlite.writeConversationMessages(
      convId,
      updatedMessages,
      updatedPagination,
    );
    await cacheStorage.flushPersistence();
    const sqliteRowWrites = totalChanges.get()!.n - changesBefore;
    const committed = await sqlite.loadConversationMessages(convId);
    assert.equal(committed?.messages.length, 200);
    assert.deepEqual(committed?.messages.slice(-2), [edited, appended]);
    const cacheCommitted = await cacheStorage.loadConversationMessages(convId);
    assert.equal(cacheCommitted?.messages.length, 200);
    checkStoreBudget("Streamed batch row writes", sqliteRowWrites);
  } finally {
    sqliteDb.close();
  }

  const cachedSessions = Array.from({ length: 500 }, (_, index) =>
    session(index),
  );
  const sessionMap = Object.fromEntries(cachedSessions.map((s) => [s._id, s]));
  cacheStorage.writePatches(
    [
      { op: "replace", path: ["sessions"], value: sessionMap },
      { op: "replace", path: ["conversations"], value: sessionMap },
    ],
    {
      currentUser: { _id: TEST_PRINCIPAL },
      sessions: sessionMap,
      conversations: sessionMap,
    },
  );
  await cacheStorage.flushPersistence();
  const cached = await loadCache(["sessions", "conversations"]);
  assert(cached);
  state().syncTable("sessions", Object.values(cached.sessions), {
    isDelta: false,
  });
  state().syncTable("conversations", Object.values(cached.conversations), {
    isDelta: false,
  });
  const pending = Object.fromEntries(
    Array.from({ length: 400 }, (_, index) => [
      `sessions:${id(index + 1)}:title`,
      { type: "field" as const, value: `Queued rename ${index + 1}`, ts: now },
    ]),
  );
  useInboxStore.setState({ pending });
  await writePatchesToIDB(
    [{ op: "replace", path: ["pending"], value: pending }],
    state(),
  );
  const cachedPending = await loadCache(["pending"]);
  assert.deepEqual(cachedPending?.pending, pending);
  state()._setIDBWrite(writePatchesToIDB);
  state()._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);
  writes.clear();
  writtenBytes.clear();

  state().renameSession(convId, "Renamed");
  await cacheStorage.flushPersistence();
  const savedCache = await loadCache(["sessions", "conversations"]);
  const savedOutbox = await db.dispatchOutbox.toArray();
  assert.equal(savedCache?.sessions?.[convId]?.title, "Renamed");
  assert.equal(savedCache?.conversations?.[convId]?.title, "Renamed");
  assert.equal(savedOutbox[0]?.action, "renameSession");
  checkStoreBudget("Rename action row writes", sum(writes));
  checkStoreBudget(
    "Rename action write bytes with pending entries",
    sum(writtenBytes),
  );
  state()._setIDBWrite(null);
}

function sum(counts: Map<string, number>) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

async function measureFollower() {
  const keys = [...REGISTERED_COLLECTION_KEYS, "conversations"];
  const hostState = Object.fromEntries(
    keys.map((key, index) => {
      const row = {
        ...session(index),
        short_id: "ct-1",
        _cachedAt: now,
        ...(key === "taskComments" ? { comments: [] } : {}),
      };
      return [key, { [row._id]: row }];
    }),
  );
  const listeners = new Set<Parameters<ReplicationChannel["onMessage"]>[0]>();
  const channel: ReplicationChannel = {
    post(message) {
      for (const listener of listeners) listener(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const host = replicationHostFor("host", channel, () => hostState);
  const synced = Promise.withResolvers<void>();
  useInboxStore.setState({ syncRole: "follower" });
  const local = [{ _id: "local-message", role: "user", timestamp: 1 }];
  state().setMessages(id(400), local, undefined, "cache");
  const follower = replicationFollowerFor("follower", channel, (ready) => {
    if (ready) synced.resolve();
  });
  try {
    await synced.promise;
    assert.deepEqual(state().messages[id(400)], local);
    const held = Object.entries(state()).filter(
      ([key, value]) => key in hostState && Object.keys(value ?? {}).length > 0,
    );
    checkStoreBudget("Follower populated collections", held.length);
  } finally {
    follower.stop();
    host.stop();
  }
}

await measureFollower();
useInboxStore.setState({ syncRole: "host" });
const bytes = measureDetailRows();
checkStoreBudget("Task list bytes", bytes.tasks);
checkStoreBudget("Task comment detail bytes", bytes.taskComments);
checkStoreBudget("Pull request list bytes", bytes.pullRequests);
checkStoreBudget("Pull request detail bytes", bytes.pullRequestDetails);
measureMessages();

const measurement = measureIndexedDB(db, true);
await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
installSignedInPrincipal(TEST_PRINCIPAL);
try {
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  await measureWrites(measurement);
  await measureRetention();
} finally {
  db.close();
}
