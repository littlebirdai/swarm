import { expect, mock, test } from "bun:test";
import * as web from "../idb-cache";
import * as native from "../idb-cache.native";
import { createLazySqliteStorage } from "./storage-bindings";
import type { CacheStorage } from "./storage";

const aliases = [
  ["enqueueDispatch", "enqueueDispatch"],
  ["flushPersistence", "flushPersistence"],
  ["loadCache", "loadCache"],
  ["loadConversationMessages", "loadConversationMessages"],
  ["loadOutbox", "loadOutbox"],
  ["outboxAccountId", "outboxAccountId"],
  ["persistPendingMessageChanges", "persistPendingMessageChanges"],
  ["purgeLocalCache", "purgeLocalCache"],
  ["removeDispatch", "removeDispatch"],
  ["setHydrating", "setHydrating"],
  ["writeConversationMessages", "writeConversationMessages"],
  ["writeConversationUserMessages", "writeConversationUserMessages"],
  ["writePatches", "writePatchesToIDB"],
] as const satisfies ReadonlyArray<
  readonly [keyof CacheStorage, keyof typeof web & keyof typeof native]
>;

for (const [platform, module] of [
  ["web", web],
  ["native", native],
] as const) {
  for (const [method, alias] of aliases) {
    test(`${platform} ${alias} follows its cache instance method`, () => {
      const storage = module.cacheStorage;
      const original = storage[method];
      const result = { method };
      const call = mock((..._args: unknown[]) => result);
      expect(Reflect.set(storage, method, call)).toBe(true);
      try {
        const args = [{ first: method }, { second: method }, { third: method }];
        expect(Reflect.apply(module[alias], undefined, args)).toBe(result);
        expect(call).toHaveBeenCalledWith(...args);
      } finally {
        Reflect.set(storage, method, original);
      }
    });
  }
}

test("native paint reads follow the cache instance", async () => {
  const storage = native.cacheStorage;
  const original = storage.loadPaintCacheSync;
  const result = { sessions: {} };
  storage.loadPaintCacheSync = () => result;
  try {
    expect(native.loadPaintCacheSync()).toBe(result);
    expect(await storage.loadPaintCache()).toBe(result);
  } finally {
    storage.loadPaintCacheSync = original;
  }
});

function deferredSqliteModule() {
  const writes: string[] = [];
  const purges: number[] = [];
  const module = Promise.withResolvers<{
    getSqliteCacheStorage(): CacheStorage;
  }>();
  const storage = {
    setHydrating() {},
    writePatches: () => {
      writes.push("patches");
    },
    writeConversationMessages: () => {
      writes.push("messages");
    },
    writeConversationUserMessages: () => {
      writes.push("userMessages");
    },
    purgeLocalCache: async () => {
      purges.push(writes.length);
    },
    flushPersistence: async () => {},
  } as unknown as CacheStorage;
  return {
    writes,
    purges,
    load: () => module.promise,
    resolve: () => module.resolve({ getSqliteCacheStorage: () => storage }),
  };
}

function switchableAuth(principal: string | null) {
  let current = principal;
  let epoch = 0;
  return {
    current: () => current,
    epoch: () => epoch,
    switchTo(next: string | null) {
      current = next;
      epoch++;
    },
  };
}

const syncFallback = {
  outboxAccountId: () => null,
  persistPendingMessageChanges() {},
  setHydrating() {},
};

test("writes queued before the SQLite module loads replay only for the account that made them", async () => {
  const sqlite = deferredSqliteModule();
  const auth = switchableAuth("userA");
  const storage = createLazySqliteStorage(sqlite.load, syncFallback, auth)();
  storage.writePatches([], { sessions: {} });
  storage.writeConversationMessages("conversation", [], {});
  storage.writeConversationUserMessages("conversation", []);
  auth.switchTo("userB");
  storage.writeConversationMessages("conversation", [], {});
  sqlite.resolve();
  await storage.flushPersistence();

  expect(sqlite.writes).toEqual(["messages"]);
});

test("a purge before the SQLite module loads drops the queued writes", async () => {
  const sqlite = deferredSqliteModule();
  const storage = createLazySqliteStorage(
    sqlite.load,
    syncFallback,
    switchableAuth("userA"),
  )();
  storage.writeConversationMessages("conversation", [], {});
  const purge = storage.purgeLocalCache({ reason: "sign-out" });
  sqlite.resolve();
  await purge;

  expect(sqlite.writes).toEqual([]);
  expect(sqlite.purges).toEqual([0]);
});
