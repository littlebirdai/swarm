import { cacheEvictionEnabled } from "./cache-eviction";

export type DetailInvalidation = {
  ids: string[];
  cause: "access" | "archive" | "crawl";
  workspace?: string;
};

type Position = { account: number; revision: number };
type CachedResult = Record<string, unknown> | null;
type Reporter = (evidence: DetailInvalidation) => boolean;
type CrawlReporter = (
  workspace: string,
  ids: ReadonlySet<string>,
  position: Position,
) => Promise<void>;

function freshDetailCache(account = 0, listeners = new Set<() => void>()) {
  return {
    account,
    revision: 0,
    recovery: 0,
    invalidated: new Map<string, number>(),
    confirmed: new Map<string, number>(),
    reads: new Map<
      string,
      { barrier: number; promise: Promise<CachedResult> }
    >(),
    listeners,
    readFresh: undefined as ((id: string) => Promise<CachedResult>) | undefined,
    report: undefined as Reporter | undefined,
    reportCrawl: undefined as CrawlReporter | undefined,
  };
}

let detailCache = freshDetailCache();

export function detailReadPosition(): Position {
  return { account: detailCache.account, revision: detailCache.revision };
}

export function detailAccountIsCurrent(position: Position): boolean {
  return position.account === detailCache.account;
}

export function detailReadIsCurrent(id: string, position: Position): boolean {
  return (
    detailAccountIsCurrent(position) &&
    position.revision >= detailInvalidationRevision(id)
  );
}

export function detailInvalidationRevision(id: string): number {
  return Math.max(
    detailCache.recovery,
    detailCache.invalidated.get(id) ?? 0,
    detailCache.confirmed.get(id) ?? 0,
  );
}

export function subscribeDetailInvalidations(listener: () => void) {
  detailCache.listeners.add(listener);
  return () => {
    detailCache.listeners.delete(listener);
  };
}

export function invalidateDetailReads(ids?: readonly string[]): number {
  const version = ++detailCache.revision;
  if (ids)
    for (const id of ids) {
      detailCache.invalidated.set(id, version);
      detailCache.confirmed.delete(id);
    }
  else {
    detailCache.recovery = version;
    detailCache.confirmed.clear();
  }
  for (const listener of detailCache.listeners) listener();
  return version;
}

export function canHydrateDetail(id: string): boolean {
  return (
    !cacheEvictionEnabled() ||
    (detailCache.confirmed.get(id) ?? 0) >= detailInvalidationRevision(id)
  );
}

export function acceptFreshDocDetail(id: string, position: Position): boolean {
  if (!detailReadIsCurrent(id, position)) return false;
  if (!canHydrateDetail(id)) {
    detailCache.confirmed.set(id, detailInvalidationRevision(id));
    detailCache.invalidated.delete(id);
    for (const listener of detailCache.listeners) listener();
  }
  return true;
}

export function acceptRecoveryFeed(id: string, position: Position): boolean {
  if (!detailReadIsCurrent(id, position)) return false;
  if (canHydrateDetail(id)) return true;
  if (detailCache.invalidated.has(id)) return false;
  return acceptFreshDocDetail(id, position);
}

export function resetDetailInvalidations(): void {
  detailCache = freshDetailCache(
    detailCache.account + 1,
    detailCache.listeners,
  );
}

export function setDetailInvalidationReporter(
  report?: Reporter,
  readFresh?: typeof detailCache.readFresh,
  reportCrawl?: CrawlReporter,
) {
  Object.assign(detailCache, { report, readFresh, reportCrawl });
}

export function reportCompleteDocCrawl(
  workspace: string,
  ids: ReadonlySet<string>,
  position: Position,
) {
  return detailCache.reportCrawl?.(workspace, ids, position);
}

export function hasFreshDocDetailReader(): boolean {
  return detailCache.readFresh !== undefined;
}

export function revalidateDroppedDocArchive(id: string): void {
  if (cacheEvictionEnabled() && detailCache.readFresh)
    invalidateDetailReads([id]);
}

export function fetchFreshDocDetail(id: string): Promise<CachedResult> {
  const cache = detailCache;
  const barrier = detailInvalidationRevision(id);
  const existing = cache.reads.get(id);
  if (existing?.barrier === barrier) return existing.promise;
  const position = detailReadPosition();
  const promise = Promise.resolve(cache.readFresh?.(id))
    .then((detail) =>
      detail &&
      detail.archived_at === undefined &&
      acceptFreshDocDetail(id, position)
        ? detail
        : null,
    )
    .finally(() => {
      if (cache.reads.get(id)?.promise === promise) cache.reads.delete(id);
    });
  cache.reads.set(id, { barrier, promise });
  return promise;
}

export function reportDetailInvalidation(
  evidence: DetailInvalidation,
): boolean {
  return (
    cacheEvictionEnabled() &&
    !!evidence.ids.length &&
    (detailCache.report?.(evidence) ?? false)
  );
}

export function __detailCacheSimSlots() {
  const copy = (cache: typeof detailCache): typeof detailCache => ({
    ...cache,
    invalidated: new Map(cache.invalidated),
    confirmed: new Map(cache.confirmed),
    reads: new Map(cache.reads),
    listeners: new Set(cache.listeners),
  });
  return {
    get: () => ({ detailCache: copy(detailCache) }),
    set: (slots: { detailCache: typeof detailCache }) => {
      detailCache = copy(slots.detailCache);
    },
    fresh: () => ({ detailCache: freshDetailCache() }),
  };
}
