import { expect, jest, spyOn, test } from "bun:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { pinDetailRows } from "../../lib/detail-rows";
import { replaceGlobals } from "../../test-helpers/globals";
import {
  MAX_DOC_DETAILS_ON_DISK,
  readCachedDocDetails,
} from "../doc-detail-disk";
import { __createInboxStoreForTests } from "../inboxStore";
import {
  lastPersisted,
  writePatchesToIDB,
} from "../persistence/collection-writer";
import { loadCache } from "../persistence/boot-loader";
import {
  enqueueDispatch,
  loadOutbox,
  removeDispatch,
} from "../persistence/outbox";
import { _reopenForTests, COLLECTION_TABLES, db } from "../persistence/db";
import { setHydrating } from "../persistence/hydration";
import { writeOwnerStamp } from "../persistence/ownership";
import {
  CACHE_SCHEMA_VERSION,
  SYSTEM_TABLES,
  WEB_COLLECTION_INDEXES,
} from "../persistence/schema";
import { startTimedDocRetention } from "../timed-doc-retention";

const docId = (n: number) => `j${String(n).padStart(31, "0")}`;
const detail = (n: number, now: number) => ({
  _id: docId(n),
  title: `Doc ${n}`,
  content: `Cached body ${n}`,
  workspace: "team:alpha",
  updated_at: now,
  _cachedAt: now,
});

async function openStore(indexedDB = new IDBFactory()) {
  await _reopenForTests({ indexedDB, IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  lastPersisted.clear();
  setHydrating(false);
}

test("the cache upgrade preserves bodies and lets a crawl read only document keys and workspaces", async () => {
  const indexedDB = new IDBFactory();
  const old = new Dexie(db.name, { indexedDB, IDBKeyRange });
  old
    .version(CACHE_SCHEMA_VERSION - 1)
    .stores({ ...WEB_COLLECTION_INDEXES, ...SYSTEM_TABLES, docDetails: "_id" });
  const first = detail(1, 1);
  const { workspace: _workspace, ...legacy } = detail(2, 1);
  try {
    await old.table("docDetails").bulkPut([first, legacy]);
  } finally {
    old.close();
  }
  await openStore(indexedDB);
  const table = COLLECTION_TABLES.docDetails;
  const loadBodies = spyOn(table, "toArray");
  try {
    expect(await readCachedDocDetails()).toEqual([
      { _id: first._id, workspace: first.workspace },
      { _id: legacy._id, workspace: undefined },
    ]);
    expect(loadBodies).not.toHaveBeenCalled();
    expect(await table.get(first._id)).toEqual(first);
  } finally {
    loadBodies.mockRestore();
    db.close();
  }
});

test("the host settles the disk cache and persistence metadata during a long replay", async () => {
  const beforeMetadata = process.env.VITE_CACHE_EVICTION_METADATA;
  const beforeCaps = process.env.VITE_TIMED_DOC_CAPS;
  process.env.VITE_CACHE_EVICTION_METADATA = "1";
  process.env.VITE_TIMED_DOC_CAPS = "1";
  const restore = replaceGlobals({
    document: Object.assign(new EventTarget(), { hidden: false }),
  });
  const store = __createInboxStoreForTests();
  const pin = docId(0);
  const pending = docId(1);
  const release = pinDetailRows("docDetails", [pin]);
  const table = COLLECTION_TABLES.docDetails;
  const keysOnDisk = () =>
    db.transaction("r", table, () => table.toCollection().primaryKeys());
  let diskOwner = false;
  await openStore();
  (store.getState() as any)._setIDBWrite(writePatchesToIDB);
  store.setState({
    pending: {
      [`docs:${pending}:title`]: { type: "field", value: "Draft", ts: 1 },
    },
  });
  jest.useFakeTimers();
  const sweep = startTimedDocRetention(
    store.getState,
    () => true,
    () => diskOwner,
  );
  try {
    const start = Date.now();
    store
      .getState()
      .syncTable("docDetails", [detail(0, 1), detail(1, 1)], { isDelta: true });
    for (let day = 0; day < 21; day++) {
      jest.setSystemTime(start + day * 86_400_000);
      const rows = Array.from({ length: 100 }, (_, i) =>
        detail(2 + day * 100 + i, Date.now() + i),
      );
      store.getState().syncTable("docDetails", rows, { isDelta: true });
      await keysOnDisk();
      if (day === 11) diskOwner = true;
      jest.advanceTimersByTime(301_000);
      const keys = await keysOnDisk();
      if (day === 10) expect(keys).toHaveLength(1102);
      if (diskOwner) {
        expect(keys).toHaveLength(MAX_DOC_DETAILS_ON_DISK);
        expect(lastPersisted.get("docDetails")?.size).toBe(
          MAX_DOC_DETAILS_ON_DISK,
        );
      }
    }
    const held = await keysOnDisk();
    expect(held).toContain(pin);
    expect(held).toContain(pending);
    expect(held).not.toContain(docId(2));
    expect(held).toContain(docId(2101));
  } finally {
    sweep.stop();
    jest.useRealTimers();
    release();
    db.close();
    lastPersisted.clear();
    restore();
    if (beforeMetadata === undefined)
      delete process.env.VITE_CACHE_EVICTION_METADATA;
    else process.env.VITE_CACHE_EVICTION_METADATA = beforeMetadata;
    if (beforeCaps === undefined) delete process.env.VITE_TIMED_DOC_CAPS;
    else process.env.VITE_TIMED_DOC_CAPS = beforeCaps;
  }
});

test("reloading a queued detail-only archive hides its cached body without a pending lock", async () => {
  const beforeMetadata = process.env.VITE_CACHE_EVICTION_METADATA;
  const beforeCaps = process.env.VITE_TIMED_DOC_CAPS;
  process.env.VITE_CACHE_EVICTION_METADATA = "1";
  process.env.VITE_TIMED_DOC_CAPS = "1";
  const indexedDB = new IDBFactory();
  const store = __createInboxStoreForTests();
  const runtime = store.getState();
  const response = Promise.withResolvers<null>();
  const journaled = Promise.withResolvers<void>();
  const archived = detail(1, Date.now());
  const unrelated = detail(2, Date.now());
  try {
    await openStore(indexedDB);
    await COLLECTION_TABLES.docDetails.bulkPut([archived, unrelated]);
    const cache = await loadCache(["docDetails", "pending"]);
    expect(cache?.docDetails[archived._id]?.content).toBe(archived.content);
    store.setState({ docDetails: cache?.docDetails });
    runtime._setIDBWrite(writePatchesToIDB);
    runtime._setOutbox(
      async (entry) => {
        await enqueueDispatch(entry);
        journaled.resolve();
      },
      removeDispatch,
      loadOutbox,
    );
    runtime._setDispatch(() => response.promise);
    void runtime.archiveDoc(archived._id);
    await journaled.promise;
    const [queued] = await loadOutbox();
    expect(queued?.action).toBe("archiveDoc");
    expect(queued?.locks).toBeUndefined();
    expect(store.getState().docDetails[archived._id]).toBeUndefined();

    runtime._clearRuntimeBindings();
    await _reopenForTests({ indexedDB, IDBKeyRange });
    const reloaded = await loadCache(["docDetails", "pending"]);
    expect(reloaded?.docDetails[archived._id]).toBeUndefined();
    expect(reloaded?.docDetails[unrelated._id]?.content).toBe(
      unrelated.content,
    );
    expect(reloaded?.pending ?? {}).toEqual({});
    expect((await db.meta.get("pending"))?.value ?? {}).toEqual({});

    await removeDispatch(queued.id);
    expect(
      (await loadCache(["docDetails"]))?.docDetails[archived._id]?.content,
    ).toBe(archived.content);
  } finally {
    runtime._clearRuntimeBindings();
    response.resolve(null);
    db.close();
    lastPersisted.clear();
    if (beforeMetadata === undefined)
      delete process.env.VITE_CACHE_EVICTION_METADATA;
    else process.env.VITE_CACHE_EVICTION_METADATA = beforeMetadata;
    if (beforeCaps === undefined) delete process.env.VITE_TIMED_DOC_CAPS;
    else process.env.VITE_TIMED_DOC_CAPS = beforeCaps;
  }
});
