import { createCacheOwnership } from "../cacheOwnership";
import { COLLECTION_TABLES, db, markCacheServed } from "./db";
import { PENDING_INPUT_PREFIX } from "./pendingInputJournal";

const ownershipApi = createCacheOwnership({
  db,
  sessions: COLLECTION_TABLES.sessions,
  pendingInputPrefix: PENDING_INPUT_PREFIX,
  onServed: markCacheServed,
});
export const { persistenceOwned, writeOwnerStamp, ensureCacheOwnership, _cacheOwnerForTests } = ownershipApi;
