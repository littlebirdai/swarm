import { recordCacheEvent } from "../cacheEvents";
import { resetCollectionWrites } from "./collectionWriter";
import {
  db,
  deleteCacheDatabase,
  reopenAfterPurge,
  setPurgeInProgress,
} from "./db";
import { dropPendingMessageWrites } from "./messageCache";
import { writeOwnerStamp } from "./ownership";
import { clearPendingInputJournal } from "./pendingInputJournal";
import { PENDING_INPUT_PREFIX } from "./schema";

// Sign-out purge: drop every locally persisted row (collections, messages,
// meta, parked outbox). The caller owns navigation/reload afterwards.
// Every window purges at an account boundary, and the signing-out window
// purges once more, awaited; concurrent callers share one delete.
let purging: Promise<void> | null = null;

export function purgeLocalCache(opts?: {
  keepPendingInputFor?: string | null;
  /** Why, for the record (store/cacheEvents.ts). */
  reason?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  if (purging) return purging;
  const keep = opts?.keepPendingInputFor ?? null;
  recordCacheEvent("purge", {
    reason: opts?.reason ?? "unspecified",
    keepPendingInputFor: keep,
    ...opts?.detail,
  });
  purging = purgeLocalCacheNow(keep).finally(() => {
    purging = null;
  });
  return purging;
}

async function purgeLocalCacheNow(
  keepPendingInputFor: string | null,
): Promise<void> {
  setPurgeInProgress(true);
  try {
    await purgeLocalCacheSteps(keepPendingInputFor);
  } finally {
    setPurgeInProgress(false);
  }
}

async function purgeLocalCacheSteps(
  keepPendingInputFor: string | null,
): Promise<void> {
  await clearPendingInputJournal();
  dropPendingMessageWrites();
  resetCollectionWrites();
  // A cache purged from under a signed-in principal (someone else's rows were
  // on disk) keeps that principal's own pending input: keyed by owner, it was
  // never the other account's, and a typed message must not vanish.
  let kept: Array<{ key: string; value: any }> = [];
  if (keepPendingInputFor) {
    try {
      kept = await db.meta
        .where("key")
        .startsWith(`${PENDING_INPUT_PREFIX}${keepPendingInputFor}:`)
        .toArray();
    } catch {
      kept = [];
    }
  }
  try {
    await deleteCacheDatabase();
  } finally {
    await reopenAfterPurge();
  }
  if (kept.length) await db.meta.bulkPut(kept);
  // Stamp the emptied disk at once, so the next window to boot reads an owner
  // instead of rows that name nobody and purging again: the principal it was
  // purged for, or the signed-out tombstone, which makes anything a sibling
  // re-persists for the account just left provably foreign.
  await writeOwnerStamp(
    keepPendingInputFor,
    keepPendingInputFor ? "purged-for-principal" : "purged-leaving-account",
  );
}
