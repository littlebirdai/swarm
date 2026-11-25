import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Patch } from "mutative";
import { TEST_PRINCIPAL } from "../store/__tests__/fixtures/signedInPrincipal";
import { authPrincipal } from "../lib/authPrincipal";
import { _reopenForTests, db as dexie } from "../store/persistence/db";
import * as dexieStorage from "../store/persistence/dexie-storage";
import { flushLivenessWrites } from "../store/persistence/idb-liveness-lane";
import { flushConversationMessages } from "../store/persistence/message-cache";
import { createSqliteCache } from "../store/persistence/sqlite/cache-storage";
import {
  budgetTail,
  fixtureSizes,
  id,
  retainedRows,
} from "./store-budget-fixture";

const patch = (...path: string[]): Patch => ({
  op: "replace",
  path,
  value: null,
});
const storageKeys = Object.keys(fixtureSizes);
const convId = id(0);

async function measure(
  store: ReturnType<typeof createSqliteCache>,
  sync: () => Promise<void>,
) {
  await store.loadCache(storageKeys);
  const fixture = Object.fromEntries(
    Object.entries(fixtureSizes).map(([key, count]) => [
      key,
      Object.fromEntries(retainedRows(key, count).map((row) => [row._id, row])),
    ]),
  );
  store.writePatches(
    storageKeys.map((key) => patch(key)),
    fixture,
  );
  const tail = budgetTail();
  const pagination = { initialized: true, hasMoreAbove: false };
  store.writeConversationMessages(convId, tail, pagination);
  await sync();

  let started = performance.now();
  const boot = await store.loadCache(storageKeys);
  const bootReadMs = performance.now() - started;
  assert(boot);
  await sync();

  const renamed = Object.fromEntries(
    ["sessions", "conversations"].map((key) => [
      key,
      { ...boot[key], [convId]: { ...boot[key][convId], title: "Renamed" } },
    ]),
  );
  started = performance.now();
  store.writePatches(
    [
      patch("sessions", convId, "title"),
      patch("conversations", convId, "title"),
    ],
    renamed,
  );
  await sync();
  const patchMs = performance.now() - started;

  const last = tail[199];
  const edited = { ...last, content: "Updated" };
  const appended = { ...last, _id: "new-message", timestamp: 201 };
  started = performance.now();
  store.writeConversationMessages(
    convId,
    [...tail.slice(1, 199), edited, appended],
    pagination,
  );
  await sync();
  const streamedMs = performance.now() - started;
  const transcript = await store.loadConversationMessages(convId);
  assert.deepEqual(transcript?.messages.slice(-2), [edited, appended]);

  return {
    inputRows: Object.values(fixtureSizes).reduce(
      (sum, count) => sum + count,
      tail.length,
    ),
    inputBytes: Buffer.byteLength(JSON.stringify([fixture, tail])),
    bootRows: Object.values(boot).reduce(
      (sum, rows) => sum + Object.keys(rows).length,
      0,
    ),
    bootBytes: Buffer.byteLength(JSON.stringify(boot)),
    transcriptRows: transcript.messages.length,
    transcriptBytes: Buffer.byteLength(JSON.stringify(transcript.messages)),
    patchMs,
    streamedMs,
    bootReadMs,
  };
}

await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
assert.equal(authPrincipal.current(), TEST_PRINCIPAL);
using sqlite = new Database(":memory:");
try {
  const dexieResult = await measure(dexieStorage, async () => {
    flushLivenessWrites();
    flushConversationMessages();
    await dexie.transaction("r", dexie.tables, () => dexie.meta.count());
  });
  const sqliteCache = createSqliteCache(sqlite, authPrincipal);
  const sqliteResult = await measure(sqliteCache, sqliteCache.flushPersistence);
  console.log(
    JSON.stringify({ Dexie: dexieResult, SQLite: sqliteResult }, null, 2),
  );
} finally {
  dexie.close();
}
