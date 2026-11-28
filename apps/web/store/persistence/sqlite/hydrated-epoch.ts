import { epochId, type CacheEpoch } from "./protocol";

function sameAccountEpoch(a: CacheEpoch, b: CacheEpoch): boolean {
  return (
    a.principal === b.principal &&
    a.schemaVersion === b.schemaVersion &&
    a.accountEpoch === b.accountEpoch
  );
}

function readsSyncCursor(keys: readonly string[] | undefined): boolean {
  return !keys || keys.includes("syncMeta");
}

export function hydratedEpochAfterLoad(
  current: CacheEpoch | null,
  loaded: CacheEpoch,
  active: CacheEpoch | null,
  keys: readonly string[] | undefined,
): CacheEpoch | null {
  if (!readsSyncCursor(keys)) return current;
  if (!active || epochId(active) !== epochId(loaded)) return current;
  if (current && sameAccountEpoch(current, loaded)) return current;
  return loaded;
}

export function rotatedEpochToRetry(
  hydrated: CacheEpoch | null,
  failed: CacheEpoch,
  active: CacheEpoch | null,
  keys: readonly string[] | undefined,
): CacheEpoch | null {
  if (hydrated || !active || !readsSyncCursor(keys)) return null;
  if (!sameAccountEpoch(active, failed)) return null;
  return active.generation > failed.generation ? active : null;
}
