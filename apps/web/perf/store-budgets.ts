import assert from "node:assert/strict";
import type { ReplicationChannel } from "@platform/engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TEST_PRINCIPAL } from "../store/__tests__/fixtures/signedInPrincipal";
import { COLLECTION_RETENTION } from "../store/cacheRetention";
import { REGISTERED_COLLECTION_KEYS } from "../store/clientSyncRegistry";
import { useInboxStore } from "../store/inboxStore";
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
  fixtureSizes,
  id,
  now,
  retainedRows,
  session,
} from "./store-budget-fixture";
import { checkStoreBudget } from "./store-budget-limits";

const state = useInboxStore.getState;

function measureMessages() {
  for (let conversation = 0; conversation < 420; conversation++) {
    state().setMessages(
      id(conversation),
      budgetMessages(conversation),
      undefined,
      "cache",
    );
  }
  const messages = state().messages;
  assert.equal(messages[id(419)]?.length, 200);
  checkStoreBudget(
    "Cached conversation message rows",
    Object.values(messages).reduce((n, rows) => n + rows.length, 0),
  );
  checkStoreBudget(
    "Cached conversation message bytes",
    Buffer.byteLength(JSON.stringify(messages)),
  );
}

async function measureRetention() {
  assert.deepEqual(
    Object.keys(fixtureSizes).sort(),
    [...Object.keys(COLLECTION_RETENTION), "sessions", "conversations"].sort(),
  );
  for (const [key, size] of Object.entries(fixtureSizes)) {
    await COLLECTION_TABLES[key].bulkPut(retainedRows(key, size));
  }
  const retained = await loadCache(Object.keys(fixtureSizes));
  assert(retained);
  for (const key of Object.keys(
    fixtureSizes,
  ) as (keyof typeof fixtureSizes)[]) {
    checkStoreBudget(
      `Retained ${key}`,
      Object.keys(retained[key] ?? {}).length,
    );
  }
}

async function measureWrites(writes: Map<string, number>) {
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
  checkStoreBudget("Streamed batch row writes", sumRows(writes));

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
  state()._setIDBWrite(writePatchesToIDB);
  state()._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);
  writes.clear();

  state().renameSession(convId, "Renamed");
  const saved = await db.transaction(
    "r",
    sessions,
    conversations,
    db.meta,
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
  checkStoreBudget("Rename action row writes", sumRows(writes));
  state()._setIDBWrite(null);
}

function sumRows(counts: Map<string, number>) {
  return [...counts.values()].reduce((sum, rows) => sum + rows, 0);
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
  const follower = replicationFollowerFor("follower", channel, (ready) => {
    if (ready) synced.resolve();
  });
  try {
    await synced.promise;
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
checkStoreBudget("Pull request list bytes", bytes.pullRequests);
measureMessages();

const { writes } = measureIndexedDB(db);
await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
try {
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  await measureWrites(writes);
  await measureRetention();
} finally {
  db.close();
}
