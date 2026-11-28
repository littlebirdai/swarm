import { authPrincipal } from "../lib/authPrincipal";
import { lastPersisted } from "./persistence/collection-writer";
import { COLLECTION_TABLES, db } from "./persistence/db";
import { persistenceOwned } from "./persistence/ownership";
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
    const parentsOnDisk =
      key === "taskComments"
        ? new Map<string, unknown>(
            (await COLLECTION_TABLES.tasks.toArray()).map((row: any) => [
              String(row._id),
              row,
            ]),
          )
        : null;
    const revokedIn = (row: any, set: ReadonlySet<string>) => {
      if (!parentsOnDisk) return revokedScopeOfRow(key, row, set) !== null;
      const id = String(row._id);
      const parent =
        useInboxStore.getState().tasks?.[id] ?? parentsOnDisk.get(id);
      return revokedScopeOfThread(parent, set) !== null;
    };
    const seen = new Map<string, unknown>();
    const ids: string[] = await db.transaction("rw", table, async () => {
      if (!persistenceOwned() || authPrincipal.current() !== owner) return [];
      const live = activeRevokedScopes(useInboxStore.getState());
      if (!live) return [];
      const hit: string[] = [];
      for (const row of await candidateRows(key, table, scopes)) {
        if (
          typeof row?._id === "string" &&
          revokedIn(row, scopes) &&
          revokedIn(row, live)
        ) {
          hit.push(row._id);
          seen.set(row._id, lastPersisted.get(key)?.get(row._id));
        }
      }
      if (hit.length) await table.bulkDelete(hit);
      return hit;
    });
    const shadow = lastPersisted.get(key);
    for (const id of ids)
      if (shadow?.get(id) === seen.get(id)) shadow?.delete(id);
    if (ids.length) out[key] = ids;
  }
  const feeds: string[] = await db.transaction("rw", db.meta, async () => {
    if (!persistenceOwned() || authPrincipal.current() !== owner) return [];
    const row = await db.meta.get("feedConversations");
    const value = row?.value as Record<string, unknown> | undefined;
    const gone = value ? revokedFeedKeys(value, scopes) : [];
    if (!value || gone.length === 0) return [];
    const kept = { ...value };
    for (const k of gone) delete kept[k];
    await db.meta.put({ key: "feedConversations", value: kept });
    return gone;
  });
  if (feeds.length) out.feedConversations = feeds;
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
