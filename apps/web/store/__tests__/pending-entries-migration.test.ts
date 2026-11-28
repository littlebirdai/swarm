import "fake-indexeddb/auto";
import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "./fixtures/signedInPrincipal";
import { authPrincipal } from "../../lib/authPrincipal";
import { AUTH_JWT_STORAGE_KEY } from "./fixtures/fakeAuthToken";
import { cacheStorage } from "../idb-cache";
import { expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { db, _reopenForTests } from "../persistence/db";
import { SYSTEM_TABLES } from "../persistence/schema";

test("an IndexedDB cache from an older schema opens empty", async () => {
  const indexedDB = new IDBFactory();
  const legacy = new Dexie(db.name, { indexedDB, IDBKeyRange });
  legacy.version(115).stores({ ...SYSTEM_TABLES, sessions: "_id" });
  try {
    await legacy.table("meta").bulkPut([
      {
        key: "pending",
        value: { "docs:first:title": { type: "field", value: "local", ts: 1 } },
      },
      { key: "currentUser", value: { _id: TEST_PRINCIPAL } },
      {
        key: "cacheOwner",
        value: { principal: TEST_PRINCIPAL, at: 1, reason: "seed" },
      },
    ]);
    await legacy.table("pendingEntries").put({
      key: "docs:second",
      value: { type: "exclude", ts: 2 },
    });
    await legacy.table("dispatchOutbox").put({
      id: "old-dispatch",
      action: "renameSession",
      args: [],
      ts: 1,
    });
    await legacy.table("sessions").put({ _id: "old-session" });
    legacy.close();

    await _reopenForTests({ indexedDB, IDBKeyRange });
    expect(db.tables.map((table) => table.name).sort()).toEqual(
      Object.keys(SYSTEM_TABLES).sort(),
    );
    for (const table of db.tables) expect(await table.count()).toBe(0);
  } finally {
    legacy.close();
    db.close();
  }
});

test("a second account purges pending locks left by a stale window after sign-out", async () => {
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  try {
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    await cacheStorage.loadCache(["pending"]);
    localStorage.removeItem(AUTH_JWT_STORAGE_KEY);
    authPrincipal.check();
    expect(await authPrincipal.resolve()).toBeNull();
    await cacheStorage.loadCache(["pending"]);
    expect((await db.meta.get("cacheOwner"))?.value.principal).toBeNull();
    await db.pendingEntries.put({
      key: "docs:shared:title",
      value: { type: "field", ts: Date.now(), value: "First account's edit" },
    });
    installSignedInPrincipal("userB");
    authPrincipal.check();
    expect(await authPrincipal.resolve()).toBe("userB");
    expect(
      (await cacheStorage.loadCache(["pending"]))?.pending,
    ).toBeUndefined();
    expect(await db.pendingEntries.count()).toBe(0);
    expect(
      (await cacheStorage.loadCache(["pending"]))?.pending,
    ).toBeUndefined();
  } finally {
    installSignedInPrincipal();
    authPrincipal.check();
    await cacheStorage.loadCache(["pending"]);
    db.close();
  }
});
