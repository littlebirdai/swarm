import { expect } from "bun:test";
import "fake-indexeddb/auto";

const {
  AUTH_JWT_STORAGE_KEY,
  issueFakeToken: issue,
  mapStorage,
} = await import("./fakeAuthToken");
const local = mapStorage();
(globalThis as any).localStorage = local;

const { default: Dexie } = await import("dexie");
const { SYSTEM_TABLES } = await import("../../persistence/schema");

const scenario = process.env.SCENARIO!;
if (scenario === "unparsable-token-at-boot")
  local.setItem(AUTH_JWT_STORAGE_KEY, "not.a.jwt");
else if (
  ![
    "signed-out-residue",
    "durable-only-token",
    "durable-read-fails",
    "durable-token-unparsable",
  ].includes(scenario)
)
  local.setItem(AUTH_JWT_STORAGE_KEY, issue("userA"));
if (scenario === "durable-read-fails") {
  const open = indexedDB.open.bind(indexedDB);
  (indexedDB as any).open = (name: string, version?: number) => {
    if (name === "codecast-auth") throw new Error("IndexedDB open failed");
    return version === undefined ? open(name) : open(name, version);
  };
}
const cache = await import("../../idb-cache");
const {
  CACHE_SCHEMA_VERSION,
  loadCache,
  loadOutbox,
  _cacheOwnerForTests,
  enqueueDispatch,
  writePatchesToIDB,
} = cache;
const { readCacheEvents } = await import("../../cache-events");
const ROW = {
  _id: "a".repeat(32),
  session_id: "sess",
  updated_at: Date.now(),
  title: "cached row",
};
const PENDING_KEY = `sessions:${ROW._id}`;
const PENDING_VAL = { type: "include", ts: Date.now() };

async function seed(opts: {
  owner?: string | null;
  stamp?: string | null;
  rows?: boolean;
  outbox?: boolean;
  pendingFor?: string;
}) {
  const db = new Dexie("codecast-store");
  db.version(CACHE_SCHEMA_VERSION).stores(SYSTEM_TABLES);
  await db.open();
  if (opts.owner !== undefined)
    await db.table("meta").put({
      key: "currentUser",
      value: opts.owner ? { _id: opts.owner, email: "x@y" } : null,
    });
  if (opts.stamp !== undefined)
    await db.table("meta").put({
      key: "cacheOwner",
      value: { principal: opts.stamp, at: 1, reason: "seed" },
    });
  if (opts.rows) {
    await db.table("pendingEntries").put({
      key: PENDING_KEY,
      value: PENDING_VAL,
    });
    await db
      .table("meta")
      .put({ key: "clientState", value: { ui: { theme: "dark" } } });
  }
  if (opts.outbox)
    await db.table("dispatchOutbox").put({
      id: "o1",
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts: 1,
    });
  if (opts.pendingFor) {
    await db.table("meta").put({
      key: `pendingInput:v1:${opts.pendingFor}:m1`,
      value: {
        id: "m1",
        conversationId: "c1",
        message: {
          _id: "m1",
          role: "user",
          content: "typed but unsent",
          timestamp: 1,
        },
        stamps: {},
      },
    });
  }
  db.close();
}
async function seedDurableToken(principalId: string, raw?: string) {
  const req = indexedDB.open("codecast-auth", 1);
  await new Promise<void>((resolve, reject) => {
    req.onupgradeneeded = () => req.result.createObjectStore("tokens");
    req.onsuccess = () => {
      const tx = req.result.transaction("tokens", "readwrite");
      tx.objectStore("tokens").put(
        raw ?? issue(principalId),
        AUTH_JWT_STORAGE_KEY,
      );
      tx.oncomplete = () => {
        req.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}
async function diskRows() {
  const db = new Dexie("codecast-store");
  if (!(await Dexie.exists("codecast-store")))
    return { pending: 0, meta: 0, outbox: 0 };
  await db.open();
  const has = (name: string) => db.tables.some((t) => t.name === name);
  const out = {
    pending: has("pendingEntries")
      ? await db.table("pendingEntries").count()
      : 0,
    meta: has("meta")
      ? await db
          .table("meta")
          .filter((row: any) => row.key !== "cacheOwner")
          .count()
      : 0,
    outbox: has("dispatchOutbox")
      ? await db.table("dispatchOutbox").count()
      : 0,
  };
  db.close();
  return out;
}
async function ownerStamp(): Promise<string | null | undefined> {
  if (!(await Dexie.exists("codecast-store"))) return undefined;
  const db = new Dexie("codecast-store");
  await db.open();
  const row = db.tables.some((t) => t.name === "meta")
    ? await db.table("meta").get("cacheOwner")
    : undefined;
  db.close();
  return row === undefined ? undefined : (row.value?.principal ?? null);
}
let restoreReads: (() => void) | null = null;
const purges = () =>
  readCacheEvents()
    .filter((e) => e.kind === "purge")
    .map((e) => e.detail.reason);

if (scenario === "fresh") {
} else if (scenario === "known-owner") {
  await seed({ owner: "userA", rows: true, outbox: true });
} else if (scenario === "legacy-unknown-owner") {
  await seed({ rows: true, outbox: true });
} else if (scenario === "foreign-owner") {
  await seed({ owner: "userB", rows: true, outbox: true });
} else if (scenario === "signed-out-residue") {
  await seed({ owner: "userA", rows: true, outbox: true });
} else if (scenario === "durable-only-token") {
  await seed({ owner: "userA", rows: true });
  await seedDurableToken("userA");
} else if (scenario === "write-guard-race") {
  await seed({ owner: "userA", rows: true });
} else if (
  scenario === "unparsable-token-at-boot" ||
  scenario === "unparsable-token-in-session"
) {
  await seed({ owner: "userA", rows: true, outbox: true });
} else if (scenario === "caller-a-disk-b") {
  await seed({ owner: "userB", rows: true, outbox: true, pendingFor: "userA" });
} else if (scenario === "durable-token-unparsable") {
  await seed({ owner: "userA", rows: true, outbox: true, pendingFor: "userA" });
  await seedDurableToken("userA", "not.a.jwt");
} else if (scenario === "durable-read-fails") {
  await seed({ owner: "userA", rows: true, outbox: true, pendingFor: "userA" });
} else if (scenario === "stamp-names-principal") {
  await seed({ stamp: "userA", rows: true, outbox: true });
} else if (scenario === "stamp-names-another") {
  await seed({ stamp: "userB", rows: true, outbox: true, pendingFor: "userA" });
} else if (scenario === "signed-out-tombstone-residue") {
  await seed({ stamp: null, rows: true, outbox: true });
} else if (scenario === "owner-read-fails") {
  await seed({ owner: "userA", stamp: "userA", rows: true, outbox: true });
  const proto = (globalThis as any).IDBObjectStore.prototype;
  const get = proto.get;
  proto.get = function (this: any, key: unknown) {
    if (key === "cacheOwner" || key === "currentUser")
      throw new DOMException("simulated read failure", "UnknownError");
    return get.call(this, key);
  };
  restoreReads = () => {
    proto.get = get;
  };
} else if (scenario === "pending-without-owner-row") {
  await seed({ pendingFor: "userA" });
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

const hydrated =
  scenario === "caller-a-disk-b"
    ? await loadCache(["pending", "pendingMessages"], {
        currentUser: { _id: "userA" },
      })
    : scenario === "pending-without-owner-row"
      ? await loadCache(["pending", "pendingMessages"])
      : await loadCache(["pending"]);
const owner = _cacheOwnerForTests();
const outbox = await loadOutbox();

switch (scenario) {
  case "fresh":
    expect(hydrated).toBeNull();
    expect(owner).toBe("userA");
    expect(await diskRows()).toEqual({ pending: 0, meta: 0, outbox: 0 });
    expect(await ownerStamp()).toBe("userA");
    expect(purges()).toEqual([]);
    await writePatchesToIDB(
      [
        {
          op: "replace",
          path: ["pending"],
          value: { [PENDING_KEY]: PENDING_VAL },
        },
      ] as any,
      { pending: { [PENDING_KEY]: PENDING_VAL } },
    );
    expect((await diskRows()).pending).toBe(1);
    break;
  case "known-owner":
    expect(hydrated?.pending?.[PENDING_KEY]).toEqual(PENDING_VAL);
    expect(owner).toBe("userA");
    expect(outbox.map((o) => o.id)).toEqual(["o1"]);
    expect((await diskRows()).pending).toBe(1);
    expect(await ownerStamp()).toBe("userA");
    expect(purges()).toEqual([]);
    break;
  case "legacy-unknown-owner":
  case "foreign-owner":
  case "stamp-names-another":
  case "signed-out-tombstone-residue": {
    expect(hydrated?.pending).toBeUndefined();
    expect(owner).toBe("userA");
    expect(outbox).toEqual([]);
    const keptPending = scenario === "stamp-names-another" ? 1 : 0;
    expect(await diskRows()).toEqual({
      pending: 0,
      meta: keptPending,
      outbox: 0,
    });
    expect(purges()).toEqual([
      {
        "legacy-unknown-owner": "no-owner-recorded",
        "foreign-owner": "another-owner",
        "stamp-names-another": "another-owner",
        "signed-out-tombstone-residue": "signed-out-residue",
      }[scenario],
    ]);
    expect(await ownerStamp()).toBe("userA");
    await enqueueDispatch({
      id: "o2",
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts: 2,
    });
    expect((await loadOutbox()).map((o) => o.id)).toEqual(["o2"]);
    await loadCache(["pending"]);
    expect(_cacheOwnerForTests()).toBe("userA");
    expect(purges()).toHaveLength(1);
    expect((await loadOutbox()).map((o) => o.id)).toEqual(["o2"]);
    break;
  }
  case "stamp-names-principal":
    expect(hydrated?.pending?.[PENDING_KEY]).toEqual(PENDING_VAL);
    expect(owner).toBe("userA");
    expect(outbox.map((o) => o.id)).toEqual(["o1"]);
    expect(purges()).toEqual([]);
    break;
  case "owner-read-fails": {
    expect(hydrated).toBeNull();
    expect(purges()).toEqual([]);
    expect(
      readCacheEvents().some((e) => e.kind === "ownership-unreadable"),
    ).toBe(true);
    restoreReads?.();
    expect(await diskRows()).toEqual({ pending: 1, meta: 2, outbox: 1 });
    expect((await loadCache(["pending"]))?.pending?.[PENDING_KEY]).toEqual(
      PENDING_VAL,
    );
    expect(_cacheOwnerForTests()).toBe("userA");
    break;
  }
  case "signed-out-residue":
    expect(hydrated).toBeNull();
    expect(owner).toBeNull();
    expect(outbox).toEqual([]);
    expect(await diskRows()).toEqual({ pending: 0, meta: 0, outbox: 0 });
    expect(purges()).toEqual(["another-owner"]);
    expect(await ownerStamp()).toBeNull();
    await enqueueDispatch({
      id: "o2",
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts: 2,
    });
    expect((await diskRows()).outbox).toBe(0);
    break;
  case "durable-only-token":
    expect(hydrated?.pending?.[PENDING_KEY]).toEqual(PENDING_VAL);
    expect(owner).toBe("userA");
    break;
  case "caller-a-disk-b": {
    expect(hydrated?.pending).toBeUndefined();
    expect(hydrated?.pendingMessages?.c1?.[0]?.content).toBe(
      "typed but unsent",
    );
    expect(owner).toBe("userA");
    expect(outbox).toEqual([]);
    const d = await diskRows();
    expect(d.pending).toBe(0);
    expect(d.outbox).toBe(0);
    expect(d.meta).toBe(1);
    break;
  }
  case "durable-token-unparsable":
  case "durable-read-fails":
    expect(hydrated).toBeNull();
    expect(owner).toBeNull();
    expect(await diskRows()).toEqual({ pending: 1, meta: 3, outbox: 1 });
    break;
  case "pending-without-owner-row":
    expect(hydrated?.pending).toBeUndefined();
    expect(hydrated?.pendingMessages?.c1?.[0]?.content).toBe(
      "typed but unsent",
    );
    expect(owner).toBe("userA");
    expect(await diskRows()).toEqual({ pending: 0, meta: 1, outbox: 0 });
    break;
  case "unparsable-token-at-boot":
    expect(hydrated).toBeNull();
    expect(owner).toBeNull();
    expect(await diskRows()).toEqual({ pending: 1, meta: 2, outbox: 1 });
    break;
  case "unparsable-token-in-session": {
    expect(hydrated?.pending?.[PENDING_KEY]).toEqual(PENDING_VAL);
    local.setItem(AUTH_JWT_STORAGE_KEY, "not.a.jwt");
    await enqueueDispatch({
      id: "o2",
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts: 2,
    });
    expect((await loadOutbox()).map((o) => o.id)).toEqual(["o1", "o2"]);
    expect((await loadCache(["pending"]))?.pending?.[PENDING_KEY]).toEqual(
      PENDING_VAL,
    );
    expect((await diskRows()).pending).toBe(1);
    break;
  }
  case "write-guard-race": {
    expect(hydrated?.pending?.[PENDING_KEY]).toEqual(PENDING_VAL);
    local.setItem(AUTH_JWT_STORAGE_KEY, issue("userB"));
    await enqueueDispatch({
      id: "o2",
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts: 2,
    });
    const next = { [PENDING_KEY]: { type: "exclude", ts: Date.now() } };
    await writePatchesToIDB(
      [{ op: "replace", path: ["pending"], value: next }] as any,
      { pending: next },
    );
    const db = new Dexie("codecast-store");
    await db.open();
    expect(await db.table("pendingEntries").get(PENDING_KEY)).toEqual({
      key: PENDING_KEY,
      value: PENDING_VAL,
    });
    expect(await db.table("dispatchOutbox").count()).toBe(0);
    db.close();
    local.setItem(AUTH_JWT_STORAGE_KEY, issue("userA"));
    await enqueueDispatch({
      id: "o3",
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts: 3,
    });
    expect((await loadOutbox()).map((o) => o.id)).toEqual(["o3"]);
    break;
  }
}
console.log(`${scenario} verified`);
