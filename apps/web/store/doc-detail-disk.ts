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
