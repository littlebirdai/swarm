import { expect, test } from "bun:test";
import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MAX_CACHED_MY_SENDS } from "../cacheRetention";
import { loadCache } from "../persistence/boot-loader";
import { _reopenForTests, db } from "../persistence/db";
import { replaceGlobals } from "../../test-helpers/globals";
import { measureIndexedDB } from "../../perf/measure-indexeddb";

test("indexed send retention keeps the same boundary ties without reading older payloads", async () => {
  const enabled = process.env.VITE_DEFERRED_CACHE_BOOT === "1";
  const restore = replaceGlobals({ document: {} });
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
