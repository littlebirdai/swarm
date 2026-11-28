import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../__tests__/fixtures/signedInPrincipal";
import { CODECAST_EVENTS } from "@codecast/analytics";
import { validateEvent } from "@platform/analytics/catalog";
import { expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { buildClientResourceReport } from "../../lib/telemetry/client-resource-report";
import { cacheStorage } from "../idb-cache";
import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../clientSyncRegistry";
import { _reopenForTests, db } from "./db";
import { setHydrating } from "./hydration";
import { loadOutbox } from "./outbox";
import { writeOwnerStamp } from "./ownership";
import { loadPendingInput } from "./pendingInputJournal";
import { storageTimings, timeBootRead } from "./storage-timings";

test("reports slow critical and deferred reads and a slow synchronous write", async () => {
  installSignedInPrincipal();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  storageTimings.take();

  const bulkGetMeta = db.meta.bulkGet.bind(db.meta);
  const putRow = IDBObjectStore.prototype.put;
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const readMeta = spyOn(db.meta, "bulkGet").mockImplementation(
    async (keys) => {
      const rows = await bulkGetMeta(keys);
      now += 20;
      return rows;
    },
  );
  const readOutbox = spyOn(db.dispatchOutbox, "toArray").mockImplementation(
    async () => {
      now += 80;
      return [];
    },
  );
  const put = spyOn(IDBObjectStore.prototype, "put").mockImplementation(
    function (this: IDBObjectStore, ...args: Parameters<typeof putRow>) {
      const request = putRow.apply(this, args);
      if (this.name === "dispatchOutbox") {
        now += 180;
        request.addEventListener("success", () => {
          now += 1000;
        });
      }
      return request;
    },
  );
  try {
    setHydrating(true);
    await timeBootRead("critical", "meta", () =>
      db.meta.bulkGet(["cacheOwner"]),
    );
    await loadOutbox();
    await cacheStorage.enqueueDispatch({
      id: "timing-outbox",
      action: "sendMessage",
      args: ["conv-1", "hello"],
      ts: 1,
      patches: [],
      result: null,
    });
    const timings = storageTimings.take();
    for (const platform of ["web", "desktop"] as const) {
      const report = buildClientResourceReport({
        platform,
        windowRole: "app",
        syncRole: "host",
        collections: [],
        storageTimings: timings,
      });
      expect(report.idb_boot_critical_ms!.meta).toBeGreaterThanOrEqual(20);
      expect(
        report.idb_boot_deferred_ms!.dispatchOutbox,
      ).toBeGreaterThanOrEqual(80);
      expect(report.idb_write_count?.put).toBe(1);
      expect(report.idb_write_p95_ms?.put).toBe(192);
      expect(
        validateEvent(CODECAST_EVENTS, "client_resource_report", report).ok,
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain("conv-1");
    }
  } finally {
    setHydrating(false);
    put.mockRestore();
    readOutbox.mockRestore();
    readMeta.mockRestore();
    clock.mockRestore();
    storageTimings.take();
    db.close();
  }
});

test("untimed reads return the original promise", async () => {
  const result = Promise.resolve(1);
  expect(timeBootRead(undefined, "meta", () => result)).toBe(result);
  expect(await result).toBe(1);
});

test("records pending input and first outbox scan per boot", async () => {
  installSignedInPrincipal();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  storageTimings.take();
  setHydrating(true);
  try {
    await timeBootRead("critical", "pendingInput", () =>
      loadPendingInput(TEST_PRINCIPAL),
    );
    await cacheStorage.loadCache(HYDRATION_CRITICAL_READ_KEYS);
    const timings = storageTimings.take();
    expect(timings.criticalBootMs).toHaveProperty("pendingInput");
    setHydrating(false);
    await loadOutbox();
    expect(storageTimings.take().deferredBootMs).toHaveProperty(
      "dispatchOutbox",
    );
    await loadOutbox();
    expect(storageTimings.take()).toEqual({});

    setHydrating(true);
    await cacheStorage.loadCache(HYDRATION_DEFERRED_KEYS);
    await loadOutbox();
    expect(storageTimings.take().deferredBootMs).toHaveProperty(
      "dispatchOutbox",
    );
  } finally {
    setHydrating(false);
    storageTimings.take();
    db.close();
  }
});
