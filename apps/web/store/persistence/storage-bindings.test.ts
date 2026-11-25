import { expect, mock, test } from "bun:test";
import * as web from "../idb-cache";
import * as native from "../idb-cache.native";
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
