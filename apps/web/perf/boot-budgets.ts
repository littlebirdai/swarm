import assert from "node:assert/strict";
import { replaceGlobals } from "../test-helpers/globals";
import { createTestDom } from "../test-helpers/testDom";
import { measureIndexedDB } from "./measure-indexeddb";
import { checkStoreBudget } from "./store-budget-limits";

const { dom } = createTestDom("https://codecast.test/inbox");
replaceGlobals({ dispatchEvent: dom.window.dispatchEvent.bind(dom.window) });
const { installSignedInPrincipal, TEST_PRINCIPAL } =
  await import("../store/__tests__/fixtures/signedInPrincipal");
installSignedInPrincipal(TEST_PRINCIPAL);
const { db } = await import("../store/persistence/db");
const { writeOwnerStamp } = await import("../store/persistence/ownership");
const { WEB_COLLECTION_INDEXES } = await import("../store/clientSyncRegistry");
const { cacheStorage } = await import("../store/idb-cache");
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
await db.meta.bulkPut([
  { key: "currentUser", value: { _id: TEST_PRINCIPAL } },
  { key: "liveInboxIdList", value: liveInboxIdList },
  { key: "lastFocusedConversationId", value: focus._id },
]);
await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
const seedState: Record<string, any> = {
  currentUser: { _id: TEST_PRINCIPAL },
  liveInboxIdList,
  lastFocusedConversationId: focus._id,
};
for (const key of Object.keys(WEB_COLLECTION_INDEXES)) {
  if (key === "sessions" || key === "conversations") {
    seedState[key] = Object.fromEntries(sessions.map((row) => [row._id, row]));
  } else if (reportTiming && key === "docDetails") {
    const docs = Array.from({ length: 200 }, (_, i) => ({
      _id: `j${String(i).padStart(31, "0")}`,
      title: "Cached doc",
      content: `${i} ${"Cached body ".repeat(1_365)}`,
      _cachedAt: now - i,
    }));
    seedState[key] = Object.fromEntries(docs.map((row) => [row._id, row]));
  } else if (reportTiming && key === "mySends") {
    const sends = Array.from({ length: 8000 }, (_, i) => ({
      _id: `send-${i}`,
      timestamp: now - i,
      content: `Cached message ${i}`,
    }));
    seedState[key] = Object.fromEntries(sends.map((row) => [row._id, row]));
  } else {
    seedState[key] = { [key]: { _id: key, short_id: "ct-1", _cachedAt: now } };
  }
}
cacheStorage.setHydrating(false);
cacheStorage.writePatches(
  [
    ...Object.keys(WEB_COLLECTION_INDEXES).map((key) => ({
      op: "replace" as const,
      path: [key],
      value: seedState[key],
    })),
    {
      op: "replace" as const,
      path: ["liveInboxIdList"],
      value: liveInboxIdList,
    },
    {
      op: "replace" as const,
      path: ["lastFocusedConversationId"],
      value: focus._id,
    },
  ],
  seedState,
);
for (const { _id: convId } of [focus, alternate]) {
  cacheStorage.writeConversationUserMessages(convId, []);
  cacheStorage.writeConversationMessages(
    convId,
    Array.from({ length: 200 }, (_, position) => ({
      _id: `message-${position}`,
      role: "assistant",
      content: "Cached message",
      timestamp: position + 1,
    })),
    { initialized: true, hasMoreAbove: false },
  );
}
await cacheStorage.flushPersistence();

reads.clear();
const bootStarted = performance.now();
const { useInboxStore } = await import("../store/inboxStore");
const firstPaint = Promise.withResolvers<{
  reads: Map<string, number>;
  paintMs: number;
}>();
const timeout = setTimeout(
  () =>
    firstPaint.reject(
      new Error("Boot budget timed out waiting for first paint"),
    ),
  15_000,
);
const unsubscribe = useInboxStore.subscribe((state, before) => {
  if (!state.clientStateInitialized || before.clientStateInitialized) return;
  firstPaint.resolve({
    reads: new Map(reads),
    paintMs: performance.now() - bootStarted,
  });
});
try {
  const sample = await firstPaint.promise;
  clearTimeout(timeout);
  const state = useInboxStore.getState();
  assert.equal(state.currentSessionId, focus._id);
  assert.equal(state.messages[focus._id]?.length, 200);
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
  checkStoreBudget("First paint IndexedDB tables", sample.reads.size);
  checkStoreBudget(
    "First paint IndexedDB rows",
    [...sample.reads.values()].reduce((sum, rows) => sum + rows, 0),
  );
} finally {
  clearTimeout(timeout);
  unsubscribe();
}
