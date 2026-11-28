import {
  SCOPE_FOLLOW_WINDOW_MS,
  computePurgeSet,
  extractScopeCandidates,
  purgeUnheldScopeRowsInDraft,
  rowHomeScope,
  type PurgeTarget,
  type ScopeCandidates,
  type ScopeFollowCandidate,
  type ScopeScopedCollection,
  type ScopeStoreInput,
} from "./scope-subscription-candidates";

export {
  SCOPE_FOLLOW_WINDOW_MS,
  computePurgeSet,
  extractScopeCandidates,
  purgeUnheldScopeRowsInDraft,
  rowHomeScope,
  type PurgeTarget,
  type ScopeCandidates,
  type ScopeFollowCandidate,
  type ScopeScopedCollection,
  type ScopeStoreInput,
};

export const SCOPE_SUBSCRIPTION_BUDGET = 64;
export const SCOPE_HEADS_CHUNK_SIZE = 16;
export const SCOPE_HEADS_CHUNK_COUNT = Math.ceil(
  SCOPE_SUBSCRIPTION_BUDGET / SCOPE_HEADS_CHUNK_SIZE,
);
export const SCOPE_VIEW_GRACE_MS = 60 * 1000;

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

export type ScopeSubscriptionState = {
  principalId: string | null;
  active: Record<string, ScopeSubscriptionEntry>;
  chunks: string[][];
  graceDeadlines: Record<string, number>;
  touches: Record<string, number>;
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
    graceDeadlines: {},
    touches: {},
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

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

  const prev =
    prevState.principalId === candidates.principalId
      ? prevState
      : {
          ...initialScopeSubscriptionState(),
          principalId: candidates.principalId,
        };

  if (!candidates.principalId) {
    const empty = initialScopeSubscriptionState();
    return {
      state: empty,
      activeScopes: [],
      addedScopes: [],
      removedScopes: Object.keys(prevState.active),
      evictedScopes: [],
      expiredGraceScopes: [],
      nextGraceExpiryAt: null,
    };
  }

  const currentViewSet = new Set(candidates.view);
  const nextGraceDeadlines: Record<string, number> = {};
  const expiredGraceCandidates: string[] = [];

  for (const [scope, deadline] of Object.entries(prev.graceDeadlines)) {
    if (currentViewSet.has(scope)) continue;
    if (deadline > now) nextGraceDeadlines[scope] = deadline;
    else expiredGraceCandidates.push(scope);
  }
  for (const scope of currentViewSet) {
    nextGraceDeadlines[scope] = now + graceMs;
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
      const touchedAt = prev.touches[scope];
      const baseUsedAt = Math.max(prevEntry?.lastUsedAt ?? 0, touchedAt ?? 0);
      entry = {
        scope,
        sources: new Set(),
        lastUsedAt: baseUsedAt > 0 ? baseUsedAt : now,
        isCurrentView: false,
      };
      map.set(scope, entry);
    }
    return entry;
  };

  for (const scope of candidates.pinned) ensure(scope).sources.add("pinned");
  for (const scope of candidates.membership) {
    ensure(scope).sources.add("membership");
  }
  for (const follow of candidates.follows) {
    const entry = ensure(follow.scope);
    entry.sources.add("follows");
    if (follow.at !== undefined && follow.at > entry.lastUsedAt) {
      entry.lastUsedAt = follow.at;
    }
  }
  for (const scope of currentViewSet) {
    const entry = ensure(scope);
    entry.sources.add("view");
    entry.lastUsedAt = Math.max(entry.lastUsedAt, now);
    entry.graceUntil = nextGraceDeadlines[scope];
    entry.isCurrentView = true;
  }
  for (const [scope, deadline] of Object.entries(nextGraceDeadlines)) {
    if (currentViewSet.has(scope)) continue;
    const entry = ensure(scope);
    entry.sources.add("view");
    entry.graceUntil = deadline;
  }

  const pinnedEntries: PendingEntry[] = [];
  const evictableEntries: PendingEntry[] = [];
  for (const entry of map.values()) {
    if (entry.sources.has("pinned")) pinnedEntries.push(entry);
    else evictableEntries.push(entry);
  }

  pinnedEntries.sort(
    (a, b) =>
      b.lastUsedAt - a.lastUsedAt ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
  );
  evictableEntries.sort(
    (a, b) =>
      b.lastUsedAt - a.lastUsedAt ||
      Number(b.isCurrentView) - Number(a.isCurrentView) ||
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
  const keptSet = new Set(kept.map((e) => e.scope));

  const nextActive: Record<string, ScopeSubscriptionEntry> = {};
  for (const entry of kept) {
    nextActive[entry.scope] = {
      scope: entry.scope,
      sources: [...entry.sources],
      lastUsedAt: entry.lastUsedAt,
      ...(entry.graceUntil !== undefined
        ? { graceUntil: entry.graceUntil }
        : {}),
    };
  }

  const evictedScopes = evictedEntries.map((e) => e.scope);
  for (const evicted of evictedScopes) {
    delete nextGraceDeadlines[evicted];
  }

  const nextTouches: Record<string, number> = {};
  for (const [scope, ts] of Object.entries(prev.touches)) {
    if (keptSet.has(scope)) nextTouches[scope] = ts;
  }

  const prevChunks = prev.chunks;
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

  for (const entry of kept) {
    if (assigned.has(entry.scope)) continue;
    for (let i = 0; i < chunkCount; i++) {
      if (nextChunks[i].length < chunkSize) {
        nextChunks[i].push(entry.scope);
        assigned.add(entry.scope);
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
  const finalChunks = chunksChanged ? nextChunks : prevChunks;

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
  for (const [scope, deadline] of Object.entries(nextGraceDeadlines)) {
    if (currentViewSet.has(scope) || !keptSet.has(scope)) continue;
    if (nextGraceExpiryAt === null || deadline < nextGraceExpiryAt) {
      nextGraceExpiryAt = deadline;
    }
  }

  return {
    state: {
      principalId: candidates.principalId,
      active: nextActive,
      chunks: finalChunks,
      graceDeadlines: nextGraceDeadlines,
      touches: nextTouches,
      lastReconciledAt: now,
    },
    activeScopes: kept.map((e) => e.scope),
    addedScopes,
    removedScopes,
    evictedScopes,
    expiredGraceScopes,
    nextGraceExpiryAt,
  };
}

export function touchScopeSubscriptionInState(
  prev: ScopeSubscriptionState,
  scope: string,
  now: number,
): ScopeSubscriptionState {
  if (!scope) return prev;
  const existing = prev.active[scope];
  const prevTouch = prev.touches[scope] ?? 0;
  const nextTouch = Math.max(prevTouch, now);
  if (existing && existing.lastUsedAt >= nextTouch && prevTouch >= nextTouch) {
    return prev;
  }
  return {
    ...prev,
    touches: { ...prev.touches, [scope]: nextTouch },
    ...(existing
      ? {
          active: {
            ...prev.active,
            [scope]: {
              ...existing,
              lastUsedAt: Math.max(existing.lastUsedAt, nextTouch),
            },
          },
        }
      : {}),
  };
}

export function reconcileScopeSubscriptionsInDraft(
  draft: any,
  now: number,
  activePaths?: string[],
): {
  addedScopes: string[];
  removedScopes: string[];
  evictedScopes: string[];
  expiredGraceScopes: string[];
  nextGraceExpiryAt: number | null;
  purged: PurgeTarget[];
} {
  if (!clientScopeSubscriptionsEnabled()) {
    return {
      addedScopes: [],
      removedScopes: [],
      evictedScopes: [],
      expiredGraceScopes: [],
      nextGraceExpiryAt: null,
      purged: [],
    };
  }
  const candidates = extractScopeCandidates(draft, now, { activePaths });
  const prev = draft.scopeSubscriptions ?? initialScopeSubscriptionState();
  const result = reconcileScopeSubscriptions(prev, candidates, now);
  draft.scopeSubscriptions = result.state;
  for (const scope of result.addedScopes) {
    for (const [key, entry] of Object.entries(draft.pending ?? {})) {
      if (
        (entry as any)?.type === "exclude" &&
        (entry as any).scope === scope
      ) {
        delete draft.pending[key];
      }
    }
  }
  let purged: PurgeTarget[] = [];
  if (result.removedScopes.length > 0 && candidates.principalId) {
    purged = purgeUnheldScopeRowsInDraft(
      draft,
      new Set(result.activeScopes),
      now,
    );
    for (const scope of result.removedScopes) {
      const metaKey = `synclog:v1:${scope}`;
      delete draft.syncMeta[metaKey];
      delete draft.syncLogScopeStamps[scope];
    }
  }
  return {
    addedScopes: result.addedScopes,
    removedScopes: result.removedScopes,
    evictedScopes: result.evictedScopes,
    expiredGraceScopes: result.expiredGraceScopes,
    nextGraceExpiryAt: result.nextGraceExpiryAt,
    purged,
  };
}

export type ScopeSubscriptionSlice = {
  scopeSubscriptions: ScopeSubscriptionState;
  reconcileScopeSubscriptions: (
    now?: number,
    activePaths?: string[],
  ) => ReturnType<typeof reconcileScopeSubscriptionsInDraft>;
  touchScopeSubscription: (scope: string, now?: number) => void;
  purgeUnheldScopeRows: (
    heldScopes?: ReadonlySet<string> | readonly string[],
  ) => PurgeTarget[];
};

export function createScopeSubscriptionSlice(
  syncFn: <F extends (...args: any[]) => any>(fn: F) => F,
): ScopeSubscriptionSlice {
  return {
    scopeSubscriptions: initialScopeSubscriptionState(),
    reconcileScopeSubscriptions: syncFn(function (
      this: any,
      now = Date.now(),
      activePaths?: string[],
    ) {
      return reconcileScopeSubscriptionsInDraft(this, now, activePaths);
    }),
    touchScopeSubscription: syncFn(function (
      this: any,
      scope: string,
      now = Date.now(),
    ) {
      this.scopeSubscriptions = touchScopeSubscriptionInState(
        this.scopeSubscriptions,
        scope,
        now,
      );
    }),
    purgeUnheldScopeRows: syncFn(function (
      this: any,
      heldScopes?: ReadonlySet<string> | readonly string[],
    ) {
      const set =
        heldScopes instanceof Set
          ? heldScopes
          : new Set(heldScopes ?? Object.keys(this.scopeSubscriptions.active));
      return purgeUnheldScopeRowsInDraft(this, set, Date.now());
    }),
  };
}
