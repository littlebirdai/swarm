import { COLLECTION_TABLES } from "./persistence/db";
import { persistenceOwned } from "./persistence/ownership";
import { lastPersisted } from "./persistence/collection-writer";

export { deleteInvalidatedDocDetails } from "./persistence/collection-writer";

export function readCachedDocDetails(): Promise<
  Array<{ _id: string; workspace?: string }>
> {
  return persistenceOwned()
    ? COLLECTION_TABLES.docDetails.toArray()
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
