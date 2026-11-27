import assert from "node:assert/strict";
import type { ReplicationChannel } from "@platform/engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TEST_PRINCIPAL } from "../store/__tests__/fixtures/signedInPrincipal";
import { COLLECTION_RETENTION } from "../store/cacheRetention";
import { REGISTERED_COLLECTION_KEYS } from "../store/clientSyncRegistry";
import { deployDetailRows } from "../hooks/useDeployDetail";
import { applyCollectionFeed } from "../hooks/useSyncCollection";
import { clearProtectedInboxMemory, useInboxStore } from "../store/inboxStore";
import { resetDetailPins } from "../lib/detail-rows";
import { loadCache } from "../store/persistence/boot-loader";
import { writePatchesToIDB } from "../store/persistence/collection-writer";
import {
  _reopenForTests,
  COLLECTION_TABLES,
  db,
} from "../store/persistence/db";
import { flushConversationMessages } from "../store/persistence/message-cache";
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
  for (const [key, size] of Object.entries(fixtureSizes)) {
    const rows =
      key === "docDetails"
        ? calibratedDocDetailRows(size)
        : retainedRows(key, size);
    await COLLECTION_TABLES[key].bulkPut(rows);
  }
  await COLLECTION_TABLES.docs.bulkPut(calibratedDocRows(1000));
  const retained = await loadCache([...Object.keys(fixtureSizes), "docs"]);
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
  state().syncTable("sessions", calibratedSessionRows(1200), { isDelta: true });
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
  checkStoreBudget("Conversation meta bytes", jsonBytes(state().conversations));
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
}

async function measureWrites({
  writes,
  writtenBytes,
}: ReturnType<typeof measureIndexedDB>) {
  const convId = id(0);
  const tail = budgetTail();
  const messageRows = db.conversationMessageRows;
  state().setMessages(convId, tail, { initialized: true, hasMoreAbove: false });
  flushConversationMessages();
  await db.transaction("r", messageRows, () => messageRows.count());
  writes.clear();

  const edited = { ...tail[199], content: "Updated" };
  const appended = { ...tail[199], _id: "new-message", timestamp: 201 };
  state().applyTailMessages(convId, 199, [edited, appended], 201);
  flushConversationMessages();
  const committed = await db.transaction("r", messageRows, () =>
    messageRows.where("convId").equals(convId).sortBy("position"),
  );
  assert.equal(committed.length, 200);
  assert.deepEqual(
    committed.slice(-2).map((row) => row.message),
    [edited, appended],
  );
  checkStoreBudget("Streamed batch row writes", sum(writes));

  const { sessions, conversations } = COLLECTION_TABLES;
  const cachedSessions = Array.from({ length: 500 }, (_, index) =>
    session(index),
  );
  await Promise.all([
    sessions.bulkPut(cachedSessions),
    conversations.bulkPut(cachedSessions),
  ]);
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
  const saved = await db.transaction(
    "r",
    sessions,
    conversations,
    db.meta,
    db.pendingEntries,
    db.dispatchOutbox,
    async () =>
      Promise.all([
        sessions.get(convId),
        conversations.get(convId),
        db.dispatchOutbox.toArray(),
      ]),
  );
  assert.equal(saved[0]?.title, "Renamed");
  assert.equal(saved[1]?.title, "Renamed");
  assert.equal(saved[2][0]?.action, "renameSession");
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
try {
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  await measureWrites(measurement);
  await measureRetention();
} finally {
  db.close();
}
