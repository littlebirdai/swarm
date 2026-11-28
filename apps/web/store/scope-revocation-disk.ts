import { authPrincipal } from "../lib/authPrincipal";
import { lastPersisted } from "./persistence/collection-writer";
import { COLLECTION_TABLES, db } from "./persistence/db";
import { persistenceOwned } from "./persistence/ownership";
import { useInboxStore } from "./inboxStore";
import { revokedScopeOfRow } from "./scope-subscription-candidates";
import { activeRevokedScopes } from "./scope-revocation-gate";
import { sweptCollectionsFor } from "./scope-revocation-tables";

export function revokedOnDisk(key: string, row: unknown): boolean {
  const revoked = activeRevokedScopes(useInboxStore.getState());
  return !!revoked && revokedScopeOfRow(key, row, revoked) !== null;
}

async function candidateRows(
  key: string,
  table: any,
  scopes: ReadonlySet<string>,
): Promise<any[]> {
  const kinds = [...scopes].map((scope) => scope.split(":")[0]);
  if (key === "chatMessages" && kinds.every((kind) => kind === "channel")) {
    const channels = [...scopes].map((scope) => scope.slice(8));
    return table.where("channel_id").anyOf(channels).toArray();
  }
  if (key === "docDetails" && kinds.every((kind) => kind === "dir")) {
    const rows: any[] = [];
    for (const scope of scopes) {
      const workspace = `team:${scope.slice(4)}`;
      rows.push(
        ...(await table
          .where("[workspace+_id]")
          .between([workspace, ""], [workspace, "￿"])
          .toArray()),
      );
    }
    return rows;
  }
  return table.toArray();
}

export async function sweepRevokedRowsFromDisk(
  scopes: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const owner = authPrincipal.current();
  if (scopes.size === 0 || !owner || !persistenceOwned()) return out;
  for (const key of sweptCollectionsFor(scopes)) {
    const table = (COLLECTION_TABLES as Record<string, any>)[key];
    if (!table) continue;
    const shadow = lastPersisted.get(key);
    const seen = new Map<string, unknown>();
    const ids: string[] = await db.transaction("rw", table, async () => {
      if (!persistenceOwned() || authPrincipal.current() !== owner) return [];
      const live = activeRevokedScopes(useInboxStore.getState());
      if (!live) return [];
      const hit: string[] = [];
      for (const row of await candidateRows(key, table, scopes)) {
        if (
          typeof row?._id === "string" &&
          revokedScopeOfRow(key, row, scopes) !== null &&
          revokedScopeOfRow(key, row, live) !== null
        ) {
          hit.push(row._id);
          seen.set(row._id, shadow?.get(row._id));
        }
      }
      if (hit.length) await table.bulkDelete(hit);
      return hit;
    });
    for (const id of ids)
      if (shadow?.get(id) === seen.get(id)) shadow?.delete(id);
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
