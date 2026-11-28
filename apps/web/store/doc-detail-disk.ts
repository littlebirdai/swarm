import { cacheStorage } from "./idb-cache";
import { persistenceOwned } from "./persistence/ownership";

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
  const refs = (await cacheStorage.readCachedDocDetails?.()) ?? [];
  return refs.map(({ _id, workspace }) => ({ _id, workspace }));
}

export async function pruneCachedDocDetails(
  current: () => boolean,
  protect: () => (id: string) => boolean,
): Promise<void> {
  if (!current()) return;
  const refs = (await cacheStorage.readCachedDocDetails?.()) ?? [];
  if (!current()) return;
  const excess = refs.length - MAX_DOC_DETAILS_ON_DISK;
  if (excess <= 0) return;
  const isProtected = protect();
  const discard: string[] = [];
  for (const row of refs) {
    if (!isProtected(row._id)) discard.push(row._id);
    if (discard.length === excess) break;
  }
  if (!discard.length || !current()) return;
  await cacheStorage.deleteInvalidatedDocDetails?.(discard, current);
}

export async function readCachedDocDetailIds(): Promise<string[]> {
  if (!persistenceOwned()) return [];
  const refs = (await cacheStorage.readCachedDocDetails?.()) ?? [];
  return refs.map((row) => row._id);
}

export function persistedDocDetailWorkspace(id: string): string | undefined {
  return cacheStorage.persistedDocDetailWorkspace?.(id);
}

export function compactPersistedDocDetails(ids: readonly string[]): void {
  cacheStorage.compactPersistedDocDetails?.(ids);
}
