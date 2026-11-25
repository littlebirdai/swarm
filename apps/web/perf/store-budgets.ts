import assert from "node:assert/strict";
import type { ReplicationChannel } from "@platform/engine";
import { heapStats } from "bun:jsc";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TEST_PRINCIPAL } from "../store/__tests__/fixtures/signedInPrincipal";
import { COLLECTION_RETENTION } from "../store/cacheRetention";
import { REGISTERED_COLLECTION_KEYS } from "../store/clientSyncRegistry";
import { DESKTOP_WINDOW_KEYS } from "../store/desktop-window-keys";
import {
  clearProtectedInboxMemory,
  useInboxStore,
  type Message,
} from "../store/inboxStore";
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
import { checkStoreBudget } from "./store-budget-limits";

const state = useInboxStore.getState;
const id = (index: number) => `j${String(index).padStart(31, "0")}`;
const now = Date.now();
const session = (index: number) => ({
  _id: id(index),
  session_id: `session-${index}`,
  title: "Budget session",
  updated_at: now - index,
});

function measureMessages() {
  for (let conversation = 0; conversation < 420; conversation++) {
    const messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
      _id: `message-${index}`,
      timestamp: index + 1,
      role: "assistant",
      content: `Résumé ${conversation} ${index} ${"word ".repeat(16)}`,
      ...(index === 100
        ? { images: [{ data: "a".repeat(4096), mediaType: "image/png" }] }
        : {}),
    }));
    state().setMessages(id(conversation), messages, undefined, "cache");
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
  const fixtureSizes = {
    sessions: 1300,
    conversations: 1300,
    docDetails: 220,
    taskComments: 1600,
    pullRequestDetails: 24,
    deployReach: 320,
    runGraphs: 60,
    deployDetails: 70,
    externalEvents: 2100,
    settingsData: 2,
    mySends: 10100,
  } as const;
  assert.deepEqual(
    Object.keys(fixtureSizes).sort(),
    [...Object.keys(COLLECTION_RETENTION), "sessions", "conversations"].sort(),
  );
  for (const [key, size] of Object.entries(fixtureSizes)) {
    const rows = Array.from({ length: size }, (_, index) => ({
      ...session(index),
      _cachedAt: now - index,
      timestamp: now - index,
      ...(key === "taskComments" ? { comments: [] } : {}),
      ...(key === "settingsData"
        ? { _id: index === 0 ? "team:preferences" : "team:teamMembers" }
        : {}),
    }));
    await COLLECTION_TABLES[key].bulkPut(rows);
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
  const tail: Message[] = Array.from({ length: 200 }, (_, index) => ({
    _id: `message-${index}`,
    timestamp: index + 1,
    role: "assistant",
    content: `Message ${index}`,
  }));
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

async function measureFollower(heldKeys?: readonly string[], rowsPerKey = 1) {
  const keys = [...REGISTERED_COLLECTION_KEYS, "conversations"];
  const hostState = Object.fromEntries(
    keys.map((key, index) => [
      key,
      Object.fromEntries(
        Array.from({ length: rowsPerKey }, (_, rowIndex) => {
          const row = {
            ...session(index * rowsPerKey + rowIndex),
            short_id: "ct-1",
            _cachedAt: now,
            ...(rowsPerKey > 1
              ? { title: crypto.randomUUID().repeat(10) }
              : {}),
            ...(key === "taskComments" ? { comments: [] } : {}),
          };
          return [row._id, row];
        }),
      ),
    ]),
  );
  const listeners = new Set<Parameters<ReplicationChannel["onMessage"]>[0]>();
  let bytes = 0;
  const channel: ReplicationChannel = {
    post(message) {
      if (message.type === "snapshotChunk")
        bytes += Buffer.byteLength(JSON.stringify(message));
      for (const listener of listeners) listener(structuredClone(message));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  clearProtectedInboxMemory();
  const host = replicationHostFor("host", channel, () => hostState);
  const synced = Promise.withResolvers<void>();
  useInboxStore.setState({ syncRole: "follower" });
  const receiver: ReplicationChannel = {
    post: (message) =>
      channel.post(
        heldKeys && message.type === "hello"
          ? { ...message, ...{ keys: heldKeys } }
          : message,
      ),
    onMessage: channel.onMessage,
  };
  Bun.gc(true);
  const initialHeap = heapStats().heapSize;
  const follower = replicationFollowerFor(
    "follower",
    receiver,
    (ready) => {
      if (ready) synced.resolve();
    },
    heldKeys,
  );
  try {
    await synced.promise;
    const held = Object.entries(state()).filter(
      ([key, value]) => key in hostState && Object.keys(value ?? {}).length > 0,
    );
    Bun.gc(true);
    return {
      collections: held.length,
      bytes,
      heapBytes: heapStats().heapSize - initialHeap,
    };
  } finally {
    follower.stop();
    host.stop();
  }
}

async function measureDesktopCache(keys?: readonly string[]) {
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  try {
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
    const tables = Object.entries(COLLECTION_TABLES);
    await db.transaction(
      "rw",
      tables.map(([, table]) => table),
      async () => {
        for (const [index, [, table]] of tables.entries())
          await table.bulkPut(
            Array.from({ length: 80 }, (_, rowIndex) => ({
              ...session(index * 80 + rowIndex),
              short_id: "ct-1",
              title: crypto.randomUUID().repeat(10),
              _cachedAt: now,
            })),
          );
      },
    );
    Bun.gc(true);
    const initialHeap = heapStats().heapSize;
    const loaded = await loadCache(keys);
    Bun.gc(true);
    return {
      collections: tables.filter(
        ([key]) => Object.keys(loaded?.[key] ?? {}).length > 0,
      ).length,
      heapBytes: heapStats().heapSize - initialHeap,
    };
  } finally {
    db.close();
  }
}

if (process.argv.includes("--desktop-windows")) {
  for (const kind of ["full", ...Object.keys(DESKTOP_WINDOW_KEYS)]) {
    for (const mode of ["call-ring", "meeting-offer", "share-cursors"].includes(
      kind,
    )
      ? ["cache"]
      : ["join", "cache"]) {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, "--desktop-window", kind, mode],
        { stdout: "inherit", stderr: "inherit" },
      );
      assert.equal(await child.exited, 0);
    }
  }
  process.exit(0);
}

const windowArg = process.argv.indexOf("--desktop-window");
if (windowArg !== -1) {
  const kind = process.argv[windowArg + 1] as
    | keyof typeof DESKTOP_WINDOW_KEYS
    | "full";
  const mode = process.argv[windowArg + 2];
  const keys = kind === "full" ? undefined : DESKTOP_WINDOW_KEYS[kind];
  console.log(
    kind,
    mode,
    mode === "cache"
      ? await measureDesktopCache(keys)
      : await measureFollower(keys, 80),
  );
  process.exit(0);
}

const fullFollower = await measureFollower();
checkStoreBudget("Follower populated collections", fullFollower.collections);
const smallFollower = await measureFollower(DESKTOP_WINDOW_KEYS.palette);
checkStoreBudget(
  "Palette follower populated collections",
  smallFollower.collections,
);
checkStoreBudget("Palette follower join bytes", smallFollower.bytes);
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
