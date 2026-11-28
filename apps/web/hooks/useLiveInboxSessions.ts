import { useCallback, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { useConvex } from "convex/react";
import {
  useInboxStore,
  InboxSession,
  claimsViewer,
  isConvexId,
} from "../store/inboxStore";
import { scopeMetaKey } from "./use-sync-change-feed";
import { settleDisownClaims } from "./sync-feed-rows";
export { settleDisownClaims } from "./sync-feed-rows";
import { coverInboxSnapshot } from "./inbox-replay-lane";
import { useInboxRecovery } from "./use-inbox-recovery";
import { useServerAuthenticated } from "./useServerAuthSettled";
import { useConvexSync } from "./useConvexSync";
import { useIsSyncHost } from "./use-sync-role";
import { useSplitQueryNoThrow } from "./useSplitQuery";
import { useFeederError } from "./useSyncCollection";

// Record the live (recent) id set, change-guarded so an identical payload doesn't
// re-render every subscriber (or touch IDB). "Old" = cached top-level sessions
// absent from this set (filled by the completeness crawl). Writes go through
// setLiveInboxIds — a sync() action — so the set persists and the next cold boot
// filters its first frame against the last-known authoritative set. A plain
// function (no React deps; it reads/writes the store directly), applied with
// the rows by applyInboxListPayload. With a client, the rows that left the set
// while claiming me are settled through byIds (settleDisownClaims).
export function applyLiveInboxIds(sessions: any[], convex?: any) {
  const ids = sessions.map((x: any) => x._id.toString() as string);
  const next = new Set<string>(ids);
  const state = useInboxStore.getState();
  const prev = state.liveInboxIds;
  if (prev.size === next.size && ids.every((id) => prev.has(id))) return;
  const left = leftClaimingViewer(state, prev, next);
  state.setLiveInboxIds(ids);
  if (convex && left.length) void settleDisownClaims(convex, left);
}

// The rows that left the live list while claiming me: a foreign run I own.
// Leaving says only that the list stopped returning the row: I was removed as
// an owner (a disown reaches the list as absence), or the row left its scan
// while I still own it (a kill, the age window, the owner-window cap).
export function leftClaimingViewer(
  state: { currentUser?: any; sessions: Record<string, any> },
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): string[] {
  const meId = state.currentUser?._id?.toString?.();
  if (!meId) return [];
  return [...prev].filter(
    (id) =>
      !next.has(id) &&
      isConvexId(id) &&
      !!state.sessions[id] &&
      claimsViewer(state.sessions[id], meId),
  );
}

/**
 * One listInboxSessions payload into the store: the rows through syncTable,
 * then the live id set. The subscription, the recovery probe and the
 * simulator's host all apply through it. Returns the rows, or null for a
 * payload that holds none.
 */
export function applyInboxListPayload(data: any, convex?: any): any[] | null {
  const sessions = data?.sessions ?? data;
  if (!Array.isArray(sessions)) return null;
  useInboxStore
    .getState()
    .syncTable("sessions", sessions as unknown as InboxSession[]);
  applyLiveInboxIds(sessions, convex);
  return sessions;
}

/**
 * The ONE live source of truth for the inbox `sessions` cache: the
 * listInboxSessions subscription piped into syncTable + liveInboxIds.
 *
 * Both surfaces that need a current view of the session set mount this — the full
 * inbox hook (useSyncInboxSessions, which layers recovery polling / liveness /
 * the reconcile crawl on top) and the standalone palette window (which wants
 * nothing else). Sharing this is the whole point: a window that decides which
 * blank session to reuse (findReusableBlankSession) MUST see the same `sessions`
 * truth as the in-app New Session, or it routes the first message into a session
 * that only LOOKS blank in a stale IDB snapshot — the desktop "compose into an
 * existing session" bug. include_liveness:false matches useSyncInboxSessions so
 * the two callers share Convex's query cache instead of forking a second token.
 *
 * Returns the raw subscription result (undefined until the first server response)
 * for callers that need the live payload itself, and the subscription's terminal
 * error, if any.
 *
 * useQueryNoThrow, never useQuery: this is THE feeder for the sessions cache,
 * mounted with every other global feeder under one ErrorBoundary. A terminal
 * server error (the backend's 1s user-code cap once the host saturates, 2026-09-16)
 * thrown from render unmounted every feeder in the app until a reload; here it
 * degrades to the cached rows, the subscription re-runs on the next data change,
 * and the 15s recovery probe re-feeds the store meanwhile.
 */
// The ONE argument shape for the live inbox window. The recovery probe in
// useSyncInboxSessions spreads THIS constant (plus its cache-busting _probe),
// so a stalled subscription can never flap the store between two payload
// shapes — the probe and the subscription are byte-identical requests.
export const LIST_INBOX_SESSIONS_ARGS = {
  show_all: false,
  include_liveness: false,
  fast_fields_in_overlay: true,
} as const;

const SNAPSHOT_ARGS = {
  ...LIST_INBOX_SESSIONS_ARGS,
  checkpoint: true,
} as const;

export function useLiveInboxSessions(logSnapshot = false) {
  // Follower windows receive `sessions` over replication; only a host feeds it.
  const isSyncHost = useIsSyncHost();
  const { data: inboxSessions, error } = useSplitQueryNoThrow(
    api.inboxLists.listInboxSessions,
    isSyncHost && !logSnapshot ? LIST_INBOX_SESSIONS_ARGS : "skip",
    "list",
  );
  useFeederError("inboxLists.listInboxSessions", error);
  const convex = useConvex();

  useConvexSync(
    inboxSessions,
    useCallback(
      (data: any) => {
        applyInboxListPayload(data, convex);
      },
      [convex],
    ),
    { coalesceMs: 300 },
  );

  const scope = useInboxStore((state) => {
    const id = state.currentUser?._id;
    return logSnapshot && id ? `user:${id}` : null;
  });
  const cursorReady = useInboxStore(
    (state) =>
      scope !== null &&
      state.syncMeta[scopeMetaKey(scope)]?.cursor !== undefined,
  );
  const reset = useInboxStore((state) =>
    scope ? (state.crawlResets[scope] ?? 0) : 0,
  );
  const authenticated = useServerAuthenticated();
  const [snapshotScope, setSnapshotScope] = useState<string | null>(null);
  const snapshotActive = isSyncHost && authenticated && cursorReady;
  useInboxRecovery(
    api.inboxLists.listInboxSessions,
    snapshotActive ? SNAPSHOT_ARGS : "skip",
    null,
    undefined,
    useCallback(
      async (
        data: FunctionReturnType<typeof api.inboxLists.listInboxSessions>,
        signal: AbortSignal,
      ) => {
        if (
          scope === null ||
          !("checkpoint" in data) ||
          data.checkpoint?.scope !== scope
        )
          return false;
        const { position } = data.checkpoint;
        const currentState = () => {
          const state = useInboxStore.getState();
          const cursor = state.syncMeta[scopeMetaKey(scope)]?.cursor;
          if (
            signal.aborted ||
            `user:${state.currentUser?._id}` !== scope ||
            state.syncRole === "follower" ||
            (state.crawlResets[scope] ?? 0) !== reset ||
            cursor === undefined ||
            position < cursor
          )
            return null;
          return { state, cursor };
        };
        const before = currentState();
        if (!before || !Array.isArray(data.sessions)) return false;
        const ids = new Set<string>(
          data.sessions.map((row) => String(row._id)),
        );
        const left = leftClaimingViewer(
          before.state,
          before.state.liveInboxIds,
          ids,
        );
        if (left.length) await settleDisownClaims(convex, left, signal);
        const current = currentState();
        if (!current || !applyInboxListPayload(data)) return false;
        if (current.cursor < position)
          coverInboxSnapshot(convex, scope, position, ids);
        setSnapshotScope(scope);
        return true;
      },
      [convex, scope, reset],
    ),
    reset,
    scope ?? undefined,
  );
  const loading = logSnapshot
    ? isSyncHost && (scope === null || snapshotScope !== scope)
    : inboxSessions === undefined && !error;
  return { data: inboxSessions, error, loading };
}
