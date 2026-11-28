import {
  SCOPE_FOLLOW_WINDOW_MS,
  activeTabPaths,
  computeEvictionsForPurge,
  computePurgeSet,
  extractScopeCandidates,
  extractViewScopes,
  findEntityRow,
  isKnownHomeScope,
  purgeUnheldScopeRowsInDraft,
  rowHomeScope,
  type PurgeTarget,
  type ScopeCandidates,
  type ScopeFollowCandidate,
  type ScopePurgeOptions,
  type ScopeScopedCollection,
  type ScopeStoreInput,
} from "./scope-subscription-candidates";
import {
  createScopeSubscriptionSlice,
  reconcileScopeSubscriptionsInDraft,
  type ScopeSubscriptionSlice,
} from "./scope-subscription-slice";

export {
  SCOPE_FOLLOW_WINDOW_MS,
  activeTabPaths,
  computeEvictionsForPurge,
  computePurgeSet,
  createScopeSubscriptionSlice,
  extractScopeCandidates,
  extractViewScopes,
  findEntityRow,
  isKnownHomeScope,
  purgeUnheldScopeRowsInDraft,
  reconcileScopeSubscriptionsInDraft,
  rowHomeScope,
  type PurgeTarget,
  type ScopeCandidates,
  type ScopeFollowCandidate,
  type ScopePurgeOptions,
  type ScopeScopedCollection,
  type ScopeStoreInput,
  type ScopeSubscriptionSlice,
};

export const SCOPE_SUBSCRIPTION_BUDGET = 64;
export const SCOPE_HEADS_CHUNK_SIZE = 16;
export const SCOPE_HEADS_CHUNK_COUNT = Math.ceil(
  SCOPE_SUBSCRIPTION_BUDGET / SCOPE_HEADS_CHUNK_SIZE,
);
export const SCOPE_VIEW_GRACE_MS = 60 * 1000;
export const SCOPE_DENY_TTL_MS = 5 * 60 * 1000;

export function clientScopeSubscriptionsEnabled(): boolean {
  try {
    return process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS === "1";
  } catch {
    return false;
  }
}

export type ScopeSource = "pinned" | "membership" | "follows" | "view";

export type ScopeSubscriptionEntry = {
  scope: string;
  sources: ScopeSource[];
  lastUsedAt: number;
  graceUntil?: number;
};

export type ScopeDenyEntry = {
  digest: string;
  at: number;
  waitLeaveView?: boolean;
};

export type ScopeSubscriptionState = {
  principalId: string | null;
  active: Record<string, ScopeSubscriptionEntry>;
  chunks: string[][];
  viewScopes: string[];
  graceDeadlines: Record<string, number>;
  denied: Record<string, ScopeDenyEntry>;
  peerViews: Record<string, string[]>;
  serverConfirmed: boolean;
  lastReconciledAt: number | null;
};

const SOURCE_PRIORITY: Record<ScopeSource, number> = {
  pinned: 4,
  view: 3,
  follows: 2,
  membership: 1,
};

export function initialScopeSubscriptionState(): ScopeSubscriptionState {
  return {
    principalId: null,
    active: {},
    chunks: Array.from({ length: SCOPE_HEADS_CHUNK_COUNT }, () => []),
    viewScopes: [],
    graceDeadlines: {},
    denied: {},
    peerViews: {},
    serverConfirmed: false,
    lastReconciledAt: null,
  };
}

function highestPriority(sources: readonly ScopeSource[]): number {
  let max = 0;
  for (const s of sources) {
    if (SOURCE_PRIORITY[s] > max) max = SOURCE_PRIORITY[s];
  }
  return max;
}

export function sameStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const arraysEqual = sameStringArray;

function numberRecordsEqual(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function denyRecordsEqual(
  a: Record<string, ScopeDenyEntry>,
  b: Record<string, ScopeDenyEntry>,
): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    const ea = a[key];
    const eb = b[key];
    if (
      !eb ||
      ea.digest !== eb.digest ||
      ea.at !== eb.at ||
      Boolean(ea.waitLeaveView) !== Boolean(eb.waitLeaveView)
    ) {
      return false;
    }
  }
  return true;
}

function fnvMix(hash: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function candidatesDigest(candidates: ScopeCandidates): string {
  const parts = [
    `p:${candidates.principalId ?? ""}`,
    `k:${[...candidates.pinned].sort().join(",")}`,
    `m:${[...candidates.membership].sort().join(",")}`,
    `f:${candidates.follows
      .map((f) => `${f.scope}:${f.at ?? ""}`)
      .sort()
      .join(",")}`,
  ];
  let h1 = 2166136261;
  let h2 = 33554467;
  for (let i = 0; i < parts.length; i++) {
    h1 = fnvMix(h1 ^ 0x9e, parts[i]);
    h2 = fnvMix(h2 ^ (i + 1), parts[i]);
  }
  return `${h1.toString(36)}:${h2.toString(36)}`;
}

export function distributeChunks(
  prevChunks: string[][],
  keptScopes: readonly string[],
  chunkSize: number,
  chunkCount: number,
): string[][] {
  const keptSet = new Set(keptScopes);
  const nextChunks: string[][] = Array.from({ length: chunkCount }, () => []);
  const assigned = new Set<string>();

  for (let i = 0; i < chunkCount; i++) {
    const existing = prevChunks[i] ?? [];
    for (const scope of existing) {
      if (keptSet.has(scope) && nextChunks[i].length < chunkSize) {
        nextChunks[i].push(scope);
        assigned.add(scope);
      }
    }
  }

  for (const scope of keptScopes) {
    if (assigned.has(scope)) continue;
    for (let i = 0; i < chunkCount; i++) {
      if (nextChunks[i].length < chunkSize) {
        nextChunks[i].push(scope);
        assigned.add(scope);
        break;
      }
    }
  }

  let chunksChanged = prevChunks.length !== chunkCount;
  for (let i = 0; i < chunkCount; i++) {
    if (prevChunks[i] && arraysEqual(prevChunks[i], nextChunks[i])) {
      nextChunks[i] = prevChunks[i];
    } else {
      chunksChanged = true;
    }
  }
  return chunksChanged ? nextChunks : prevChunks;
}

export function reconcileScopeSubscriptions(
  prevState: ScopeSubscriptionState,
  candidates: ScopeCandidates,
  now: number,
  opts?: { budget?: number; chunkSize?: number; graceMs?: number },
): {
  state: ScopeSubscriptionState;
  activeScopes: string[];
  addedScopes: string[];
  removedScopes: string[];
  evictedScopes: string[];
  expiredGraceScopes: string[];
  nextGraceExpiryAt: number | null;
} {
  const budget = Math.max(1, opts?.budget ?? SCOPE_SUBSCRIPTION_BUDGET);
  const chunkSize = Math.max(1, opts?.chunkSize ?? SCOPE_HEADS_CHUNK_SIZE);
  const chunkCount = Math.max(1, Math.ceil(budget / chunkSize));
  const graceMs = Math.max(0, opts?.graceMs ?? SCOPE_VIEW_GRACE_MS);

  const samePrincipal = prevState.principalId === candidates.principalId;
  const prev = samePrincipal
    ? prevState
    : {
        ...initialScopeSubscriptionState(),
        principalId: candidates.principalId,
      };

  if (!candidates.principalId) {
    const alreadyEmpty =
      prevState.principalId === null &&
      Object.keys(prevState.active).length === 0 &&
      Object.keys(prevState.graceDeadlines).length === 0 &&
      Object.keys(prevState.denied).length === 0 &&
      Object.keys(prevState.peerViews).length === 0 &&
      prevState.viewScopes.length === 0 &&
      !prevState.serverConfirmed;
    return {
      state: alreadyEmpty ? prevState : initialScopeSubscriptionState(),
      activeScopes: [],
      addedScopes: [],
      removedScopes: Object.keys(prevState.active),
      evictedScopes: [],
      expiredGraceScopes: [],
      nextGraceExpiryAt: null,
    };
  }

  const userScope = `user:${candidates.principalId}`;
  const digest = candidatesDigest(candidates);
  const rawViewSet = new Set(candidates.view);

  const nextDeniedRaw: Record<string, ScopeDenyEntry> = {};
  for (const [scope, entry] of Object.entries(prev.denied ?? {})) {
    if (scope === userScope) continue;
    if (entry.digest !== digest || now - entry.at >= SCOPE_DENY_TTL_MS) {
      continue;
    }
    if (rawViewSet.has(scope)) {
      if (entry.waitLeaveView) nextDeniedRaw[scope] = entry;
      continue;
    }
    nextDeniedRaw[scope] = entry.waitLeaveView
      ? { digest: entry.digest, at: entry.at }
      : entry;
  }
  const finalDenied = denyRecordsEqual(prev.denied ?? {}, nextDeniedRaw)
    ? prev.denied
    : nextDeniedRaw;
  const deniedSet = new Set(Object.keys(finalDenied));

  const currentViewSet = new Set(
    candidates.view.filter((scope) => !deniedSet.has(scope)),
  );
  const prevViewSet = new Set(prev.viewScopes ?? []);
  const nextGraceRaw: Record<string, number> = {};
  const expiredGraceCandidates: string[] = [];

  for (const [scope, deadline] of Object.entries(prev.graceDeadlines)) {
    if (currentViewSet.has(scope) || deniedSet.has(scope)) continue;
    if (deadline > now) nextGraceRaw[scope] = deadline;
    else expiredGraceCandidates.push(scope);
  }
  for (const scope of prevViewSet) {
    if (currentViewSet.has(scope) || deniedSet.has(scope)) continue;
    if (graceMs > 0) {
      nextGraceRaw[scope] = now + graceMs;
    } else {
      expiredGraceCandidates.push(scope);
    }
  }

  type PendingEntry = {
    scope: string;
    sources: Set<ScopeSource>;
    lastUsedAt: number;
    graceUntil?: number;
    isCurrentView: boolean;
  };
  const map = new Map<string, PendingEntry>();
  const ensure = (scope: string): PendingEntry => {
    let entry = map.get(scope);
    if (!entry) {
      const prevEntry = prev.active[scope];
      const baseUsedAt =
        prevEntry?.lastUsedAt && prevEntry.lastUsedAt > 0
          ? Math.min(prevEntry.lastUsedAt, now)
          : 0;
      entry = {
        scope,
        sources: new Set(),
        lastUsedAt: baseUsedAt,
        isCurrentView: false,
      };
      map.set(scope, entry);
    }
    return entry;
  };

  for (const scope of candidates.pinned) {
    if (scope !== userScope && deniedSet.has(scope)) continue;
    ensure(scope).sources.add("pinned");
  }
  for (const scope of candidates.membership) {
    if (deniedSet.has(scope)) continue;
    ensure(scope).sources.add("membership");
  }
  for (const follow of candidates.follows) {
    if (deniedSet.has(follow.scope)) continue;
    const entry = ensure(follow.scope);
    entry.sources.add("follows");
    if (follow.at !== undefined) {
      const clampedAt = Math.min(follow.at, now);
      if (clampedAt > entry.lastUsedAt) entry.lastUsedAt = clampedAt;
    }
  }
  for (const scope of currentViewSet) {
    const entry = ensure(scope);
    entry.sources.add("view");
    entry.lastUsedAt = now;
    entry.graceUntil = undefined;
    entry.isCurrentView = true;
  }
  for (const [scope, deadline] of Object.entries(nextGraceRaw)) {
    if (currentViewSet.has(scope) || deniedSet.has(scope)) continue;
    const entry = ensure(scope);
    entry.sources.add("view");
    entry.graceUntil = deadline;
  }
  for (const entry of map.values()) {
    if (entry.lastUsedAt <= 0) entry.lastUsedAt = now;
  }

  const pinnedEntries: PendingEntry[] = [];
  const evictableEntries: PendingEntry[] = [];
  for (const entry of map.values()) {
    if (entry.sources.has("pinned")) pinnedEntries.push(entry);
    else evictableEntries.push(entry);
  }

  pinnedEntries.sort(
    (a, b) =>
      Number(b.scope === userScope) - Number(a.scope === userScope) ||
      b.lastUsedAt - a.lastUsedAt ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
  );
  evictableEntries.sort(
    (a, b) =>
      Number(b.isCurrentView) - Number(a.isCurrentView) ||
      b.lastUsedAt - a.lastUsedAt ||
      highestPriority([...b.sources]) - highestPriority([...a.sources]) ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
  );

  const keptPinned = pinnedEntries.slice(0, budget);
  const remainingSlots = Math.max(0, budget - keptPinned.length);
  const keptEvictable = evictableEntries.slice(0, remainingSlots);
  const evictedEntries = [
    ...pinnedEntries.slice(budget),
    ...evictableEntries.slice(remainingSlots),
  ];

  const kept = [...keptPinned, ...keptEvictable];
  const keptScopes = kept.map((e) => e.scope);
  const keptSet = new Set(keptScopes);

  const evictedScopes = evictedEntries.map((e) => e.scope);
  for (const evicted of evictedScopes) {
    delete nextGraceRaw[evicted];
  }

  const finalGraceDeadlines = numberRecordsEqual(
    prev.graceDeadlines,
    nextGraceRaw,
  )
    ? prev.graceDeadlines
    : nextGraceRaw;

  const nextActiveCandidate: Record<string, ScopeSubscriptionEntry> = {};
  let activeMatchesPrev = Object.keys(prev.active).length === kept.length;
  for (const entry of kept) {
    const nextSources = [...entry.sources];
    const prevEntry = prev.active[entry.scope];
    if (
      prevEntry &&
      arraysEqual(prevEntry.sources, nextSources) &&
      prevEntry.lastUsedAt === entry.lastUsedAt &&
      prevEntry.graceUntil === entry.graceUntil
    ) {
      nextActiveCandidate[entry.scope] = prevEntry;
    } else {
      activeMatchesPrev = false;
      nextActiveCandidate[entry.scope] = {
        scope: entry.scope,
        sources: nextSources,
        lastUsedAt: entry.lastUsedAt,
        ...(entry.graceUntil !== undefined
          ? { graceUntil: entry.graceUntil }
          : {}),
      };
    }
  }
  const finalActive = activeMatchesPrev ? prev.active : nextActiveCandidate;

  const viewScopesList = [...currentViewSet];
  const finalViewScopes = arraysEqual(prev.viewScopes ?? [], viewScopesList)
    ? prev.viewScopes
    : viewScopesList;

  const finalChunks = distributeChunks(
    prev.chunks,
    keptScopes,
    chunkSize,
    chunkCount,
  );

  const addedScopes: string[] = [];
  for (const scope of keptSet) {
    if (!(scope in prev.active)) addedScopes.push(scope);
  }
  const removedScopes: string[] = [];
  for (const scope of Object.keys(prevState.active)) {
    if (!keptSet.has(scope)) removedScopes.push(scope);
  }
  const expiredGraceScopes = expiredGraceCandidates.filter(
    (scope) => !keptSet.has(scope),
  );

  let nextGraceExpiryAt: number | null = null;
  for (const [scope, deadline] of Object.entries(finalGraceDeadlines)) {
    if (currentViewSet.has(scope) || !keptSet.has(scope)) continue;
    if (nextGraceExpiryAt === null || deadline < nextGraceExpiryAt) {
      nextGraceExpiryAt = deadline;
    }
  }

  const unchanged =
    samePrincipal &&
    finalActive === prevState.active &&
    finalChunks === prevState.chunks &&
    finalViewScopes === prevState.viewScopes &&
    finalGraceDeadlines === prevState.graceDeadlines &&
    finalDenied === prevState.denied;

  const state: ScopeSubscriptionState = unchanged
    ? prevState
    : {
        principalId: candidates.principalId,
        active: finalActive,
        chunks: finalChunks,
        viewScopes: finalViewScopes,
        graceDeadlines: finalGraceDeadlines,
        denied: finalDenied,
        peerViews: prev.peerViews,
        serverConfirmed: prev.serverConfirmed,
        lastReconciledAt: now,
      };

  return {
    state,
    activeScopes: keptScopes,
    addedScopes,
    removedScopes,
    evictedScopes,
    expiredGraceScopes,
    nextGraceExpiryAt,
  };
}

export function clearScopeMetaPair(draft: any, scope: string): void {
  delete draft.syncMeta[`synclog:v1:${scope}`];
  delete draft.syncLogScopeStamps[scope];
  if (scope.startsWith("dir:")) {
    const teamId = scope.slice(4);
    delete draft.syncLogScopeStamps[`team:${teamId}`];
  } else if (scope.startsWith("team:")) {
    const teamId = scope.slice(5);
    delete draft.syncLogScopeStamps[`dir:${teamId}`];
  }
}
