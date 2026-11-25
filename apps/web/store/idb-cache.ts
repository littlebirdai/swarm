import * as dexieStorage from "./persistence/dexie-storage";
import type { CacheStorage } from "./persistence/storage";

// Web persistence entry. Metro resolves ./idbCache.native.ts on mobile.
export {
  flushLivenessWrites,
  LIVENESS_FLUSH_MS,
} from "./persistence/idb-liveness-lane";
export {
  partitionSessionRetention,
  expireExcludeTombstones,
} from "./cacheRetention";
export {
  CACHE_SCHEMA_VERSION,
  CACHE_SCHEMA_SIGNATURE,
  cacheSchemaSignature,
  isPersistedStoreKey,
} from "./persistence/schema";
export {
  PERSISTENCE_AVAILABLE,
  MISSING_COLLECTION_TABLES,
  _reopenForTests,
  setUpgradeBlockedListener,
} from "./persistence/db";
export { flushPendingMessageJournal } from "./persistence/pendingInputJournal";
export { _cacheOwnerForTests } from "./persistence/ownership";
export { _resetPersistedShadow } from "./persistence/collection-writer";
export { flushConversationMessages } from "./persistence/message-cache";
export { RETIRED_META_KEYS } from "./persistence/boot-loader";
export {
  deleteInBatches,
  RETENTION_DELETE_BATCH,
} from "./persistence/retention";
export {
  salvageLocalFirstV2Data,
  type OutboxEntry,
} from "./persistence/outbox";
export {
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
  writePatches as writePatchesToIDB,
} from "./persistence/dexie-storage";
export type { CachedConversation } from "./persistence/storage";

export const cacheStorage: CacheStorage = dexieStorage;
