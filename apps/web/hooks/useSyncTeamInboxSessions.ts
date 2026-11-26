import { useCallback, useMemo } from "react";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useSplitQueryNoThrow } from "./useSplitQuery";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, InboxSession, isConvexId } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useInboxRecovery } from "./use-inbox-recovery";
import { useIsSyncHost } from "./useSyncRole";

import { useWatchEffect } from "./useWatchEffect";
// Record the team-mode active id set, change-guarded so an identical payload
// doesn't allocate a new Set and re-render every subscriber. The panel gates the
// visible list on this while inbox_scope is "team" (see filterInboxScope). Mirror
// of applyLiveInboxIds for the team board — including the persistence rule: the
// write goes through the sync() action (never raw setState) so the team-keyed
// IDB snapshot stays current and the next boot's first frame can seed from it.
export function applyTeamInboxIds(sessions: any[], teamId: string | null) {
  const ids = sessions.map((x: any) => x._id.toString());
  const next = new Set<string>(ids);
  const prev = useInboxStore.getState().teamInboxIds;
  if (prev.size === next.size && ids.every((id) => prev.has(id))) return;
  useInboxStore.getState().setTeamInboxIds(ids, teamId);
}

// One listTeamInboxSessions payload into the store: the rows through the same
// never-prune syncTable as the personal inbox, then the team's active id set.
// The subscription, the recovery probe and the simulator's host apply through
// it. False when the payload held no row list.
export function applyTeamListPayload(
  data: any,
  teamId: string | null,
): boolean {
  const sessions = data?.sessions ?? [];
  if (!Array.isArray(sessions)) return false;
  useInboxStore
    .getState()
    .syncTable("sessions", sessions as unknown as InboxSession[]);
  applyTeamInboxIds(sessions, teamId);
  return true;
}

// The team list's args, shared by the subscription and the recovery probe.
export function teamInboxArgs(teamId: string | undefined) {
  return {
    activeTeamId: teamId as Id<"teams"> | undefined,
    include_liveness: false,
    fast_fields_in_overlay: true,
  };
}

// Facts merge onto rows; stamps + the projection envelope land in the TEAM
// slot of sessionsProjection, keyed by team id, so the personal overlay and
// the team overlay never write the same slot (sync-convergence C1). Team
// stamps ship but are not compared (the replica lacks team visibility
// inputs); they exist for freshness scheduling. False when the payload held
// no liveness map and nothing was applied.
export function applyTeamLivenessPayload(
  teamId: string | undefined,
  data: any,
): boolean {
  const liveness = data?.liveness ?? data;
  if (!liveness || typeof liveness !== "object") return false;
  useInboxStore
    .getState()
    .applyInboxLivenessPayload(`team:${teamId ?? ""}`, data);
  return true;
}

/**
 * Inbox "team mode" sync. When the user's scope is "team", subscribe to the
 * team-scoped inbox (every team-visible session across the active team) and
 * merge those rows into the SAME never-prune `sessions` cache the personal inbox
 * uses — they're schema-identical (both come from enrichInboxSessionRow), so the
 * card, bucketing, and sort all just work. The reported id set becomes
 * `teamInboxIds`, the active set the panel gates on in team scope.
 *
 * Mirrors the personal inbox's liveness split: the list subscription opts out of
 * heartbeat-derived liveness (include_liveness:false) and a tiny
 * teamSessionsLiveness overlay carries the per-second live status, so team mode
 * is as heartbeat-cheap as the personal inbox.
 *
 * All subscriptions pass "skip" when scope isn't "team", so nothing runs (and no
 * team rows are fetched) until the user actually opens the team board.
 */
export function useSyncTeamInboxSessions() {
  const isSyncHost = useIsSyncHost();
  const scope = useInboxStore((s) => s.clientState.ui?.inbox_scope ?? "mine");
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // A freshly created team holds an optimistic stub id until the server
  // echoes; a stub is not an Id<"teams">, so skip rather than throw.
  const active =
    scope === "team" && (!activeTeamId || isConvexId(String(activeTeamId)));
  const teamArgs = useMemo(
    () => (active ? teamInboxArgs(activeTeamId) : "skip"),
    [active, activeTeamId],
  );

  const livenessArgs = useMemo(
    () =>
      active
        ? { activeTeamId: activeTeamId as Id<"teams"> | undefined }
        : "skip",
    [active, activeTeamId],
  );
  const { data: teamSessions, error: teamListError } = useQueryNoThrow(
    api.conversations.listTeamInboxSessions,
    teamArgs,
  );
  const { data: teamLiveness, error: teamLivenessError } = useSplitQueryNoThrow(
    api.conversations.teamSessionsLiveness,
    livenessArgs,
    "liveness",
  );
  const scopedLiveness = useMemo(
    () =>
      teamLiveness === undefined
        ? undefined
        : { teamId: activeTeamId, data: teamLiveness },
    [teamLiveness, activeTeamId],
  );

  useConvexSync(
    teamSessions,
    useCallback(
      (data: any) => {
        // Team rows warm through the store-driven loop (startWarmLoop): the board's
        // cards are the rows on screen in team scope.
        applyTeamListPayload(data, activeTeamId ?? null);
      },
      [activeTeamId],
    ),
    { coalesceMs: 300 },
  );

  // Liveness overlay into the team projection slot (applyTeamLivenessPayload).
  useConvexSync(
    scopedLiveness,
    useCallback(
      ({ teamId, data }) => {
        // A coalesced push can flush after the team or inbox scope has changed.
        if (!active || teamId !== activeTeamId) return;
        applyTeamLivenessPayload(activeTeamId, data);
      },
      [active, activeTeamId],
    ),
    { coalesceMs: 300 },
  );

  // Leaving team mode, or switching to another team, clears the active set
  // (the teammate rows stay in the never-prune cache; the scope filter is what
  // hides them). Readers already refuse a set answering for another team
  // (teamInboxIdsOf); clearing it also hands every memo keyed on the set's
  // identity a new value, so none keeps painting the last team's board.
  useWatchEffect(() => {
    const st = useInboxStore.getState();
    if (
      active &&
      (st.teamInboxIdSnapshot?.team_id ?? null) === (activeTeamId ?? null)
    )
      return;
    if (st.teamInboxIds.size === 0) return;
    useInboxStore.setState({ teamInboxIds: new Set<string>() });
  }, [active, activeTeamId]);

  useInboxRecovery(
    api.conversations.listTeamInboxSessions,
    isSyncHost ? teamArgs : "skip",
    null,
    teamListError,
    useCallback(
      (data) => applyTeamListPayload(data, activeTeamId ?? null),
      [activeTeamId],
    ),
  );
  useInboxRecovery(
    api.conversations.teamSessionsLiveness,
    isSyncHost ? livenessArgs : "skip",
    "liveness",
    teamLivenessError,
    useCallback(
      (data) => applyTeamLivenessPayload(activeTeamId, data),
      [activeTeamId],
    ),
  );

  return teamSessions;
}
