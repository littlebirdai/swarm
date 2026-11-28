import { createCacheOwnership } from "./cache-ownership";
import { db, markCacheServed, registerTestReopen } from "./db";
import { COMPOSER_RETRY_PREFIX, PENDING_INPUT_PREFIX } from "./schema";

const ownershipApi = createCacheOwnership({
  db,
  residueTables: [db.pendingEntries],
  ownedInputPrefixes: [PENDING_INPUT_PREFIX, COMPOSER_RETRY_PREFIX],
  onServed: markCacheServed,
});
registerTestReopen(ownershipApi.reset);
export const {
  persistenceOwned,
  writeOwnerStamp,
  ensureCacheOwnership,
  _cacheOwnerForTests,
} = ownershipApi;
