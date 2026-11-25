import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../__tests__/fixtures/signedInPrincipal";
import { expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { buildClientResourceReport } from "../../lib/telemetry/clientResourceReport";
import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../clientSyncRegistry";
import { loadCache } from "./bootLoader";
import { writePatchesToIDB } from "./collectionWriter";
import { _reopenForTests, COLLECTION_TABLES, db } from "./db";
import {
  dropPendingMessageWrites,
  flushConversationMessages,
  writeConversationMessages,
} from "./messageCache";
import { writeOwnerStamp } from "./ownership";
import { storageTimings } from "./storageTimings";

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
  const putRow = IDBObjectStore.prototype.put;
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
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
    writePatchesToIDB(
      [{ op: "add", path: ["sessions", row._id], value: row }],
      { sessions: { [row._id]: row } },
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
      expect(report.idb_boot_critical_ms?.sessions).toBe(400);
      expect(report.idb_boot_deferred_ms?.tasks).toBe(80);
      expect(report.idb_boot_deferred_ms).not.toHaveProperty("sessions");
      expect(report.idb_write_count?.put).toBe(1);
      expect(report.idb_write_p95_ms?.put).toBe(192);
      expect(report.idb_write_count?.collection_prepare).toBe(1);
      expect(JSON.stringify(report)).not.toContain(row._id);
      expect(JSON.stringify(report)).not.toContain(row.title);
    }

    writeConversationMessages(
      row._id,
      [{ _id: "message", timestamp: 1, content: row.title }],
      { initialized: true, hasMoreAbove: false },
    );
    flushConversationMessages();
    const messageRows = db.conversationMessageRows;
    const persisted = await db.transaction("r", messageRows, () =>
      messageRows.count(),
    );
    expect(persisted).toBe(1);
    expect(storageTimings.take().writeCount?.message_prepare).toBe(1);
  } finally {
    dropPendingMessageWrites();
    put.mockRestore();
    deferred.mockRestore();
    read.mockRestore();
    clock.mockRestore();
    storageTimings.take();
  }
});
