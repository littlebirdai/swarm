import { useCallback, useMemo, useRef } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { whileWindowVisible } from "../lib/windowVisibleWork";
import {
  activeTabPaths,
  findEntityRow,
} from "../store/scope-subscription-candidates";
import {
  SCOPE_HEADS_CHUNK_COUNT,
  clientScopeSubscriptionsEnabled,
} from "../store/scope-subscriptions";
import { syncLogScopeMetaKey, useInboxStore } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { onSyncWake } from "./syncWake";
import { useIsSyncHost } from "./use-sync-role";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

const api = _api as any;

export type ScopeHead = { scope_key: string; position: number; floor: number };

function fnvMix(hash: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function hashList(parts: readonly string[]): string {
  let h1 = 2166136261;
  let h2 = 33554467;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    h1 = fnvMix(h1 ^ 0x9e, p);
    h2 = fnvMix(h2 ^ (i + 1), p);
  }
  return `${h1.toString(36)}:${h2.toString(36)}:${parts.length}`;
}

function makeArrayDigest<T>(
  project: (item: T) => string,
): (arr: readonly T[] | undefined) => string {
  const cache = new WeakMap<object, string>();
  return (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return "0";
    const hit = cache.get(arr);
    if (hit !== undefined) return hit;
    let h1 = 2166136261;
    let h2 = 33554467;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const s =
        item && typeof item === "object" ? project(item) : String(item ?? "");
      h1 = fnvMix(h1 ^ 0x7f, s);
      h2 = fnvMix(h2 ^ (i + 1), s);
    }
    const out = `${h1.toString(36)}:${h2.toString(36)}:${arr.length}`;
    cache.set(arr, out);
    return out;
  };
}

const layoutCache = new WeakMap<object, string>();
function layoutDigest(layout: any): string {
  if (!layout || typeof layout !== "object") return "";
  const hit = layoutCache.get(layout);
  if (hit !== undefined) return hit;
  const out = hashList([JSON.stringify(layout)]);
  layoutCache.set(layout, out);
  return out;
}

const peerViewsCache = new WeakMap<object, string>();
function peerViewsDigest(
  peerViews: Record<string, string[]> | undefined,
): string {
  if (!peerViews || typeof peerViews !== "object") return "0";
  const hit = peerViewsCache.get(peerViews);
  if (hit !== undefined) return hit;
  const entries: string[] = [];
  for (const peerId in peerViews) {
    const scopes = peerViews[peerId];
    if (Array.isArray(scopes) && scopes.length > 0) {
      entries.push(`${peerId}:${scopes.join(",")}`);
    }
  }
  entries.sort();
  const out = entries.length ? hashList(entries) : "0";
  peerViewsCache.set(peerViews, out);
  return out;
}

const projectsSig = makeCollectionSig<any>(
  (p) =>
    `${p._id ?? ""}|${p.short_id ?? ""}|${p.user_id ?? ""}|${p.owner_role_id ?? ""}|${p.workspace ?? ""}|${p.team_id ?? ""}|${p.starred ? 1 : 0}|${p.is_favorite ? 1 : 0}`,
);
const rolesSig = makeCollectionSig<any>(
  (r) =>
    `${r._id ?? ""}|${r.host_user_id ?? ""}|${r.status ?? ""}|${(r.scope?.project_ids ?? []).join(",")}`,
);
const channelsSig = makeCollectionSig<any>(
  (c) => `${c._id ?? ""}|${c.archived_at ?? ""}`,
);
const readsSig = makeCollectionSig<any>(
  (r) => `${r.channel_id ?? ""}|${r.notify_level ?? ""}|${r.updated_at ?? 0}`,
);
const teamsDigest = makeArrayDigest<any>((t) => String(t._id ?? ""));
const railDigest = makeArrayDigest<any>(
  (r) => `${r.channel_id ?? ""}:${r.joined ? 1 : 0}:${r.notify_level ?? ""}`,
);
const pinsDigest = makeArrayDigest<any>((p) => `${p.kind ?? ""}:${p.id ?? ""}`);
const visitsDigest = makeArrayDigest<any>(
  (v) => `${v.kind ?? ""}:${v.key ?? ""}:${v.path ?? ""}:${v.ts ?? 0}`,
);

function activeEntityDigest(s: any, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const parts: string[] = [];
  for (const rawPath of paths) {
    const clean = rawPath.split(/[?#]/)[0];
    const m = clean.match(/^\/(tasks|docs|plans)\/([^/]+)/);
    if (!m) continue;
    const [, kind, refEncoded] = m;
    let ref = refEncoded;
    try {
      ref = decodeURIComponent(refEncoded);
    } catch {
      continue;
    }
    const row =
      kind === "tasks"
        ? findEntityRow(s.tasks, ref)
        : kind === "docs"
          ? findEntityRow(s.docs, ref, s.docDetails)
          : findEntityRow(s.plans, ref);
    parts.push(
      row
        ? `${kind}:${ref}:${row._id ?? ""}:${row.home_scope ?? ""}:${row.project_id ?? ""}:${row.workspace ?? ""}`
        : `${kind}:${ref}:missing`,
    );
  }
  return parts.length ? hashList(parts) : "";
}

export function scopeInputsSig(s: any): string {
  const userId = s.currentUser?._id ? String(s.currentUser._id) : "";
  const activeTab =
    Array.isArray(s.tabs) && s.activeTabId
      ? s.tabs.find((t: any) => t?.id === s.activeTabId)
      : undefined;
  const activeTabOnly = activeTab
    ? { activeTabId: s.activeTabId, tabs: [activeTab] }
    : { activeTabId: s.activeTabId, tabs: [] };
  const paths = activeTabPaths(activeTabOnly);
  const activeTabHash = activeTab
    ? `${activeTab.id ?? ""}:${activeTab.path ?? ""}:${layoutDigest(activeTab.layout)}`
    : "";
  return hashList([
    userId,
    teamsDigest(s.teams),
    projectsSig(s.projects ?? {}),
    rolesSig(s.viewerRoles ?? {}),
    channelsSig(s.chatChannels ?? {}),
    readsSig(s.chatReads ?? {}),
    railDigest(s.chatRail),
    pinsDigest(s.clientState?.ui?.sidebar_pins),
    visitsDigest(s.recentVisits),
    String(s.activeTabId ?? ""),
    activeTabHash,
    activeEntityDigest(s, paths),
    peerViewsDigest(s.scopeSubscriptions?.peerViews),
  ]);
}

export function makeScopeRunQueue() {
  let all = false;
  let scopes: Set<string> | null = null;
  return {
    add(next?: readonly string[]) {
      if (next) {
        if (!all) {
          scopes ??= new Set();
          for (const s of next) scopes.add(s);
        }
      } else {
        all = true;
        scopes = null;
      }
    },
    take(): string[] | undefined {
      const out = all ? undefined : scopes ? [...scopes] : undefined;
      all = false;
      scopes = null;
      return out;
    },
    clear() {
      all = false;
      scopes = null;
    },
  };
}

export function scopedCatchUpScopes(
  store: any,
  scopes?: readonly string[],
): string[] | null {
  if (!clientScopeSubscriptionsEnabled()) return null;
  if (scopes) return [...scopes];
  return Object.keys(store.scopeSubscriptions?.active ?? {});
}

export function teamIdFromScopeKey(scopeKey: string): string | null {
  if (scopeKey.startsWith("team:")) return scopeKey.slice(5);
  if (scopeKey.startsWith("dir:")) return scopeKey.slice(4);
  return null;
}

export function applyScopeLifecycleEvent(
  store: any,
  op: string,
  entityId: string,
  purgedTeams: Set<string>,
): void {
  const scopedEnabled = clientScopeSubscriptionsEnabled();
  if (op === "scope_removed") {
    store.purgeTeamScopeRows(entityId);
    store.clearSyncMeta(syncLogScopeMetaKey(`team:${entityId}`));
    if (scopedEnabled) {
      store.clearSyncMeta(syncLogScopeMetaKey(`dir:${entityId}`));
      store.denyScopeSubscriptions?.([`dir:${entityId}`]);
    }
    purgedTeams.add(entityId);
  } else if (op === "scope_added") {
    store.clearCrawlMetaForScope(`team:${entityId}`);
    store.liftScopeExcludes(`team:${entityId}`);
    if (scopedEnabled) {
      store.clearCrawlMetaForScope(`dir:${entityId}`);
      store.liftScopeExcludes(`dir:${entityId}`);
      store.clearDeniedScopeSubscriptions?.([`dir:${entityId}`]);
    }
    store.bumpSyncLogFloorEpoch();
    purgedTeams.delete(entityId);
  }
}

export function resetTeamResyncCaches(store: any, scopeKey: string): void {
  const scopedEnabled = clientScopeSubscriptionsEnabled();
  const teamId = scopedEnabled
    ? teamIdFromScopeKey(scopeKey)
    : scopeKey.startsWith("team:")
      ? scopeKey.slice(5)
      : null;
  if (!teamId) return;
  store.dropTeamFeedCache(teamId);
  if (scopedEnabled) {
    store.clearCrawlMetaForScope(`team:${teamId}`);
    store.clearCrawlMetaForScope(`dir:${teamId}`);
  }
}

export function isPurgedTeamHead(
  scopeKey: string,
  purgedTeams: ReadonlySet<string>,
): boolean {
  const teamId = clientScopeSubscriptionsEnabled()
    ? teamIdFromScopeKey(scopeKey)
    : scopeKey.startsWith("team:")
      ? scopeKey.slice(5)
      : null;
  return !!teamId && purgedTeams.has(teamId);
}

export function stampCatchUpScope(store: any, scopeKey: string): void {
  store.stampSyncLogScope(scopeKey);
  if (!clientScopeSubscriptionsEnabled()) return;
  if (scopeKey.startsWith("dir:")) {
    store.stampSyncLogScope(`team:${scopeKey.slice(4)}`);
  } else if (scopeKey.startsWith("team:")) {
    store.stampSyncLogScope(`dir:${scopeKey.slice(5)}`);
  }
}

export async function confirmCatchUpInterestScopes(
  store: any,
  scopeList: readonly string[] | null,
  heads: readonly ScopeHead[],
  interestScopesCapability: boolean | undefined,
  probeUserAndDirHeads: (scopes: readonly string[]) => Promise<ScopeHead[]>,
): Promise<boolean> {
  if (!clientScopeSubscriptionsEnabled() || !scopeList) return false;
  if (
    serverConfirmedInterestScopes(scopeList, heads, interestScopesCapability)
  ) {
    store.setScopeServerConfirmed?.(true);
    return true;
  }
  if (heads.some((h) => h.scope_key.startsWith("team:"))) {
    store.setScopeServerConfirmed?.(false);
    return false;
  }
  if (heads.length === 0 && store.currentUser?._id) {
    const userScope = `user:${String(store.currentUser._id)}`;
    if (!scopeList.includes(userScope)) {
      const dirScopes = Object.keys(
        store.scopeSubscriptions?.active ?? {},
      ).filter((s) => s.startsWith("dir:"));
      const probeHeads = await probeUserAndDirHeads([
        userScope,
        ...dirScopes.slice(0, 15),
      ]);
      if (
        probeHeads.length > 0 &&
        !probeHeads.some((h) => h.scope_key.startsWith("team:")) &&
        (store.scopeSubscriptions?.serverConfirmed ||
          probeHeads.some((h) => h.scope_key.startsWith("dir:")))
      ) {
        store.setScopeServerConfirmed?.(true);
        return true;
      }
    }
  }
  return false;
}

export function serverConfirmedInterestScopes(
  requestedScopes: readonly string[] | null,
  heads: readonly ScopeHead[],
  capability?: boolean,
): boolean {
  if (capability === true) return true;
  if (capability === false) return false;
  if (!requestedScopes || requestedScopes.length === 0 || heads.length === 0) {
    return false;
  }
  if (heads.some((h) => h.scope_key.startsWith("team:"))) return false;
  const reqSet = new Set(requestedScopes);
  if (!heads.every((h) => reqSet.has(h.scope_key))) return false;
  return heads.some(
    (h) =>
      h.scope_key.startsWith("dir:") ||
      h.scope_key.startsWith("project:") ||
      h.scope_key.startsWith("channel:"),
  );
}

export function handleUnauthorizedScope(
  store: any,
  scopeKey: string,
  metaKey: string,
  purgedTeams: Set<string>,
): void {
  if (!clientScopeSubscriptionsEnabled()) {
    if (scopeKey.startsWith("team:")) {
      const teamId = scopeKey.slice(5);
      store.purgeTeamScopeRows(teamId);
      store.clearSyncMeta(metaKey);
      purgedTeams.add(teamId);
    }
    return;
  }
  const teamId = teamIdFromScopeKey(scopeKey);
  if (teamId) {
    store.purgeTeamScopeRows(teamId);
    store.clearSyncMeta(syncLogScopeMetaKey(`team:${teamId}`));
    store.clearSyncMeta(syncLogScopeMetaKey(`dir:${teamId}`));
    store.denyScopeSubscriptions?.([`dir:${teamId}`]);
    purgedTeams.add(teamId);
    return;
  }
  store.clearSyncMeta(metaKey);
  if (store.denyScopeSubscriptions) {
    store.denyScopeSubscriptions([scopeKey]);
    return;
  }
  const surviving = Object.keys(store.scopeSubscriptions?.active ?? {}).filter(
    (k) => k !== scopeKey,
  );
  store.purgeUnheldScopeRows(surviving);
}

export function sweepAfterHeads(
  store: any,
  heads: readonly ScopeHead[],
  requestedScopes: readonly string[] | null,
  serverConfirmed = false,
): void {
  if (requestedScopes && serverConfirmed) {
    sweepMissingInterestScopes(store, requestedScopes, heads, true);
    return;
  }
  if (heads.length === 0) return;
  const present = new Set(heads.map((h) => h.scope_key));
  for (const key of Object.keys(store.syncMeta)) {
    if (!key.startsWith("synclog:v1:team:")) continue;
    const scopeKey = key.slice("synclog:v1:".length);
    if (present.has(scopeKey)) continue;
    const teamId = scopeKey.slice(5);
    store.purgeTeamScopeRows(teamId);
    store.clearSyncMeta(key);
    store.clearCrawlMetaForScope(scopeKey);
    if (clientScopeSubscriptionsEnabled()) {
      store.clearSyncMeta(syncLogScopeMetaKey(`dir:${teamId}`));
      store.clearCrawlMetaForScope(`dir:${teamId}`);
    }
  }
}

export function sweepMissingInterestScopes(
  store: any,
  requestedScopes: readonly string[],
  heads: readonly ScopeHead[],
  allowEmptyHeads = false,
): void {
  if (!allowEmptyHeads && heads.length === 0) return;
  const present = new Set(heads.map((h) => h.scope_key));
  const deniedToDrop: string[] = [];
  for (const scope of requestedScopes) {
    if (present.has(scope) || scope.startsWith("user:")) continue;
    if (scope.startsWith("dir:")) {
      const teamId = scope.slice(4);
      store.purgeTeamScopeRows(teamId);
      store.clearSyncMeta(syncLogScopeMetaKey(scope));
      store.clearSyncMeta(syncLogScopeMetaKey(`team:${teamId}`));
      store.clearCrawlMetaForScope(`team:${teamId}`);
      store.clearCrawlMetaForScope(scope);
      deniedToDrop.push(scope);
      continue;
    }
    store.clearSyncMeta(syncLogScopeMetaKey(scope));
    deniedToDrop.push(scope);
  }
  if (deniedToDrop.length > 0) {
    if (store.denyScopeSubscriptions) {
      store.denyScopeSubscriptions(deniedToDrop);
    } else {
      const dropSet = new Set(deniedToDrop);
      const surviving = Object.keys(
        store.scopeSubscriptions?.active ?? {},
      ).filter((k) => !dropSet.has(k));
      store.purgeUnheldScopeRows(surviving);
    }
  }
}

export function useScopeSubscriptions(opts?: {
  enabled?: boolean;
  onChunkWake?: (
    scopes: readonly string[],
    heads: readonly ScopeHead[],
  ) => void;
}): {
  enabled: boolean;
  active: boolean;
  activeScopes: string[];
  chunks: string[][];
  chunkHeads: Array<{ heads: ScopeHead[] } | undefined>;
} {
  const enabled = opts?.enabled ?? clientScopeSubscriptionsEnabled();
  const isSyncHost = useIsSyncHost();
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const hasUser = useInboxStore((s) => !!s.currentUser?._id);
  const active = enabled && isSyncHost && hydrated && hasUser;

  const inputsSig = useInboxStore((s) => (active ? scopeInputsSig(s) : ""));
  const chunks = useInboxStore((s) => s.scopeSubscriptions.chunks);

  useWatchEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const clear = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const reconcile = () => {
      if (disposed) return;
      clear();
      const res = useInboxStore
        .getState()
        .reconcileScopeSubscriptions(Date.now());
      if (!disposed && res.nextGraceExpiryAt !== null) {
        timer = setTimeout(
          reconcile,
          Math.max(0, res.nextGraceExpiryAt - Date.now()),
        );
      }
    };
    const stopVisible = whileWindowVisible(() => {
      reconcile();
      return clear;
    });
    return () => {
      disposed = true;
      stopVisible();
    };
  }, [active, inputsSig]);

  const subArgs = (chunk: readonly string[] | undefined) =>
    active && chunk && chunk.length > 0 ? { scopes: [...chunk] } : "skip";

  const h0 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[0]));
  const h1 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[1]));
  const h2 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[2]));
  const h3 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[3]));
  const chunkHeads = useMemo(
    () => [h0.data, h1.data, h2.data, h3.data],
    [h0.data, h1.data, h2.data, h3.data],
  );

  const prevChunkDataRef = useRef<Array<unknown>>([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  const onChunkWake = opts?.onChunkWake;

  useWatchEffect(() => {
    if (!active) {
      prevChunkDataRef.current = [undefined, undefined, undefined, undefined];
      return;
    }
    for (let i = 0; i < SCOPE_HEADS_CHUNK_COUNT; i++) {
      const nextData = chunkHeads[i];
      if (nextData !== undefined && nextData !== prevChunkDataRef.current[i]) {
        prevChunkDataRef.current[i] = nextData;
        const chunkScopes = chunks[i];
        if (chunkScopes?.length) {
          onChunkWake?.(chunkScopes, nextData.heads ?? []);
        }
      } else if (nextData === undefined) {
        prevChunkDataRef.current[i] = undefined;
      }
    }
  }, [active, chunkHeads, chunks, onChunkWake]);

  const activeScopes = useMemo(
    () => (active ? chunks.flat() : []),
    [active, chunks],
  );

  return {
    enabled,
    active,
    activeScopes,
    chunks,
    chunkHeads,
  };
}

export function buildCatchUpRunner(
  convex: any,
  deps: {
    runCatchUp: (
      convex: any,
      account: AbortSignal,
      opts?: { scopes?: readonly string[] },
    ) => Promise<void>;
    beginInflight: () => () => void;
    replaySignal: (convex: any) => AbortSignal;
    resetLanes: (convex: any) => void;
  },
  opts: { onError?: (e: unknown) => void; onSettled?: () => void } = {},
) {
  let running = false;
  let rerun = false;
  const queue = makeScopeRunQueue();
  const run = (scopes?: readonly string[]) => {
    const scoped = clientScopeSubscriptionsEnabled();
    if (running) {
      rerun = true;
      queue.add(scoped ? scopes : undefined);
      return;
    }
    running = true;
    const release = deps.beginInflight();
    const account = deps.replaySignal(convex);
    deps
      .runCatchUp(convex, account, scoped && scopes ? { scopes } : undefined)
      .catch((error) => {
        if (account.aborted) return;
        if (opts.onError) opts.onError(error);
        else console.warn("[syncLog] catch-up failed", error);
      })
      .finally(() => {
        release();
        running = false;
        opts.onSettled?.();
        if (rerun) {
          rerun = false;
          run(queue.take());
        }
      });
  };
  return Object.assign(run, {
    cancel() {
      rerun = false;
      queue.clear();
      deps.resetLanes(convex);
    },
  });
}

export function useScopedSyncChangeFeed<
  R extends ((scopes?: readonly string[]) => void) & { cancel: () => void },
>(
  makeRunner: (convex: any) => R,
  onResetReplay: (convex: any) => void,
  ticks: { debounceMs: number; tickMs: number },
): void {
  const convex = useConvex();
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const isSyncHost = useIsSyncHost();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useMemo(() => makeScopeRunQueue(), []);
  const run = useMemo(() => makeRunner(convex), [convex, makeRunner]);

  const scheduleRun = useCallback(
    (scopes?: readonly string[]) => {
      queue.add(scopes);
      if (debounceRef.current) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        run(queue.take());
      }, ticks.debounceMs);
    },
    [queue, run, ticks.debounceMs],
  );

  const onChunkWake = useCallback(
    (chunkScopes: readonly string[]) => scheduleRun(chunkScopes),
    [scheduleRun],
  );
  useScopeSubscriptions({ onChunkWake });

  useWatchEffect(() => {
    if (!hydrated || !isSyncHost) return;
    const runAll = () => run();
    useInboxStore.getState().reconcileScopeSubscriptions(Date.now());
    runAll();
    const id = setInterval(runAll, ticks.tickMs);
    const doc = typeof document !== "undefined" ? document : undefined;
    const win = typeof window !== "undefined" ? window : undefined;
    const onVisible = () => {
      if (doc?.visibilityState === "visible") runAll();
    };
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("focus", runAll);
    win?.addEventListener?.("online", runAll);
    const offWake = onSyncWake(runAll);
    const offAccount = useInboxStore.subscribe((next, previous) => {
      if (next.currentUser?._id === previous.currentUser?._id) return;
      onResetReplay(convex);
      useInboxStore.getState().reconcileScopeSubscriptions(Date.now());
      if (next.currentUser?._id) runAll();
    });
    return () => {
      offAccount();
      run.cancel();
      clearInterval(id);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      queue.clear();
      offWake();
      doc?.removeEventListener?.("visibilitychange", onVisible);
      win?.removeEventListener?.("focus", runAll);
      win?.removeEventListener?.("online", runAll);
    };
  }, [convex, hydrated, isSyncHost, onResetReplay, queue, run, ticks.tickMs]);
}
