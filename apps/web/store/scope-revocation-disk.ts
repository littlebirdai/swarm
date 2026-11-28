import { lastPersisted } from "./persistence/collection-writer";
import { COLLECTION_TABLES, db } from "./persistence/db";
import { persistenceOwned } from "./persistence/ownership";
import { useInboxStore } from "./inboxStore";
import {
  activeRevokedScopes,
  revokedScopeOfRow,
} from "./scope-subscription-candidates";

const SWEPT_COLLECTIONS = [
  "tasks",
  "docs",
  "plans",
  "projects",
  "chatMessages",
  "docDetails",
] as const;

export async function sweepRevokedRowsFromDisk(
  scopes: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (scopes.size === 0 || !persistenceOwned()) return out;
  for (const key of SWEPT_COLLECTIONS) {
    const table = (COLLECTION_TABLES as Record<string, any>)[key];
    if (!table) continue;
    const ids: string[] = await db.transaction("rw", table, async () => {
      if (!persistenceOwned()) return [];
      const live = activeRevokedScopes(useInboxStore.getState());
      if (!live) return [];
      const hit: string[] = [];
      await table.each((row: any) => {
        if (
          typeof row?._id === "string" &&
          revokedScopeOfRow(key, row, scopes) !== null &&
          revokedScopeOfRow(key, row, live) !== null
        )
          hit.push(row._id);
      });
      if (hit.length) await table.bulkDelete(hit);
      return hit;
    });
    const shadow = lastPersisted.get(key);
    for (const id of ids) shadow?.delete(id);
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
