import { expect, spyOn, test } from "bun:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { COLLECTION_INDEXES } from "../clientSyncRegistry";
import { _reopenForTests, db } from "../persistence/db";
import { SYSTEM_TABLES } from "../persistence/schema";

const rows = [
  { _id: "conversation", title: "Local title", is_favorite: true },
  { _id: "optimistic-stub", session_id: "client-session" },
];
const pending = { "conversations:conversation:title": { type: "field", value: "Local title" } };

async function legacyDatabase() {
  const indexedDB = new IDBFactory();
  const legacy = new Dexie(db.name, { indexedDB, IDBKeyRange });
  legacy.version(111).stores({ ...COLLECTION_INDEXES, ...SYSTEM_TABLES });
  await legacy.meta.bulkPut([
    { key: "conversations", value: Object.fromEntries(rows.map((row) => [row._id, row])) },
    { key: "pending", value: pending },
  ]);
  legacy.close();
  return { indexedDB, legacy };
}

test("upgrades the legacy map to rows and keeps the pending locks", async () => {
  const { indexedDB } = await legacyDatabase();
  await _reopenForTests({ indexedDB, IDBKeyRange });

  expect(await db.table("conversations").toArray()).toEqual(rows);
  expect(await db.meta.get("conversations")).toBeUndefined();
  expect((await db.meta.get("pending"))?.value).toEqual(pending);
});

test("aborting after the row puts rolls back the upgrade and allows an exact retry", async () => {
  const { indexedDB, legacy } = await legacyDatabase();
  let interrupted = false;
  const remove = IDBObjectStore.prototype.delete;
  const abort = spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    const request = remove.call(this, key);
    if (this.name === "meta" && key === "conversations") {
      interrupted = true;
      this.transaction.abort();
    }
    return request;
  });
  try {
    const error = await _reopenForTests({ indexedDB, IDBKeyRange }).catch((error) => error);
    expect(error).toHaveProperty("name", "AbortError");
    expect(interrupted).toBe(true);
  } finally {
    abort.mockRestore();
  }

  await legacy.open();
  expect(legacy.tables.map((table) => table.name)).not.toContain("conversations");
  expect(Object.values((await legacy.meta.get("conversations")).value)).toEqual(rows);
  legacy.close();

  await _reopenForTests({ indexedDB, IDBKeyRange });
  expect(await db.table("conversations").toArray()).toEqual(rows);
  expect(await db.meta.get("conversations")).toBeUndefined();
});
