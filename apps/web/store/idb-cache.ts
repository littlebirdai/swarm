import { authPrincipal } from "../lib/authPrincipal";
import { setHydrating as setPersistenceHydrating } from "./persistence/hydration";
import { outboxAccountId as readOutboxAccountId } from "./persistence/outbox";
import { persistPendingMessageChanges as persistPendingJournal } from "./persistence/pendingInputJournal";
import {
  createLazySqliteStorage,
  forwardCacheStorage,
} from "./persistence/storage-bindings";
import type { CacheStorage } from "./persistence/storage";

export {
  partitionSessionRetention,
  expireExcludeTombstones,
} from "./cacheRetention";
export {
  CACHE_SCHEMA_VERSION,
  CACHE_SCHEMA_SIGNATURE,
  RETIRED_META_KEYS,
  cacheSchemaSignature,
  isPersistedStoreKey,
} from "./persistence/schema";
export {
  PERSISTENCE_AVAILABLE,
  _reopenForTests,
  setUpgradeBlockedListener,
} from "./persistence/db";
export { flushPendingMessageJournal } from "./persistence/pendingInputJournal";
export { _cacheOwnerForTests } from "./persistence/ownership";
export {
  deleteInBatches,
  RETENTION_DELETE_BATCH,
} from "./persistence/retention";
export {
  salvageLocalFirstV2Data,
  type OutboxEntry,
} from "./persistence/outbox";
export type { CachedConversation } from "./persistence/storage";

const lazySqliteStorage = createLazySqliteStorage(
  () => import("./persistence/sqlite/storage"),
  {
    outboxAccountId: readOutboxAccountId,
    persistPendingMessageChanges: persistPendingJournal,
    setHydrating: setPersistenceHydrating,
  },
  authPrincipal,
);

export const cacheStorage: CacheStorage =
  forwardCacheStorage(lazySqliteStorage);

export const {
  deleteInvalidatedDocDetails,
  enqueueDispatch,
  flushPersistence,
  loadCache,
  loadConversationMessages,
  loadOutbox,
  outboxAccountId,
  persistPendingMessageChanges,
  purgeLocalCache,
  removeDispatch,
  setHydrating,
  writeConversationMessages,
  writeConversationUserMessages,
  writePatches: writePatchesToIDB,
} = forwardCacheStorage(() => cacheStorage);
