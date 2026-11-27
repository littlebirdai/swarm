import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { loadCache } from "../persistence/boot-loader";
import { expect, spyOn, test } from "bun:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { db, _reopenForTests } from "../persistence/db";
import { SYSTEM_TABLES, WEB_COLLECTION_INDEXES } from "../persistence/schema";

test("v113 pending locks survive an aborted upgrade and migrate exactly on retry", async () => {
  const indexedDB = new IDBFactory();
  const legacy = new Dexie(db.name, { indexedDB, IDBKeyRange });
  const { pendingEntries: _, ...oldTables } = SYSTEM_TABLES;
  legacy.version(113).stores({ ...WEB_COLLECTION_INDEXES, ...oldTables });
  const pending = {
    "docs:first:title": { type: "field", value: "local", ts: 1 },
    "docs:second": { type: "exclude", ts: 2 },
  };
  try {
    await legacy.table("meta").bulkPut([
      { key: "pending", value: pending },
      { key: "currentUser", value: { _id: TEST_PRINCIPAL } },
    ]);
    legacy.close();
    const remove = IDBObjectStore.prototype.delete;
    const abort = spyOn(IDBObjectStore.prototype, "delete").mockImplementation(
      function (this: IDBObjectStore, key) {
        const request = remove.call(this, key);
        if (this.name === "meta" && key === "pending") this.transaction.abort();
        return request;
      },
    );
    try {
      const error = await _reopenForTests({ indexedDB, IDBKeyRange }).catch(
        (error) => error,
      );
      expect(error).toHaveProperty("name", "AbortError");
    } finally {
      abort.mockRestore();
    }
    await legacy.open();
    expect(await legacy.table("meta").get("pending")).toEqual({
      key: "pending",
      value: pending,
    });
    legacy.close();
    await _reopenForTests({ indexedDB, IDBKeyRange });
    expect(await db.meta.get("pending")).toBeUndefined();
    expect(await db.pendingEntries.toArray()).toEqual(
      Object.entries(pending).map(([key, value]) => ({ key, value })),
    );
    expect((await loadCache(["pending"]))?.pending).toEqual(
      Object.fromEntries(
        Object.entries(pending).filter(([key]) => key !== "docs:second"),
      ),
    );
  } finally {
    legacy.close();
    db.close();
  }
});
