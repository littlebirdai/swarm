export async function sweepRevokedRowsFromDisk(
  _scopes: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  return {};
}

export function watchRevokedDiskRows(_store: unknown): () => void {
  return () => {};
}
