import { createCacheOwnership } from "./cache-ownership";
import { COLLECTION_TABLES, db, markCacheServed } from "./db";
import { COMPOSER_RETRY_PREFIX, PENDING_INPUT_PREFIX } from "./schema";

const ownershipApi = createCacheOwnership({
  db,
  residueTables: [
    COLLECTION_TABLES.sessions,
    COLLECTION_TABLES.conversations,
    db.pendingEntries,
  ],
  ownedInputPrefixes: [PENDING_INPUT_PREFIX, COMPOSER_RETRY_PREFIX],
  onServed: markCacheServed,
});
export const {
  persistenceOwned,
  writeOwnerStamp,
  ensureCacheOwnership,
  _cacheOwnerForTests,
} = ownershipApi;
