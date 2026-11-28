import { nativeCachedRows } from "./idb-cache.native";
import { META_PREFIX, collectionRowKey } from "./idbCacheKeys.native";
import { useInboxStore } from "./inboxStore";
import { revokedScopeOfRow, revokedScopeOfThread } from "./scope-row-home";
import { activeRevokedScopes, rowRevokedNow } from "./scope-revocation-gate";
import {
  revokedFeedKeys,
  sweptCollectionsFor,
} from "./scope-revocation-tables";

export function revokedOnDisk(key: string, row: unknown): boolean {
  return rowRevokedNow(useInboxStore.getState(), key, row);
}

export async function sweepRevokedRowsFromDisk(
  scopes: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const owner = nativeCachedRows.principal();
  if (scopes.size === 0 || !owner) return out;
  const current = () => nativeCachedRows.principal() === owner;
  const keys = await nativeCachedRows.keys();
  const removedTasks = new Set<string>();
  const parentOf = async (id: string): Promise<unknown> => {
    const held = useInboxStore.getState().tasks?.[id];
    if (held) return held;
    if (removedTasks.has(id)) return undefined;
    const raw = await nativeCachedRows.read(collectionRowKey("tasks", id));
    try {
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  for (const key of sweptCollectionsFor(scopes)) {
    const prefix = collectionRowKey(key, "");
    const ids: string[] = [];
    for (const storageKey of keys) {
      if (!storageKey.startsWith(prefix)) continue;
      const id = storageKey.slice(prefix.length);
      const held = nativeCachedRows.persisted.get(key)?.get(id);
      const raw = await nativeCachedRows.read(storageKey);
      if (!raw || !current()) continue;
      let row: any;
      try {
        row = JSON.parse(raw);
      } catch {
        continue;
      }
      const parent = key === "taskComments" ? await parentOf(id) : null;
      const live = activeRevokedScopes(useInboxStore.getState());
      const revokedIn = (set: ReadonlySet<string>) =>
        key === "taskComments"
          ? revokedScopeOfThread(parent, set) !== null
          : revokedScopeOfRow(key, row, set) !== null;
      if (!live || !revokedIn(scopes) || !revokedIn(live)) continue;
      const shadow = nativeCachedRows.persisted.get(key);
      if (!current() || shadow?.get(id) !== held) continue;
      nativeCachedRows.remove(storageKey);
      shadow?.delete(id);
      if (key === "tasks") removedTasks.add(id);
      ids.push(id);
    }
    if (ids.length) out[key] = ids;
  }
  const feedKey = META_PREFIX + "feedConversations";
  const rawFeeds = await nativeCachedRows.read(feedKey);
  if (rawFeeds && current()) {
    let feeds: Record<string, unknown> | null = null;
    try {
      feeds = JSON.parse(rawFeeds);
    } catch {
      feeds = null;
    }
    const gone = feeds ? revokedFeedKeys(feeds, scopes) : [];
    if (feeds && gone.length) {
      for (const k of gone) delete feeds[k];
      nativeCachedRows.write(feedKey, JSON.stringify(feeds));
      out.feedConversations = gone;
    }
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
