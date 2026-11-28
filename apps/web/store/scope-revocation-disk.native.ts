import { nativeCachedRows } from "./idb-cache.native";
import { collectionRowKey } from "./idbCacheKeys.native";
import { useInboxStore } from "./inboxStore";
import { revokedScopeOfRow } from "./scope-subscription-candidates";
import { activeRevokedScopes } from "./scope-revocation-gate";
import { sweptCollectionsFor } from "./scope-revocation-tables";

export function revokedOnDisk(key: string, row: unknown): boolean {
  const revoked = activeRevokedScopes(useInboxStore.getState());
  return !!revoked && revokedScopeOfRow(key, row, revoked) !== null;
}

export async function sweepRevokedRowsFromDisk(
  scopes: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (scopes.size === 0) return out;
  const keys = await nativeCachedRows.keys();
  for (const key of sweptCollectionsFor(scopes)) {
    const prefix = collectionRowKey(key, "");
    const shadow = nativeCachedRows.persisted.get(key);
    const ids: string[] = [];
    for (const storageKey of keys) {
      if (!storageKey.startsWith(prefix)) continue;
      const raw = await nativeCachedRows.read(storageKey);
      if (!raw) continue;
      let row: any;
      try {
        row = JSON.parse(raw);
      } catch {
        continue;
      }
      const live = activeRevokedScopes(useInboxStore.getState());
      if (
        !live ||
        revokedScopeOfRow(key, row, scopes) === null ||
        revokedScopeOfRow(key, row, live) === null
      )
        continue;
      const id = storageKey.slice(prefix.length);
      const held = shadow?.get(id);
      nativeCachedRows.remove(storageKey);
      if (shadow?.get(id) === held) shadow?.delete(id);
      ids.push(id);
    }
    if (ids.length) out[key] = ids;
  }
  return out;
}

export function watchRevokedDiskRows(
  store: Pick<typeof useInboxStore, "subscribe">,
): () => void {
  return store.subscribe((state, prev) => {
    const next = state.scopeRevocations;
    const before = prev.scopeRevocations ?? {};
    if (!next || next === before) return;
    const entered = new Set<string>();
    for (const [scope, at] of Object.entries(next))
      if (before[scope] === undefined || at > before[scope]) entered.add(scope);
    if (entered.size > 0)
      void sweepRevokedRowsFromDisk(entered).catch(() => {});
  });
}
