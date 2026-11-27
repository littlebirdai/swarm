export const VIRT_HEIGHT_CACHE = new Map<string, number>();

const VIRT_HEIGHT_CACHE_MAX = 8000;

export function virtHeightKey(
  itemKey: string | number,
  densityKey: string,
): string {
  return `${itemKey}|${densityKey}`;
}

export function recordVirtHeight(key: string, size: number) {
  if (size <= 0) return;
  if (
    VIRT_HEIGHT_CACHE.size >= VIRT_HEIGHT_CACHE_MAX &&
    !VIRT_HEIGHT_CACHE.has(key)
  ) {
    const oldest = VIRT_HEIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) VIRT_HEIGHT_CACHE.delete(oldest);
  }
  VIRT_HEIGHT_CACHE.set(key, size);
}
