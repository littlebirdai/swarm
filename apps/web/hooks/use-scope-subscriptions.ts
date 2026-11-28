import { useRef } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  SCOPE_HEADS_CHUNK_COUNT,
  clientScopeSubscriptionsEnabled,
} from "../store/scope-subscriptions";
import { syncLogScopeMetaKey, useInboxStore } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { useIsSyncHost } from "./use-sync-role";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

const api = _api as any;

export type ScopeHead = { scope_key: string; position: number; floor: number };

const projectsSig = makeCollectionSig<any>(
  (p) =>
    `${p._id ?? ""}|${p.short_id ?? ""}|${p.user_id ?? ""}|${p.owner_role_id ?? ""}|${p.starred ? 1 : 0}|${p.is_favorite ? 1 : 0}`,
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

function activeEntitySig(s: any): string {
  const tab = (s.tabs ?? []).find((t: any) => t?.id === s.activeTabId);
  const path = String(tab?.path ?? "").split(/[?#]/)[0];
  const m = path.match(/^\/(tasks|docs|plans)\/([^/]+)/);
  if (!m) return "";
  const [, kind, ref] = m;
  const map =
    kind === "tasks"
      ? s.tasks
      : kind === "docs"
        ? s.docDetails?.[ref]
          ? s.docDetails
          : s.docs
        : s.plans;
  const row = map?.[ref];
  return row
    ? `${row.home_scope ?? ""}|${row.project_id ?? ""}|${row.workspace ?? ""}`
    : "";
}

function scopeInputsSig(s: any): string {
  const userId = s.currentUser?._id ? String(s.currentUser._id) : "";
  const teams = (s.teams ?? []).map((t: any) => String(t?._id ?? "")).join(",");
  const rail = (s.chatRail ?? [])
    .map(
      (r: any) =>
        `${r?.channel_id ?? ""}:${r?.joined ? 1 : 0}:${r?.notify_level ?? ""}`,
    )
    .join(",");
  const pins = JSON.stringify(s.clientState?.ui?.sidebar_pins ?? null);
  const visits = (s.recentVisits ?? [])
    .map(
      (v: any) =>
        `${v?.kind ?? ""}:${v?.key ?? ""}:${v?.path ?? ""}:${v?.ts ?? 0}`,
    )
    .join(",");
  const tabs = (s.tabs ?? [])
    .map(
      (t: any) =>
        `${t?.id ?? ""}:${t?.path ?? ""}:${t?.layout ? JSON.stringify(t.layout) : ""}`,
    )
    .join("|");
  return [
    userId,
    teams,
    projectsSig(s.projects ?? {}),
    rolesSig(s.viewerRoles ?? {}),
    channelsSig(s.chatChannels ?? {}),
    readsSig(s.chatReads ?? {}),
    rail,
    pins,
    visits,
    s.activeTabId ?? "",
    tabs,
    activeEntitySig(s),
  ].join("\x1f");
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

export function handleUnauthorizedScope(
  store: any,
  scopeKey: string,
  metaKey: string,
  purgedTeams: Set<string>,
): void {
  if (scopeKey.startsWith("team:")) {
    const teamId = scopeKey.slice(5);
    store.purgeTeamScopeRows(teamId);
    store.clearSyncMeta(metaKey);
    purgedTeams.add(teamId);
    return;
  }
  if (scopeKey.startsWith("dir:")) {
    const teamId = scopeKey.slice(4);
    store.purgeTeamScopeRows(teamId);
    store.clearSyncMeta(metaKey);
    purgedTeams.add(teamId);
    return;
  }
  store.clearSyncMeta(metaKey);
  if (clientScopeSubscriptionsEnabled()) {
    const surviving = Object.keys(
      store.scopeSubscriptions?.active ?? {},
    ).filter((k) => k !== scopeKey);
    store.purgeUnheldScopeRows(surviving);
  }
}

export function sweepAfterHeads(
  store: any,
  heads: readonly ScopeHead[],
  requestedScopes: readonly string[] | null,
): void {
  if (heads.length === 0) return;
  if (requestedScopes) {
    sweepMissingInterestScopes(store, requestedScopes, heads);
    return;
  }
  const present = new Set(heads.map((h) => h.scope_key));
  for (const key of Object.keys(store.syncMeta)) {
    if (!key.startsWith("synclog:v1:team:")) continue;
    const scopeKey = key.slice("synclog:v1:".length);
    if (present.has(scopeKey)) continue;
    const teamId = scopeKey.slice(5);
    store.purgeTeamScopeRows(teamId);
    store.clearSyncMeta(key);
    store.clearCrawlMetaForScope(scopeKey);
  }
}

export function sweepMissingInterestScopes(
  store: any,
  requestedScopes: readonly string[],
  heads: readonly ScopeHead[],
): void {
  if (heads.length === 0) return;
  const present = new Set(heads.map((h) => h.scope_key));
  for (const scope of requestedScopes) {
    if (present.has(scope)) continue;
    if (scope.startsWith("dir:")) {
      const teamId = scope.slice(4);
      store.purgeTeamScopeRows(teamId);
      store.clearSyncMeta(syncLogScopeMetaKey(scope));
      store.clearCrawlMetaForScope(`team:${teamId}`);
      continue;
    }
    store.clearSyncMeta(syncLogScopeMetaKey(scope));
    const surviving = Object.keys(
      store.scopeSubscriptions?.active ?? {},
    ).filter((k) => k !== scope);
    store.purgeUnheldScopeRows(surviving);
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
  const activeMap = useInboxStore((s) => s.scopeSubscriptions.active);

  useWatchEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const reconcile = () => {
      if (disposed) return;
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
    reconcile();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, inputsSig]);

  const subArgs = (chunk: readonly string[] | undefined) =>
    active && chunk && chunk.length > 0 ? { scopes: [...chunk] } : "skip";

  const h0 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[0]));
  const h1 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[1]));
  const h2 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[2]));
  const h3 = useQueryNoThrow(api.syncLog.getHeads, subArgs(chunks[3]));
  const chunkHeads = [h0.data, h1.data, h2.data, h3.data];

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
  });

  return {
    enabled,
    active,
    activeScopes: active ? Object.keys(activeMap) : [],
    chunks,
    chunkHeads,
  };
}
