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
