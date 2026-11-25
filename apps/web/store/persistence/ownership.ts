import { createCacheOwnership } from "./cache-ownership";
import { COLLECTION_TABLES, db, markCacheServed } from "./db";
import { PENDING_INPUT_PREFIX } from "./schema";

const ownershipApi = createCacheOwnership({
  db,
  residueTables: [COLLECTION_TABLES.sessions, COLLECTION_TABLES.conversations],
  pendingInputPrefix: PENDING_INPUT_PREFIX,
  onServed: markCacheServed,
});
export const {
  persistenceOwned,
  writeOwnerStamp,
  ensureCacheOwnership,
  _cacheOwnerForTests,
} = ownershipApi;
