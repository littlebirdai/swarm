import type { CacheStorage } from "./storage";

export function forwardCacheStorage(
  getStorage: () => CacheStorage,
): Omit<CacheStorage, "loadPaintCacheSync"> {
  const forward =
    <Args extends unknown[], Result>(
      select: (storage: CacheStorage) => (...args: Args) => Result,
    ) =>
    (...args: Args): Result => {
      const storage = getStorage();
      return select(storage).apply(storage, args);
    };

  return {
    enqueueDispatch: forward((storage) => storage.enqueueDispatch),
    flushPersistence: forward((storage) => storage.flushPersistence),
    loadCache: forward((storage) => storage.loadCache),
    loadConversationMessages: forward(
      (storage) => storage.loadConversationMessages,
    ),
    loadOutbox: forward((storage) => storage.loadOutbox),
    loadPaintCache: forward((storage) => storage.loadPaintCache),
    outboxAccountId: forward((storage) => storage.outboxAccountId),
    persistPendingMessageChanges: forward(
      (storage) => storage.persistPendingMessageChanges,
    ),
    purgeLocalCache: forward((storage) => storage.purgeLocalCache),
    removeDispatch: forward((storage) => storage.removeDispatch),
    setHydrating: forward((storage) => storage.setHydrating),
    writeConversationMessages: forward(
      (storage) => storage.writeConversationMessages,
    ),
    writeConversationUserMessages: forward(
      (storage) => storage.writeConversationUserMessages,
    ),
    writePatches: forward((storage) => storage.writePatches),
  };
}
