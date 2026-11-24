import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { afterEach, beforeEach, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MESSAGE_PAGE_SIZE, persistedMessageTail } from "../cacheRetention";
import { _reopenForTests, db } from "../persistence/db";
import {
  dropPendingMessageWrites,
  flushConversationMessages,
  loadConversationMessages,
  writeConversationMessages,
} from "../persistence/messageCache";
import { writeOwnerStamp } from "../persistence/ownership";
import { SYSTEM_TABLES, WEB_COLLECTION_INDEXES } from "../persistence/schema";

const { conversationMessageRows: rows, conversationMessageMeta: meta, conversationUserMessages: navigatorRows } = db;
const convId = "stream";
const pagination = { initialized: true, hasMoreAbove: true, lastTimestamp: 2 };
const message = (n: number) => ({ _id: `m${n}`, timestamp: n, content: `message ${n}` });
let indexedDB: IDBFactory;
let writes: Array<{ table: string; type: string; count: number }> = [];

db.use({
  stack: "dbcore",
  create(core) {
    return {
      ...core,
      table(name) {
        const table = core.table(name);
        return {
          ...table,
          mutate(request) {
            if (name === rows.name || name === meta.name || name === navigatorRows.name) {
              if (request.type === "put" || request.type === "add") writes.push({ table: name, type: request.type, count: request.values.length });
              if (request.type === "delete") writes.push({ table: name, type: request.type, count: request.keys.length });
            }
            return table.mutate(request);
          },
        };
      },
    };
  },
});

const drain = () => db.transaction("r", [meta, rows, navigatorRows], () => meta.count());
async function persist(messages: ReturnType<typeof message>[]) {
  writeConversationMessages(convId, messages, pagination);
  flushConversationMessages();
  await drain();
}

beforeEach(async () => {
  dropPendingMessageWrites();
  indexedDB = new IDBFactory();
  await _reopenForTests({ indexedDB, IDBKeyRange });
  await writeOwnerStamp(TEST_PRINCIPAL, "confirmed");
  writes = [];
});

afterEach(() => db.close());

test("50 committed appends each put one message and delete only the overflowing row", async () => {
  const messages = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => message(i + 1));
  await persist(messages);
  writes = [];
  for (let i = 1; i <= 50; i++) await persist([...messages, ...Array.from({ length: i }, (_, j) => message(MESSAGE_PAGE_SIZE + j + 1))]);

  expect(writes.filter(({ table, type }) => table === rows.name && type === "put").map(({ count }) => count)).toEqual(Array(50).fill(1));
  expect(writes.filter(({ table, type }) => table === rows.name && type === "delete").map(({ count }) => count)).toEqual(Array(50).fill(1));
  expect(writes.filter(({ table }) => table === meta.name).map(({ count }) => count)).toEqual(Array(50).fill(1));
  expect(await rows.where("convId").equals(convId).count()).toBe(MESSAGE_PAGE_SIZE);
  expect(await rows.get([convId, "0:id:m50"])).toBeUndefined();
  expect((await loadConversationMessages(convId))?.messages[0]._id).toBe("m51");
});

test("an edit puts only that message, even when another connection changed its previous value", async () => {
  const messages = [message(1), message(2)];
  await persist(messages);
  const edited = { ...messages[1], content: "streamed edit" };
  writes = [];
  await persist([structuredClone(messages[0]), edited]);
  expect(writes).toEqual([{ table: rows.name, type: "put", count: 1 }]);

  const sibling = new Dexie(db.name, { indexedDB, IDBKeyRange });
  await sibling.open();
  try {
    await sibling.table(rows.name).put({ convId, messageKey: "0:id:m2", position: 1, revision: "another-writer", message: messages[1] });
  } finally {
    sibling.close();
  }
  writes = [];
  await persist([messages[0], edited]);
  expect(writes).toEqual([{ table: rows.name, type: "put", count: 1 }]);
  expect((await loadConversationMessages(convId))?.messages).toEqual([messages[0], edited]);
});

test("an append with the same latest timestamp writes no metadata", async () => {
  const first = message(1);
  const second = { ...message(2), timestamp: first.timestamp };
  await persist([first]);
  writes = [];
  await persist([first, second]);
  expect(writes).toEqual([{ table: rows.name, type: "put", count: 1 }]);
  expect((await loadConversationMessages(convId))?.messages).toEqual([first, second]);
});

test("disk reads match the previous tail format, including timestamp ties and input order", async () => {
  const messages = Array.from({ length: MESSAGE_PAGE_SIZE + 3 }, (_, i) => ({ ...message(i), timestamp: (i % 5) + 1 }));
  await persist(messages);
  dropPendingMessageWrites();
  const tail = persistedMessageTail(messages, pagination);
  expect(await loadConversationMessages(convId)).toEqual({ ...tail, latestTimestamp: 5, userMessages: undefined });
});

test("pruning removes an expired conversation's messages, metadata, and navigator rows", async () => {
  const expired = "expired";
  const fresh = "fresh";
  const now = Date.now();
  await meta.bulkPut([
    { convId: expired, pagination, latestTimestamp: 1 },
    { convId: fresh, pagination, latestTimestamp: now },
  ]);
  await rows.bulkPut([
    { convId: expired, messageKey: "0:id:m1", position: 0, revision: "a", message: message(1) },
    { convId: fresh, messageKey: "0:id:m2", position: 0, revision: "b", message: message(2) },
  ]);
  await navigatorRows.put({ convId: expired, userMessages: [message(1)] });

  await persist([{ ...message(3), timestamp: now }]);
  const deadline = performance.now() + 2_000;
  while (await meta.get(expired) && performance.now() < deadline) await Bun.sleep(5);
  expect(await meta.get(expired)).toBeUndefined();
  expect(await rows.where("convId").equals(expired).count()).toBe(0);
  expect(await navigatorRows.get(expired)).toBeUndefined();
  expect(await rows.where("convId").equals(fresh).count()).toBe(1);
});

test("a v112 upgrade drops old transcript and navigator data and preserves the pending-input journal", async () => {
  const indexedDB = new IDBFactory();
  const legacy = new Dexie(db.name, { indexedDB, IDBKeyRange });
  const { conversationMessageMeta: _, conversationMessageRows: __, ...unchanged } = SYSTEM_TABLES;
  legacy.version(112).stores({ ...WEB_COLLECTION_INDEXES, ...unchanged, conversationMessages: "convId, latestTimestamp" });
  await legacy.open();
  const pending = { key: `pendingInput:v1:${TEST_PRINCIPAL}:message`, value: { content: "unsent" } };
  await legacy.table("meta").put(pending);
  await legacy.table("conversationMessages").put({ convId, messages: [message(1)], pagination, latestTimestamp: 1 });
  await legacy.table("conversationUserMessages").put({ convId: "navigator-only", userMessages: [message(1)] });
  legacy.close();

  await _reopenForTests({ indexedDB, IDBKeyRange });
  expect(db.backendDB().objectStoreNames.contains("conversationMessages")).toBe(false);
  expect(await db.meta.get(pending.key)).toEqual(pending);
  expect(await rows.count()).toBe(0);
  expect(await meta.count()).toBe(0);
  expect(await navigatorRows.count()).toBe(0);
  expect(await loadConversationMessages(convId)).toBeNull();
});
