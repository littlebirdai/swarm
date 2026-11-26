import { cacheEvictionEnabled } from "./cache-eviction";

export type DetailInvalidation = {
  ids: string[];
  cause: "access" | "archive" | "crawl";
  workspace?: string;
};

let revision = 0;
let account = 0;
let recovery = 0;
const invalidated = new Map<string, number>();
const listeners = new Set<() => void>();
let readFresh:
  | ((id: string) => Promise<Record<string, unknown> | null>)
  | undefined;
let report: ((evidence: DetailInvalidation) => void) | undefined;
let reportCrawl:
  | ((
      workspace: string,
      ids: ReadonlySet<string>,
      position: ReturnType<typeof detailReadPosition>,
    ) => Promise<void>)
  | undefined;

export function detailReadPosition() {
  return { account, revision };
}

export function detailAccountIsCurrent(
  position: ReturnType<typeof detailReadPosition>,
): boolean {
  return position.account === account;
}

export function detailReadIsCurrent(
  id: string,
  position: ReturnType<typeof detailReadPosition>,
): boolean {
  return (
    detailAccountIsCurrent(position) &&
    position.revision >= recovery &&
    position.revision >= (invalidated.get(id) ?? 0)
  );
}

export function detailInvalidationRevision(id: string): number {
  return Math.max(recovery, invalidated.get(id) ?? 0);
}

export function subscribeDetailInvalidations(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function invalidateDetailReads(ids?: readonly string[]): number {
  const version = ++revision;
  if (ids) for (const id of ids) invalidated.set(id, version);
  else recovery = version;
  for (const listener of listeners) listener();
  return version;
}

export function canHydrateDetail(id: string): boolean {
  return !cacheEvictionEnabled() || detailInvalidationRevision(id) === 0;
}

export function resetDetailInvalidations(): void {
  account++;
  revision = 0;
  recovery = 0;
  invalidated.clear();
  setDetailInvalidationReporter();
}

export function setDetailInvalidationReporter(
  next?: typeof report,
  read?: typeof readFresh,
  crawl?: typeof reportCrawl,
) {
  report = next;
  readFresh = read;
  reportCrawl = crawl;
}

export function reportCompleteDocCrawl(
  workspace: string,
  ids: ReadonlySet<string>,
  position: ReturnType<typeof detailReadPosition>,
) {
  return reportCrawl?.(workspace, ids, position);
}

export function readFreshDocDetail(id: string) {
  return readFresh?.(id);
}

export function reportDetailInvalidation(
  evidence: DetailInvalidation,
): boolean {
  if (!cacheEvictionEnabled() || !report || !evidence.ids.length) return false;
  report(evidence);
  return true;
}
