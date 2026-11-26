import type { Patch } from "mutative";

export type CacheEviction = {
  key: string;
  id: string;
  observed: object;
};

let current: readonly CacheEviction[] = [];

export function cacheEvictionEnabled(): boolean {
  return process.env.VITE_CACHE_EVICTION_METADATA === "1";
}

export function withCacheEvictions(
  evictions: readonly CacheEviction[],
  remove: () => void,
): void {
  const outer = current;
  current = [...outer, ...evictions];
  try {
    remove();
  } finally {
    current = outer;
  }
}

export function cacheEvictionsFor(
  patches: readonly Patch[],
  state: Record<string, any>,
): readonly CacheEviction[] {
  if (!current.length) return current;
  return current.filter(
    ({ key, id }) =>
      state[key]?.[id] === undefined &&
      patches.some(
        ({ op, path }) =>
          path[0] === key &&
          (path.length === 1 ||
            (op === "remove" && path.length === 2 && path[1] === id)),
      ),
  );
}

export function withoutEvictionPatches(
  patches: Patch[],
  evictions: readonly CacheEviction[],
): Patch[] {
  if (!evictions.length) return patches;
  return patches.filter(
    ({ op, path }) =>
      op !== "remove" ||
      path.length !== 2 ||
      !evictions.some(({ key, id }) => path[0] === key && path[1] === id),
  );
}
