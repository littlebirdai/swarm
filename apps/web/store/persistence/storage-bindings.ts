import {
  cacheEvictionsFor,
  withCacheEvictions,
  withoutEvictionPatches,
} from "../cache-eviction";
import type { CacheStorage } from "./storage";

export function sqliteCacheEnabled(): boolean {
  return process.env.VITE_SQLITE_CACHE === "1";
}

export function selectCacheStorage(
  dexie: CacheStorage,
  sqlite: () => CacheStorage,
): () => CacheStorage {
  return () => (sqliteCacheEnabled() ? sqlite() : dexie);
}

export function createLazySqliteStorage(
  loadModule: () => Promise<{ getSqliteCacheStorage(): CacheStorage }>,
  syncFallback: Pick<
    CacheStorage,
    "outboxAccountId" | "persistPendingMessageChanges" | "setHydrating"
  >,
): () => CacheStorage {
  let instance: CacheStorage | null = null;
  let loaded: CacheStorage | null = null;
  let loading: Promise<CacheStorage> | null = null;
  const queuedSync: Array<(storage: CacheStorage) => void> = [];

  const ensureLoaded = (): Promise<CacheStorage> => {
    if (loaded) return Promise.resolve(loaded);
    if (!loading) {
      loading = loadModule()
        .then((mod) => {
          const storage = mod.getSqliteCacheStorage();
          const pending = queuedSync.splice(0, queuedSync.length);
          for (const fn of pending) fn(storage);
          loaded = storage;
          return storage;
        })
        .catch((error) => {
          loading = null;
          throw error;
        });
    }
    return loading;
  };

  return () => {
    if (!instance) {
      instance = {
        loadCache: async (keys, context) =>
          (await ensureLoaded()).loadCache(keys, context),
        loadPaintCache: async () => (await ensureLoaded()).loadPaintCache(),
        setHydrating(value) {
          syncFallback.setHydrating(value);
          if (loaded) loaded.setHydrating(value);
          else {
            queuedSync.push((storage) => storage.setHydrating(value));
            void ensureLoaded().catch(() => {});
          }
        },
        writePatches(patches, state) {
          if (loaded) return loaded.writePatches(patches, state);
          const evictions = cacheEvictionsFor(
            patches,
            state as Record<string, any>,
          );
          const filtered = withoutEvictionPatches(patches, evictions);
          queuedSync.push((storage) =>
            withCacheEvictions(evictions, () =>
              storage.writePatches(filtered, state),
            ),
          );
          void ensureLoaded().catch(() => {});
        },
        async flushPersistence() {
          const storage = await ensureLoaded();
          await storage.flushPersistence();
        },
        loadConversationMessages: async (conversationId) =>
          (await ensureLoaded()).loadConversationMessages(conversationId),
        writeConversationMessages(conversationId, messages, pagination) {
          if (loaded) {
            loaded.writeConversationMessages(
              conversationId,
              messages,
              pagination,
            );
            return;
          }
          queuedSync.push((storage) =>
            storage.writeConversationMessages(
              conversationId,
              messages,
              pagination,
            ),
          );
          void ensureLoaded().catch(() => {});
        },
        writeConversationUserMessages(conversationId, messages) {
          if (loaded) {
            loaded.writeConversationUserMessages(conversationId, messages);
            return;
          }
          queuedSync.push((storage) =>
            storage.writeConversationUserMessages(conversationId, messages),
          );
          void ensureLoaded().catch(() => {});
        },
        enqueueDispatch: async (entry) =>
          (await ensureLoaded()).enqueueDispatch(entry),
        removeDispatch: async (id) => (await ensureLoaded()).removeDispatch(id),
        loadOutbox: async () => (await ensureLoaded()).loadOutbox(),
        outboxAccountId: () =>
          loaded ? loaded.outboxAccountId() : syncFallback.outboxAccountId(),
        persistPendingMessageChanges(before, after, ownerId) {
          if (loaded) {
            loaded.persistPendingMessageChanges(before, after, ownerId);
            return;
          }
          syncFallback.persistPendingMessageChanges(before, after, ownerId);
        },
        purgeLocalCache: async (options) =>
          (await ensureLoaded()).purgeLocalCache(options),
        deleteInvalidatedDocDetails: async (ids, current, archive) =>
          (await ensureLoaded()).deleteInvalidatedDocDetails?.(
            ids,
            current,
            archive,
          ) ?? [],
      };
    }
    return instance;
  };
}

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
    deleteInvalidatedDocDetails: (ids, current, archive) => {
      const storage = getStorage();
      return storage.deleteInvalidatedDocDetails
        ? storage.deleteInvalidatedDocDetails(ids, current, archive)
        : Promise.resolve([]);
    },
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
