import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../__tests__/fixtures/signedInPrincipal";
import { CODECAST_EVENTS } from "@codecast/analytics";
import { validateEvent } from "@platform/analytics/catalog";
import { expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { buildClientResourceReport } from "../../lib/telemetry/client-resource-report";
import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../clientSyncRegistry";
import { loadCache } from "./boot-loader";
import { writePatchesToIDB } from "./collection-writer";
import { _reopenForTests, COLLECTION_TABLES, db } from "./db";
import { setHydrating } from "./hydration";
import {
  dropPendingMessageWrites,
  flushConversationMessages,
  loadConversationMessages,
  writeConversationMessages,
} from "./message-cache";
import { loadOutbox } from "./outbox";
import { writeOwnerStamp } from "./ownership";
import { storageTimings, timeBootRead } from "./storage-timings";

test("reports slow critical and deferred reads and a slow synchronous write", async () => {
  installSignedInPrincipal();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  storageTimings.take();

  const sessions = COLLECTION_TABLES.sessions;
  const tasks = COLLECTION_TABLES.tasks;
  const readSessions = sessions.toArray.bind(sessions);
  const readTasks = tasks.toArray.bind(tasks);
  const bulkGetMeta = db.meta.bulkGet.bind(db.meta);
  const getMeta = db.conversationMessageMeta.get.bind(
    db.conversationMessageMeta,
  );
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
  const read = spyOn(sessions, "toArray").mockImplementation(async () => {
    const rows = await readSessions();
    now += 400;
    return rows;
  });
  const deferred = spyOn(tasks, "toArray").mockImplementation(async () => {
    const rows = await readTasks();
    now += 80;
    return rows;
  });
  const put = spyOn(IDBObjectStore.prototype, "put").mockImplementation(
    function (this: IDBObjectStore, ...args: Parameters<typeof putRow>) {
      const request = putRow.apply(this, args);
      if (this.name === "sessions") {
        now += 180;
        request.addEventListener("success", () => {
          now += 1000;
        });
      }
      return request;
    },
  );
  try {
    await loadCache(HYDRATION_CRITICAL_READ_KEYS);
    await loadCache(HYDRATION_DEFERRED_KEYS);
    const row = { _id: "private-row-id", title: "someone@example.test" };
    const collection = new Proxy(
      { [row._id]: row },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === row._id) now += 3;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    writePatchesToIDB(
      [{ op: "add", path: ["sessions", row._id], value: row }],
      { sessions: collection },
    );
    expect(
      await db.transaction("r", sessions, () => sessions.get(row._id)),
    ).toEqual(row);
    const timings = storageTimings.take();
    for (const platform of ["web", "desktop"] as const) {
      const report = buildClientResourceReport({
        platform,
        windowRole: "app",
        syncRole: "host",
        collections: [],
        storageTimings: timings,
      });
      expect(report.idb_boot_critical_ms!.sessions).toBeGreaterThanOrEqual(400);
      expect(report.idb_boot_critical_ms!.meta).toBeGreaterThanOrEqual(20);
      expect(report.idb_boot_deferred_ms!.tasks).toBeGreaterThanOrEqual(80);
      expect(report.idb_boot_deferred_ms!.meta).toBeGreaterThanOrEqual(20);
      expect(report.idb_boot_deferred_ms).not.toHaveProperty("sessions");
      expect(report.idb_write_count?.put).toBe(1);
      expect(report.idb_write_p95_ms?.put).toBe(192);
      expect(report.idb_write_count?.collection_prepare).toBe(1);
      expect(report.idb_write_p50_ms?.collection_prepare).toBe(3);
      expect(report.idb_write_p95_ms?.collection_prepare).toBe(3);
      expect(
        validateEvent(CODECAST_EVENTS, "client_resource_report", report).ok,
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain(row._id);
      expect(JSON.stringify(report)).not.toContain(row.title);
    }

    const message = { _id: "message", timestamp: 1, content: row.title };
    const metaread = spyOn(
      db.conversationMessageMeta,
      "get",
    ).mockImplementation(async (key) => {
      const data = await getMeta(key);
      now += 800;
      return data;
    });
    const messageRows = db.conversationMessageRows;
    const pagination = { initialized: true, hasMoreAbove: false };
    const timedMessage = {
      get timestamp() {
        now += 6;
        Object.defineProperty(this, "timestamp", { value: message.timestamp });
        return message.timestamp;
      },
      get _id() {
        now += 12;
        Object.defineProperty(this, "_id", { value: message._id });
        return message._id;
      },
      content: message.content,
    };
    try {
      for (const [snapshot, nextPagination, writes] of [
        [timedMessage, pagination, 1],
        [message, pagination, undefined],
        [message, { ...pagination, hasMoreAbove: true }, 1],
      ] as const) {
        writeConversationMessages(row._id, [snapshot], nextPagination);
        flushConversationMessages();
        expect(
          await db.transaction("r", messageRows, () => messageRows.count()),
        ).toBe(1);
        const timings = storageTimings.take();
        expect(timings.writeCount?.message_prepare).toBe(writes);
        if (snapshot === timedMessage) {
          expect(timings.writeP50Ms?.message_prepare).toBe(24);
          expect(timings.writeP95Ms?.message_prepare).toBe(24);
        }
      }
    } finally {
      metaread.mockRestore();
    }
  } finally {
    dropPendingMessageWrites();
    put.mockRestore();
    deferred.mockRestore();
    readMeta.mockRestore();
    read.mockRestore();
    clock.mockRestore();
    storageTimings.take();
  }
});

test("untimed reads return the original promise", async () => {
  const result = Promise.resolve(1);
  expect(timeBootRead(undefined, "meta", () => result)).toBe(result);
  expect(await result).toBe(1);
});

test("records pending input, first outbox scan, and first critical conversation reads", async () => {
  installSignedInPrincipal();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  const convId = "fixture";
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  await db.conversationMessageMeta.put({
    convId,
    pagination: undefined,
    latestTimestamp: 1,
  });
  storageTimings.take();
  setHydrating(true);
  try {
    await loadCache(HYDRATION_CRITICAL_READ_KEYS);
    await loadConversationMessages(convId);
    const timings = storageTimings.take();
    expect(Object.keys(timings.criticalBootMs ?? {})).toEqual(
      expect.arrayContaining([
        "pendingInput",
        "conversationUserMessages",
        "conversationMessageMeta",
        "conversationMessageRows",
      ]),
    );
    await loadConversationMessages(convId);
    expect(storageTimings.take()).toEqual({});
    setHydrating(false);
    await loadOutbox();
    expect(storageTimings.take().deferredBootMs).toHaveProperty(
      "dispatchOutbox",
    );
    await loadOutbox();
    await loadConversationMessages(convId);
    expect(storageTimings.take()).toEqual({});

    setHydrating(true);
    await loadCache(HYDRATION_DEFERRED_KEYS);
    await loadConversationMessages(convId);
    expect(storageTimings.take().criticalBootMs).toBeUndefined();
    await loadOutbox();
    expect(storageTimings.take().deferredBootMs).toHaveProperty(
      "dispatchOutbox",
    );
  } finally {
    setHydrating(false);
    storageTimings.take();
  }
});
