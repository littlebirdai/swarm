import "./fixtures/signedInPrincipal";
import { beforeEach, expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Patch } from "mutative";
import { followerPersistencePatches } from "../followerPersistence";
import { MAX_CACHED_SESSIONS } from "../cacheRetention";
import { noteSnapshotSync } from "../idbCollectionDiff";
import { loadCache } from "../persistence/bootLoader";
import {
  resetCollectionWrites,
  writePatchesToIDB,
} from "../persistence/collectionWriter";
import { _reopenForTests, COLLECTION_TABLES, db } from "../persistence/db";

const id = (n: number) => `k${String(n).padStart(31, "0")}`;
const table = COLLECTION_TABLES.conversations;

beforeEach(async () => {
  resetCollectionWrites();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: "userA" } });
});

test("one patched conversation puts exactly one row", async () => {
  const rows = [
    { _id: id(1), title: "first", updated_at: Date.now() },
    { _id: id(2), title: "second", updated_at: Date.now() },
  ];
  await table.bulkPut(rows);
  const cached = await loadCache(["conversations"]);
  const changed = { ...rows[0], title: "renamed" };
  const puts = spyOn(table, "bulkPut");
  try {
    const conversations = { ...cached?.conversations, [id(1)]: changed };
    writePatchesToIDB(
      [
        {
          op: "replace",
          path: ["conversations", id(1), "title"],
          value: changed.title,
        },
      ],
      { conversations, pending: {} },
    );
    await Bun.sleep(30);
    expect(await table.toArray()).toEqual([changed, rows[1]]);
    expect(puts.mock.calls.map(([values]) => values)).toEqual([[changed]]);
    expect(await db.meta.get("conversations")).toBeUndefined();
  } finally {
    puts.mockRestore();
  }
});

test("boot hydrates retained rows and leaves disk cleanup to a host write", async () => {
  const old = Date.now() - 365 * 86_400_000;
  const expired = { _id: id(1), updated_at: old };
  const live = { _id: id(2), updated_at: old };
  const focused = { _id: id(3), updated_at: old };
  const pinned = { _id: id(4), updated_at: old, is_pinned: true };
  const fresh = { _id: id(5), updated_at: Date.now() };
  const refreshedElsewhere = { _id: id(6), updated_at: old };
  const stub = { _id: "optimistic-stub", updated_at: old };
  await table.bulkPut([
    expired,
    live,
    focused,
    pinned,
    fresh,
    refreshedElsewhere,
    stub,
  ]);
  await db.meta.bulkPut([
    { key: "liveInboxIdList", value: [live._id] },
    { key: "lastFocusedConversationId", value: focused._id },
  ]);
  const cached = await loadCache([
    "conversations",
    "liveInboxIdList",
    "lastFocusedConversationId",
  ]);
  expect(cached?.conversations).toEqual(
    Object.fromEntries(
      [live, focused, pinned, fresh, stub].map((row) => [row._id, row]),
    ),
  );

  const patches: Patch[] = [
    { op: "replace", path: ["conversations"], value: {} },
  ];
  const shrunk = {
    ...cached?.conversations,
    [fresh._id]: { ...fresh, title: "new" },
  };
  delete shrunk[live._id];
  const state = { ...cached, conversations: shrunk, pending: {} };
  writePatchesToIDB(followerPersistencePatches(patches), state);
  expect(await table.toArray()).toEqual([
    expired,
    live,
    focused,
    pinned,
    fresh,
    refreshedElsewhere,
    stub,
  ]);

  const refreshed = { ...refreshedElsewhere, updated_at: Date.now() };
  await table.put(refreshed);
  writePatchesToIDB(patches, state);
  await Bun.sleep(30);
  expect(await table.toArray()).toEqual([
    live,
    focused,
    pinned,
    shrunk[fresh._id],
    refreshed,
    stub,
  ]);

  writePatchesToIDB([{ op: "remove", path: ["conversations", live._id] }], {
    ...state,
    pending: { [`conversations:${live._id}`]: { type: "exclude" } },
  });
  await Bun.sleep(30);
  expect(await table.get(live._id)).toBeUndefined();
});

test("an ownerless cache cannot claim conversation rows", async () => {
  await db.meta.delete("currentUser");
  await table.put({ _id: id(1), updated_at: Date.now() });

  expect(await loadCache(["conversations"])).toBeNull();
  expect(await table.count()).toBe(0);
});

test("an authoritative snapshot can delete a conversation row", async () => {
  const gone = { _id: id(1), updated_at: Date.now() };
  const kept = { _id: id(2), updated_at: Date.now() };
  await table.bulkPut([gone, kept]);
  const cached = await loadCache(["conversations"]);
  const conversations = {
    [kept._id]: { ...cached?.conversations[kept._id], title: "updated" },
  };

  noteSnapshotSync("conversations", [kept._id], [gone._id]);
  writePatchesToIDB(
    [
      {
        op: "add",
        path: ["conversations", kept._id, "title"],
        value: "updated",
      },
    ],
    { conversations, pending: {} },
  );
  await Bun.sleep(30);
  expect(await table.toArray()).toEqual([conversations[kept._id]]);
});

test("deferred retention reads only boot drop IDs and still applies the cap", async () => {
  const now = Date.now();
  const old = { _id: id(0), updated_at: now - 60_000 };
  const retained = Array.from({ length: MAX_CACHED_SESSIONS }, (_, i) => ({
    _id: id(i + 1),
    updated_at: now,
  }));
  await table.bulkPut([old, ...retained]);
  const cached = await loadCache(["conversations"]);
  expect(cached?.conversations[old._id]).toBeUndefined();

  const bulkGet = spyOn(table, "bulkGet");
  const scan = spyOn(table, "toArray");
  try {
    writePatchesToIDB(
      [
        {
          op: "replace",
          path: ["conversations"],
          value: cached?.conversations,
        },
      ],
      { ...cached, pending: {} },
    );
    await Bun.sleep(30);
    expect(bulkGet.mock.calls).toEqual([[[old._id]]]);
    expect(scan).not.toHaveBeenCalled();
  } finally {
    bulkGet.mockRestore();
    scan.mockRestore();
  }
  expect(await table.get(old._id)).toBeUndefined();
  expect(await table.count()).toBe(retained.length);
});
