import { cacheStorage } from "./idb-cache";
import { COLLECTION_TABLES, db } from "./persistence/db";
import { persistenceOwned } from "./persistence/ownership";
import { lastPersisted } from "./persistence/collection-writer";

export function deleteInvalidatedDocDetails(
  ids: readonly string[],
  current: (id: string) => boolean,
  archive?: { accountId: string; dispatchedAt: number },
): Promise<string[]> {
  return (
    cacheStorage.deleteInvalidatedDocDetails?.(ids, current, archive) ??
    Promise.resolve([])
  );
}

export const MAX_DOC_DETAILS_ON_DISK = 1000;

export async function readCachedDocDetails(): Promise<
  Array<{ _id: string; workspace?: string }>
> {
  if (!persistenceOwned()) return [];
  const table = COLLECTION_TABLES.docDetails;
  return db.transaction("r", table, async () => {
    const keys = await table.toCollection().primaryKeys();
    const scopes = new Map<string, string>();
    await table.orderBy("[workspace+_id]").eachKey((key) => {
      if (!Array.isArray(key)) return;
      const [workspace, id] = key;
      if (typeof id === "string" && typeof workspace === "string")
        scopes.set(id, workspace);
    });
    return keys.map((_id) => ({ _id, workspace: scopes.get(_id) }));
  });
}

export async function pruneCachedDocDetails(
  current: () => boolean,
  protect: () => (id: string) => boolean,
): Promise<void> {
  if (!current() || !persistenceOwned()) return;
  const table = COLLECTION_TABLES.docDetails;
  const previous = new Map(lastPersisted.get("docDetails"));
  const removed = await db.transaction("rw", table, async () => {
    if (!current() || !persistenceOwned()) return [];
    const keys = await table.toCollection().primaryKeys();
    const present = new Set(keys);
    const absent = [...previous.keys()].filter((id) => !present.has(id));
    const excess = keys.length - MAX_DOC_DETAILS_ON_DISK;
    if (excess <= 0 || !current() || !persistenceOwned()) return absent;

    const byAge = await table.orderBy("_cachedAt").primaryKeys();
    if (!current() || !persistenceOwned()) return absent;
    const indexed = new Set(byAge);
    const oldest = [...keys.filter((id) => !indexed.has(id)), ...byAge];
    const isProtected = protect();
    const discard: string[] = [];
    for (const id of oldest) {
      if (!isProtected(id)) discard.push(id);
      if (discard.length === excess) break;
    }
    if (discard.length) await table.bulkDelete(discard);
    return [...absent, ...discard];
  });
  const shadow = lastPersisted.get("docDetails");
  for (const id of removed)
    if (shadow?.get(id) === previous.get(id)) shadow?.delete(id);
}

export function readCachedDocDetailIds(): Promise<string[]> {
  return persistenceOwned()
    ? COLLECTION_TABLES.docDetails.toCollection().primaryKeys()
    : Promise.resolve([]);
}

export function persistedDocDetailWorkspace(id: string): string | undefined {
  return lastPersisted.get("docDetails")?.get(id)?.workspace;
}

export function compactPersistedDocDetails(ids: readonly string[]): void {
  const shadow = lastPersisted.get("docDetails");
  if (!shadow) return;
  for (const id of ids) {
    const row = shadow.get(id);
    if (row) shadow.set(id, { _id: id, workspace: row.workspace });
  }
}
