export async function deleteInvalidatedDocDetails(
  _ids: readonly string[],
  _current: (id: string) => boolean,
): Promise<string[]> {
  return [];
}

export async function readCachedDocDetails(): Promise<
  Array<{ _id: string; workspace?: string }>
> {
  return [];
}

export function persistedDocDetailWorkspace(_id: string): string | undefined {
  return undefined;
}

export function compactPersistedDocDetails(_ids: readonly string[]): void {}

export async function pruneCachedDocDetails(
  _current: () => boolean,
  _protect: () => (id: string) => boolean,
): Promise<void> {}
