import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, test } from "bun:test";
import Dexie from "dexie";
import { _reopenForTests, loadCache, RETIRED_META_KEYS, setHydrating } from "../idbCache";
import { META_KEYS } from "../persistence/schema";

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
setHydrating(false);

const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;

// A meta key the registry dropped was read by nothing and deleted by nothing:
// the desktop app still held a 12 MB `messages` blob months after it retired.
test("a boot drops retired meta values, including a conversation blob from an old bundle", async () => {
  const row = { _id: "c1", title: "Current title" };
  await db().conversations.put(row);
  await db().meta.bulkPut([
    { key: "messages", value: { c1: [{ _id: "m1" }] } },
    { key: "teamUnreadCount", value: 3 },
    { key: "drafts", value: { c1: "half a thought" } },
    { key: "conversations", value: { c1: { ...row, title: "Old bundle title" } } },
  ]);
  const cache = await loadCache(["drafts", "conversations"]);
  await Bun.sleep(50);
  expect(await db().meta.get("messages")).toBeUndefined();
  expect(await db().meta.get("teamUnreadCount")).toBeUndefined();
  expect((await db().meta.get("drafts"))?.value).toEqual({ c1: "half a thought" });
  expect(await db().meta.get("conversations")).toBeUndefined();
  expect(cache?.conversations).toEqual({ c1: row });
  expect(await db().conversations.toArray()).toEqual([row]);
});

test("no retired key is still written to web meta", () => {
  expect(RETIRED_META_KEYS.filter((key) => META_KEYS.has(key))).toEqual([]);
});
