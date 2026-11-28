import { expect, spyOn, test } from "bun:test";
import {
  AUTH_JWT_STORAGE_KEY,
  issueFakeToken,
  mapStorage,
} from "./fixtures/fakeAuthToken";
import { authPrincipal } from "../../lib/authPrincipal";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MAX_CACHED_MY_SENDS } from "../cacheRetention";
import { loadCache } from "../persistence/boot-loader";
import { _reopenForTests, COLLECTION_TABLES, db } from "../persistence/db";
import { replaceGlobals } from "../../test-helpers/globals";
import { writePatchesToIDB, _resetPersistedShadow } from "../idb-cache";
import { setHydrating } from "../persistence/hydration";
import { _resetSnapshotLedger, noteSnapshotSync } from "../idb-collection-diff";
import { measureIndexedDB } from "../../perf/measure-indexeddb";

const TEST_PRINCIPAL = "indexed-boot-owner";

function installIndexedBootPrincipal() {
  const localStorage = mapStorage();
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken(TEST_PRINCIPAL));
  const restore = replaceGlobals({ document: {}, localStorage });
  authPrincipal.check();
  return () => {
    localStorage.removeItem(AUTH_JWT_STORAGE_KEY);
    authPrincipal.check();
    restore();
    authPrincipal.check();
  };
}

test("indexed send retention keeps the same boundary ties without reading older payloads", async () => {
  const enabled = process.env.VITE_DEFERRED_CACHE_BOOT === "1";
  const restore = installIndexedBootPrincipal();
  const { reads } = measureIndexedDB(db);
  const indexedDB = new IDBFactory();
  await _reopenForTests({ indexedDB, IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  const table = db.table("mySends");
  const rows = Array.from(
    { length: MAX_CACHED_MY_SENDS + 120 },
    (_, index) => ({
      _id: `send-${String(index).padStart(6, "0")}`,
      timestamp: index < 118 ? 0 : index < 122 ? 10 : index,
      content: `Message ${index}`,
    }),
  );
  try {
    await table.bulkPut(rows);
    const cache = await loadCache(["mySends"]);
    expect(Object.keys(cache?.mySends ?? {})).toHaveLength(MAX_CACHED_MY_SENDS);
    expect(
      Object.keys(cache!.mySends)
        .filter((id) => Number(id.slice(5)) < 122)
        .sort(),
    ).toEqual(["send-000118", "send-000119"]);
    expect(reads.get("mySends")).toBeLessThanOrEqual(
      enabled ? MAX_CACHED_MY_SENDS + 4 : rows.length,
    );
    expect(await table.count()).toBe(MAX_CACHED_MY_SENDS);
  } finally {
    db.close();
    restore();
  }
});

test("an older deferred snapshot does not erase the shadow of a newer durable row", async () => {
  const before = process.env.VITE_DEFERRED_CACHE_BOOT;
  process.env.VITE_DEFERRED_CACHE_BOOT = "1";
  const restore = installIndexedBootPrincipal();
  _resetPersistedShadow();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  setHydrating(false);
  const table = COLLECTION_TABLES.docDetails;
  const row = {
    _id: "j".repeat(32),
    title: "New doc",
    content: "Body",
    updated_at: Date.now(),
  };
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const list = table.toArray.bind(table);
  const stale = spyOn(table, "toArray").mockImplementation(async () => {
    const rows = await list();
    captured.resolve();
    await release.promise;
    return rows;
  });
  try {
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    const load = loadCache(["docDetails"]);
    await captured.promise;
    writePatchesToIDB(
      [{ op: "add", path: ["docDetails", row._id], value: row }],
      { docDetails: { [row._id]: row }, pending: {} },
    );
    expect(await db.transaction("r", table, () => table.get(row._id))).toEqual(
      row,
    );
    release.resolve();
    await load;
    noteSnapshotSync("docDetails", [], [row._id]);
    writePatchesToIDB([{ op: "replace", path: ["docDetails"], value: {} }], {
      docDetails: {},
      pending: {},
    });
    expect(
      await db.transaction("r", table, () => table.get(row._id)),
    ).toBeUndefined();
  } finally {
    release.resolve();
    stale.mockRestore();
    _resetPersistedShadow();
    _resetSnapshotLedger();
    db.close();
    restore();
    if (before === undefined) delete process.env.VITE_DEFERRED_CACHE_BOOT;
    else process.env.VITE_DEFERRED_CACHE_BOOT = before;
  }
});
