import assert from "node:assert/strict";
import { replaceGlobals } from "../test-helpers/globals";
import { createTestDom } from "../test-helpers/testDom";
import { measureIndexedDB } from "./measure-indexeddb";
import { checkStoreBudget } from "./store-budget-limits";

const { dom } = createTestDom("https://codecast.test/inbox");
replaceGlobals({ dispatchEvent: dom.window.dispatchEvent.bind(dom.window) });
const { TEST_PRINCIPAL } =
  await import("../store/__tests__/fixtures/signedInPrincipal");
const { COLLECTION_TABLES, db } = await import("../store/persistence/db");
const { writeOwnerStamp } = await import("../store/persistence/ownership");
const { storageTimings } = await import("../store/persistence/storage-timings");
const { reads } = measureIndexedDB(db);
const reportTiming = process.env.PERF_CACHE_BOOT_SAMPLE === "1";
const now = Date.now();
const sessions = Array.from({ length: 1300 }, (_, i) => ({
  _id: `j${String(i).padStart(31, "0")}`,
  session_id: `session-${i}`,
  title: "Budget session",
  updated_at: now - i,
}));
const [focus, ...rest] = sessions;
const alternate = rest[0];
const liveInboxIdList = [focus._id, alternate._id];

await db.open();
for (const [key, table] of Object.entries(COLLECTION_TABLES)) {
  if (key === "sessions" || key === "conversations") {
    await table.bulkPut(sessions);
  } else if (reportTiming && key === "docDetails") {
    await table.bulkPut(
      Array.from({ length: 200 }, (_, i) => ({
        _id: `j${String(i).padStart(31, "0")}`,
        title: "Cached doc",
        content: `${i} ${"Cached body ".repeat(1_365)}`,
        _cachedAt: now - i,
      })),
    );
  } else if (reportTiming && key === "mySends") {
    await table.bulkPut(
      Array.from({ length: 8000 }, (_, i) => ({
        _id: `send-${i}`,
        timestamp: now - i,
        content: `Cached message ${i}`,
      })),
    );
  } else {
    await table.put({ _id: key, short_id: "ct-1", _cachedAt: now });
  }
}
await db.meta.bulkPut([
  { key: "currentUser", value: { _id: TEST_PRINCIPAL } },
  { key: "liveInboxIdList", value: liveInboxIdList },
  { key: "lastFocusedConversationId", value: focus._id },
]);
await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
for (const { _id: convId } of [focus, alternate]) {
  await db.conversationMessageMeta.put({
    convId,
    pagination: { initialized: true, hasMoreAbove: false },
    latestTimestamp: 200,
  });
  await db.conversationUserMessages.put({ convId, userMessages: [] });
  await db.conversationMessageRows.bulkPut(
    Array.from({ length: 200 }, (_, position) => ({
      convId,
      messageKey: `message-${position}`,
      position,
      revision: "fixture",
      message: {
        _id: `message-${position}`,
        role: "assistant",
        content: "Cached message",
        timestamp: position + 1,
      },
    })),
  );
}

reads.clear();
const bootStarted = performance.now();
const { useInboxStore } = await import("../store/inboxStore");
const firstPaint = Promise.withResolvers<{
  groups: string[];
  reads: Map<string, number>;
  paintMs: number;
}>();
const unsubscribe = useInboxStore.subscribe((state, before) => {
  if (!state.clientStateInitialized || before.clientStateInitialized) return;
  firstPaint.resolve({
    groups: Object.keys(storageTimings.take().criticalBootMs ?? {}),
    reads: new Map(reads),
    paintMs: performance.now() - bootStarted,
  });
});
try {
  const sample = await firstPaint.promise;
  const state = useInboxStore.getState();
  assert.equal(state.currentSessionId, focus._id);
  assert.equal(state.messages[focus._id]?.length, 200);
  for (const group of [
    "sessions",
    "meta",
    "pendingInput",
    "conversationUserMessages",
    "conversationMessageMeta",
    "conversationMessageRows",
  ]) {
    assert(
      sample.groups.includes(group),
      `First paint read group missing: ${group}`,
    );
  }
  if (reportTiming) {
    const hydration = await import("../store/persistence/hydration");
    while (hydration._hydrating) await Bun.sleep(1);
    console.log(
      JSON.stringify({
        firstPaintMs: sample.paintMs,
        bootMs: performance.now() - bootStarted,
        readRows: [...reads.values()].reduce((sum, rows) => sum + rows, 0),
      }),
    );
  }
  checkStoreBudget("First paint read groups", sample.groups.length);
  checkStoreBudget("First paint IndexedDB tables", sample.reads.size);
  checkStoreBudget(
    "First paint IndexedDB rows",
    [...sample.reads.values()].reduce((sum, rows) => sum + rows, 0),
  );
} finally {
  unsubscribe();
}
