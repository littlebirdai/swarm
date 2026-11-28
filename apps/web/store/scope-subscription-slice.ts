import { withCacheEvictions } from "./cache-eviction";
import {
  computeEvictionsForPurge,
  extractScopeCandidates,
  extractViewScopes,
  isKnownHomeScope,
  purgeUnheldScopeRowsInDraft,
  revokeScopeRowsInDraft,
  SCOPE_VIEW_TARGET_OWNERS_MAX,
  isScopeViewTargetKind,
  type PurgeTarget,
  type ScopeViewTarget,
} from "./scope-subscription-candidates";
import {
  SCOPE_HEADS_CHUNK_COUNT,
  SCOPE_HEADS_CHUNK_SIZE,
  SCOPE_SUBSCRIPTION_BUDGET,
  candidatesDigest,
  clearScopeMetaPair,
  distributeChunks,
  initialScopeSubscriptionState,
  reconcileScopeSubscriptions,
  sameStringArray,
  type ScopeDenyEntry,
  type ScopeSubscriptionEntry,
  type ScopeSubscriptionState,
} from "./scope-subscriptions";

function liftDeniedExcludes(draft: any, scopes: ReadonlySet<string>): void {
  if (scopes.size === 0 || !draft.pending) return;
  for (const key of Object.keys(draft.pending)) {
    const entry = draft.pending[key];
    if (entry?.type === "exclude" && scopes.has(entry.scope)) {
      delete draft.pending[key];
    }
  }
}

export function reconcileScopeSubscriptionsInDraft(
  draft: any,
  now: number,
  activePaths?: string[],
  protectedOutboxRows?: ReadonlySet<string>,
): {
  addedScopes: string[];
  removedScopes: string[];
  evictedScopes: string[];
  expiredGraceScopes: string[];
  nextGraceExpiryAt: number | null;
  purged: PurgeTarget[];
} {
  const candidates = extractScopeCandidates(draft, now, { activePaths });
  const prev = draft.scopeSubscriptions ?? initialScopeSubscriptionState();
  const result = reconcileScopeSubscriptions(prev, candidates, now);
  if (result.state !== prev) {
    draft.scopeSubscriptions = result.state;
  }
  const clearedDenied = new Set<string>();
  for (const scope of Object.keys(prev.denied ?? {})) {
    if (!(scope in result.state.denied)) clearedDenied.add(scope);
  }
  liftDeniedExcludes(draft, clearedDenied);

  let purged: PurgeTarget[] = [];
  if (result.removedScopes.length > 0 && candidates.principalId) {
    const outboxRows =
      protectedOutboxRows ??
      (typeof draft._protectedOutboxRows === "function"
        ? draft._protectedOutboxRows()
        : undefined);
    purged = purgeUnheldScopeRowsInDraft(draft, new Set(result.activeScopes), {
      pending: draft.pending,
      protectedOutboxRows: outboxRows,
      viewerId: candidates.principalId,
    });
    for (const scope of result.removedScopes) {
      clearScopeMetaPair(draft, scope);
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

function denyScopesInDraft(
  draft: any,
  scopes: readonly string[],
  now: number,
): PurgeTarget[] {
  if (scopes.length === 0) return [];
  const prev: ScopeSubscriptionState =
    draft.scopeSubscriptions ?? initialScopeSubscriptionState();
  const userId = draft.currentUser?._id
    ? String(draft.currentUser._id)
    : prev.principalId;
  const userScope = userId ? `user:${userId}` : null;
  const toDeny = scopes.filter((s) => s && s !== userScope);
  if (toDeny.length === 0) return [];

  const candidates = extractScopeCandidates(draft, now);
  const digest = candidatesDigest(candidates);
  const rawViewSet = new Set(extractViewScopes(draft));
  const denySet = new Set(toDeny);

  const nextActive: Record<string, ScopeSubscriptionEntry> = {};
  for (const [scope, entry] of Object.entries(prev.active)) {
    if (!denySet.has(scope)) nextActive[scope] = entry;
  }
  const nextGrace: Record<string, number> = {};
  for (const [scope, deadline] of Object.entries(prev.graceDeadlines)) {
    if (!denySet.has(scope)) nextGrace[scope] = deadline;
  }
  const nextViewScopes = (prev.viewScopes ?? []).filter(
    (scope) => !denySet.has(scope),
  );
  const nextDenied: Record<string, ScopeDenyEntry> = { ...prev.denied };
  for (const scope of toDeny) {
    nextDenied[scope] = rawViewSet.has(scope)
      ? { digest, at: now, waitLeaveView: true }
      : { digest, at: now };
    clearScopeMetaPair(draft, scope);
  }
  const nextChunks = distributeChunks(
    prev.chunks,
    Object.keys(nextActive),
    SCOPE_HEADS_CHUNK_SIZE,
    SCOPE_HEADS_CHUNK_COUNT,
  );
  draft.scopeSubscriptions = {
    ...prev,
    active: nextActive,
    chunks: nextChunks,
    viewScopes: nextViewScopes,
    graceDeadlines: nextGrace,
    denied: nextDenied,
    lastReconciledAt: now,
  };

  return revokeScopeRowsInDraft(draft, denySet, now, userScope);
}

function cleanViewTargets(
  targets: readonly ScopeViewTarget[],
): ScopeViewTarget[] {
  const seen = new Set<string>();
  const out: ScopeViewTarget[] = [];
  for (const target of targets) {
    if (!target || !isScopeViewTargetKind(target.kind)) continue;
    if (typeof target.id !== "string" || target.id.length === 0) continue;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: target.kind, id: target.id });
  }
  return out;
}

function sameViewTargets(
  a: readonly ScopeViewTarget[] | undefined,
  b: readonly ScopeViewTarget[],
): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((t, i) => t.kind === b[i].kind && t.id === b[i].id);
}

export type ScopeSubscriptionSlice = {
  scopeSubscriptions: ScopeSubscriptionState;
  scopeViewTargets: Record<string, ScopeViewTarget[]>;
  setScopeViewTargets: (
    owner: string,
    targets: readonly ScopeViewTarget[],
  ) => void;
  reconcileScopeSubscriptions: (
    now?: number,
    activePaths?: string[],
  ) => ReturnType<typeof reconcileScopeSubscriptionsInDraft>;
  purgeUnheldScopeRows: (
    heldScopes?: ReadonlySet<string> | readonly string[],
  ) => PurgeTarget[];
  denyScopeSubscriptions: (
    scopes: readonly string[],
    now?: number,
  ) => PurgeTarget[];
  clearDeniedScopeSubscriptions: (scopes?: readonly string[]) => void;
  revokeTeamScope: (teamId: string, now?: number) => PurgeTarget[];
  setPeerViewScopes: (peerId: string, scopes: readonly string[]) => void;
  clearPeerViewScopes: () => void;
  _commitScopeReconcile: (
    now: number,
    activePaths?: string[],
    protectedOutboxRows?: ReadonlySet<string>,
  ) => ReturnType<typeof reconcileScopeSubscriptionsInDraft>;
  _commitScopeEvict: (
    heldScopes: ReadonlySet<string>,
    protectedOutboxRows?: ReadonlySet<string>,
  ) => PurgeTarget[];
  _commitScopeDeny: (scopes: readonly string[], now: number) => PurgeTarget[];
};

export function createScopeSubscriptionSlice(
  syncFn: <F extends (...args: any[]) => any>(fn: F) => F,
  getState?: () => any,
): ScopeSubscriptionSlice {
  const readState = (self: any) => (getState ? getState() : self);

  return {
    scopeSubscriptions: initialScopeSubscriptionState(),
    scopeViewTargets: {},

    setScopeViewTargets: syncFn(function (
      this: any,
      owner: string,
      targets: readonly ScopeViewTarget[],
    ) {
      if (!owner) return;
      const prev: Record<string, ScopeViewTarget[]> =
        this.scopeViewTargets ?? {};
      const clean = cleanViewTargets(targets);
      if (clean.length === 0) {
        if (!(owner in prev)) return;
        const next = { ...prev };
        delete next[owner];
        this.scopeViewTargets = next;
        return;
      }
      if (sameViewTargets(prev[owner], clean)) return;
      const next: Record<string, ScopeViewTarget[]> = {};
      const others = Object.keys(prev).filter((k) => k !== owner);
      const keep = others.slice(
        Math.max(0, others.length - (SCOPE_VIEW_TARGET_OWNERS_MAX - 1)),
      );
      for (const k of keep) next[k] = prev[k];
      next[owner] = clean;
      this.scopeViewTargets = next;
    }),

    _commitScopeReconcile: syncFn(function (
      this: any,
      now: number,
      activePaths?: string[],
      protectedOutboxRows?: ReadonlySet<string>,
    ) {
      return reconcileScopeSubscriptionsInDraft(
        this,
        now,
        activePaths,
        protectedOutboxRows,
      );
    }),

    _commitScopeEvict: syncFn(function (
      this: any,
      heldScopes: ReadonlySet<string>,
      protectedOutboxRows?: ReadonlySet<string>,
    ) {
      return purgeUnheldScopeRowsInDraft(this, heldScopes, {
        pending: this.pending,
        protectedOutboxRows,
        viewerId: this.currentUser?._id ? String(this.currentUser._id) : null,
      });
    }),

    _commitScopeDeny: syncFn(function (
      this: any,
      scopes: readonly string[],
      now: number,
    ) {
      return denyScopesInDraft(this, scopes, now);
    }),

    reconcileScopeSubscriptions(
      this: any,
      now = Date.now(),
      activePaths?: string[],
    ) {
      const state = readState(this);
      const outboxRows = state._protectedOutboxRows?.();
      const candidates = extractScopeCandidates(state, now, { activePaths });
      const prev: ScopeSubscriptionState =
        state.scopeSubscriptions ?? initialScopeSubscriptionState();
      const preview = reconcileScopeSubscriptions(prev, candidates, now);
      if (preview.state === prev && preview.removedScopes.length === 0) {
        return {
          addedScopes: [],
          removedScopes: [],
          evictedScopes: [],
          expiredGraceScopes: [],
          nextGraceExpiryAt: preview.nextGraceExpiryAt,
          purged: [],
        };
      }
      const { evictions } =
        preview.removedScopes.length > 0 && candidates.principalId
          ? computeEvictionsForPurge(state, new Set(preview.activeScopes), {
              pending: state.pending,
              protectedOutboxRows: outboxRows,
              viewerId: candidates.principalId,
            })
          : { evictions: [] };
      let out!: ReturnType<typeof reconcileScopeSubscriptionsInDraft>;
      if (evictions.length > 0) {
        withCacheEvictions(evictions, () => {
          out = state._commitScopeReconcile(now, activePaths, outboxRows);
        });
      } else {
        out = state._commitScopeReconcile(now, activePaths, outboxRows);
      }
      return out;
    },

    purgeUnheldScopeRows(
      this: any,
      heldScopes?: ReadonlySet<string> | readonly string[],
    ) {
      const state = readState(this);
      if (!state.scopeSubscriptions) return [];
      const outboxRows = state._protectedOutboxRows?.();
      const set =
        heldScopes instanceof Set
          ? heldScopes
          : new Set(heldScopes ?? Object.keys(state.scopeSubscriptions.active));
      const { evictions } = computeEvictionsForPurge(state, set, {
        pending: state.pending,
        protectedOutboxRows: outboxRows,
        viewerId: state.currentUser?._id ? String(state.currentUser._id) : null,
      });
      if (evictions.length === 0) return [];
      let out: PurgeTarget[] = [];
      withCacheEvictions(evictions, () => {
        out = state._commitScopeEvict(set, outboxRows);
      });
      return out;
    },

    denyScopeSubscriptions(
      this: any,
      scopes: readonly string[],
      now = Date.now(),
    ) {
      if (scopes.length === 0) return [];
      const state = readState(this);
      const userId = state.currentUser?._id
        ? String(state.currentUser._id)
        : state.scopeSubscriptions?.principalId;
      const userScope = userId ? `user:${userId}` : null;
      const denySet = new Set(scopes.filter((s) => s && s !== userScope));
      if (denySet.size === 0) return [];
      return state._commitScopeDeny([...denySet], now);
    },

    revokeTeamScope(this: any, teamId: string, now = Date.now()) {
      if (!teamId) return [];
      const state = readState(this);
      const out = state._commitScopeDeny([`dir:${teamId}`], now);
      state.dropTeamFeedCache(teamId);
      return out;
    },

    clearDeniedScopeSubscriptions: syncFn(function (
      this: any,
      scopes?: readonly string[],
    ) {
      const denied = this.scopeSubscriptions?.denied;
      if (!denied || Object.keys(denied).length === 0) return;
      if (!scopes) {
        liftDeniedExcludes(this, new Set(Object.keys(denied)));
        this.scopeSubscriptions = {
          ...this.scopeSubscriptions,
          denied: {},
        };
        return;
      }
      const cleared = new Set<string>();
      const next = { ...denied };
      for (const s of scopes) {
        if (s in next) {
          delete next[s];
          cleared.add(s);
        }
      }
      if (cleared.size > 0) {
        liftDeniedExcludes(this, cleared);
        this.scopeSubscriptions = {
          ...this.scopeSubscriptions,
          denied: next,
        };
      }
    }),

    setPeerViewScopes: syncFn(function (
      this: any,
      peerId: string,
      scopes: readonly string[],
    ) {
      if (!peerId) return;
      const prev = this.scopeSubscriptions ?? initialScopeSubscriptionState();
      const clean = [
        ...new Set(
          scopes.filter(
            (s): s is string => typeof s === "string" && isKnownHomeScope(s),
          ),
        ),
      ]
        .sort()
        .slice(0, SCOPE_SUBSCRIPTION_BUDGET);
      const prevScopes = prev.peerViews?.[peerId] ?? [];
      if (sameStringArray(prevScopes, clean)) return;
      const nextPeerViews = { ...(prev.peerViews ?? {}) };
      if (clean.length === 0) {
        delete nextPeerViews[peerId];
      } else {
        nextPeerViews[peerId] = clean;
      }
      this.scopeSubscriptions = {
        ...prev,
        peerViews: nextPeerViews,
      };
    }),

    clearPeerViewScopes: syncFn(function (this: any) {
      const prev = this.scopeSubscriptions;
      if (!prev?.peerViews || Object.keys(prev.peerViews).length === 0) return;
      this.scopeSubscriptions = {
        ...prev,
        peerViews: {},
      };
    }),
  };
}
