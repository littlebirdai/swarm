import {
  hasLiveInboxLease,
  inboxHeartbeatsFor,
  inboxUserHeartbeatRows,
} from "./sessionHeartbeat";
import { query } from "../functions";
import type { AgentStatus } from "@codecast/sessions/agentStatus";
import {
  isBelowFoldAt,
  WORKING_SET_RECENCY_MS,
  INBOX_TRUNCATION_KINDS,
  INBOX_WINDOW_CAPS,
  type InboxTruncation,
} from "@codecast/inbox/inboxProjection";
import { INBOX_FACT_FIELDS } from "@codecast/inbox/inboxFields";
import { openTasksVouchForWaiting } from "@codecast/sessions/openTasks";
import { Id } from "../_generated/dataModel";
import { HEARTBEAT_ALIVE_MS } from "../inboxFilters";
import { isDaemonManagedRow } from "./liveSessions";

// ---- Shared inbox-session builders --------------------------------------
// Used by BOTH listInboxSessions (the live, windowed subscription) and
// listInboxSessionsPaginated (the additive completeness-floor crawl). Extracted
// so the two queries emit BYTE-IDENTICAL enriched rows — schema drift between
// the live channel and the crawl would clobber rich rows with thin ones when the
// store overlays by id (sessions sync is isDelta). See inbox_no_authoritative_sessions_floor.
// How far back a session's last activity (updated_at), or its dismiss/stash
// stamp, may be and still be PROACTIVELY pulled into the inbox. ONE source:
// the shared recency horizon the replica's selection (inWorkingSet) applies,
// so the scan and the selection can never disagree at the horizon. This is a
// fetch bound only: the client deliberately never prunes — its sessions cache
// is isDelta (never-prune), so anything already cached, or opened on demand
// via click/search (injectSession), stays. Pinned sessions keep their own
// window and are unaffected.
export const INBOX_SESSION_WINDOW_MS = WORKING_SET_RECENCY_MS;

export const INBOX_DISMISSED_WINDOW_MS = WORKING_SET_RECENCY_MS;

// Bounds on the team-mode ("team scope") candidate scan. The board pulls each
// teammate's recent team-visible sessions; caps keep a single recompute within
// the isolate's read budget even for a large team. Teams are small in practice,
// so these are generous — a per-member overflow just means the oldest of that
// member's recent sessions wait for the client's paginated crawl (not built yet
// for team scope; acceptable for the recency-windowed board).
export const TEAM_INBOX_MEMBER_CAP = 50;

export const TEAM_INBOX_PER_MEMBER_CAP = 60;

// Row caps of the five personal windows. Each window reads cap + 1 so overflow
// costs one row and names itself in `truncated` (sync-convergence C2). Single
// source: the shared caps the replica's selection also applies (C4).
export const INBOX_WINDOW_CAP = INBOX_WINDOW_CAPS.recent;

// How many of my owner rows the scan reads to answer ownership for the
// candidates the owner window (INBOX_WINDOW_CAP) missed. One db call; owner
// rows are small, so the bound is on documents read, well inside a query's.
export const INBOX_OWNER_LOOKUP_CAP = 2000;

// Pinned rows are a deliberate, bounded set (INBOX_PINNED_CAP, inboxProjection.ts):
// the window reads newest-first so the newest pins win, and the pin writers
// refuse past the cap so the limit is enforced where the user can see it.
// Pinned rows past the newest N skip the per-row children scan in non-show-all
// base executions (children are not counted; this was the read that hit the
// system-operation limit on the census).
export const INBOX_PINNED_CHILDREN_SCAN = 20;

export type InboxSessionMaps = {
  agentStatusMap: Map<string, AgentStatus>;
  agentStatusUpdatedAtMap: Map<string, number>;
  // The settle's own facts next to the status (ct-49533): whether it came from
  // a lifecycle event rather than a turn ending, and which turn it belongs to.
  // One map because both are read off the same managed row at the same instant.
  settleFactsMap: Map<string, { boundary: boolean; turnCompletedAt?: number }>;
  hibernatedAtMap: Map<string, number>;
  tmuxSessionMap: Map<string, string>;
  sdkBackendConvIds: Set<string>; // managed_sessions.backend === "sdk"
  permissionModeMap: Map<string, string>;
  agentStartedAtMap: Map<string, number>;
  // The daemon's last verified open-task report per conversation (see
  // packages/sessions/src/openTasks): the "↳ Background …" rows the inbox draws
  // without messages, and what vouches for a "waiting" status past the decay.
  openTasksMap: Map<string, { tasks: any[]; at: number }>;
  liveConvIds: Set<string>;
  userDaemonAlive: boolean;
  // The time terms behind liveConvIds / userDaemonAlive, kept so the projection
  // can re-evaluate liveness at a later instant (bucket_stale_at) without a
  // read: newest heartbeat per conversation, and newest across the user's rows.
  lastHeartbeatMap: Map<string, number>;
  latestHeartbeat: number | undefined;
  liveLeaseIds: Set<string>;
  hasLiveDaemonLease: boolean;
};

// A daemon whose newest heartbeat is inside this window is "alive" for the
// fallback that keeps a quiet, statusless row connected (see daemonAlive below).
export const USER_DAEMON_ALIVE_MS = 6 * 60 * 1000;

// …and only rows updated inside this window ride that fallback.
export const CONV_DAEMON_ALIVE_MS = 10 * 60 * 1000;

export function userDaemonAliveAt(
  maps: Pick<InboxSessionMaps, "latestHeartbeat" | "hasLiveDaemonLease">,
  now: number,
): boolean {
  return (
    maps.hasLiveDaemonLease ||
    (maps.latestHeartbeat !== undefined &&
      now - maps.latestHeartbeat < USER_DAEMON_ALIVE_MS)
  );
}

function noteHeartbeat(
  maps: Pick<
    InboxSessionMaps,
    "lastHeartbeatMap" | "liveConvIds" | "liveLeaseIds"
  >,
  cid: string,
  lastHeartbeat: number | undefined,
  now: number,
): void {
  if (typeof lastHeartbeat !== "number") return;
  const prev = maps.lastHeartbeatMap.get(cid);
  if (prev === undefined || lastHeartbeat > prev)
    maps.lastHeartbeatMap.set(cid, lastHeartbeat);
  if (isLiveAt(maps, cid, now)) maps.liveConvIds.add(cid);
}

// Whether the daemon's open-task report vouches for a "waiting" on this
// conversation right now (non-empty, daemon heartbeating) — the fifth
// trustedAgentStatus arg.
export function verifiedWaitingFor(
  maps: Pick<InboxSessionMaps, "openTasksMap" | "liveConvIds"> &
    Partial<Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveLeaseIds">>,
  cid: string,
  now: number,
): boolean {
  const rep = maps.openTasksMap.get(cid);
  return openTasksVouchForWaiting(
    rep?.at,
    rep?.tasks.length ?? 0,
    isLiveAt(maps, cid, now),
  );
}

// Build the per-user managed-session maps once, then look up by conversation id.
export async function buildUserSessionMaps(
  ctx: any,
  userId: Id<"users">,
  now: number,
  heartbeatSince?: number,
): Promise<InboxSessionMaps> {
  const { sessions, beats } = await inboxUserHeartbeatRows(
    ctx,
    userId,
    heartbeatSince,
  );
  return sessionMapsFromManagedRows(sessions, beats, now);
}

// Liveness maps for a NAMED set of conversations, for a caller that asked for
// specific sessions (`cast sessions <id> -w`). Same facts buildUserSessionMaps
// derives, read per conversation instead of over every managed_sessions row the
// user has: a watch on two sessions re-ran on every heartbeat of every session
// the user ran and read ~2,000 documents a run, 3.5 of the backend's 32 cores
// on 2026-10-02 (ct-53363). Covers the named rows and the children enrichment
// reads for them (the same newest-20 range enrichInboxSessionRow takes), keeps
// only the viewer's own managed rows exactly as the user-wide read does, and
// takes the user's daemon liveness from the user row (see below).
// Teammates read per named lead. The full scan pools every teammate its
// windows hold; a lead with more live teammates than this is beyond any team
// the product spawns.
const NAMED_TEAMMATE_CAP = 50;

export async function buildNamedSessionMaps(
  ctx: any,
  userId: Id<"users">,
  convs: any[],
  now: number,
): Promise<{ maps: InboxSessionMaps; children: any[] }> {
  // Two links make a child: parent_conversation_id (subagents, orphans, the
  // range enrichment reads) and spawned_by_conversation_id (agent team
  // teammates, whose asks surface on the lead through rollupParentIdOf).
  const childLists = await Promise.all(
    convs.flatMap((conv: any) => [
      ctx.db
        .query("conversations")
        .withIndex("by_parent_conversation_id", (q: any) =>
          q.eq("parent_conversation_id", conv._id),
        )
        .order("desc")
        .take(20),
      ctx.db
        .query("conversations")
        .withIndex("by_spawned_by", (q: any) =>
          q.eq("spawned_by_conversation_id", conv._id),
        )
        .order("desc")
        .take(NAMED_TEAMMATE_CAP),
    ]),
  );
  const covered = new Map<string, any>();
  for (const c of [...convs, ...childLists.flat()])
    covered.set(c._id.toString(), c);
  const uid = userId.toString();
  // Whether the user's daemon is alive comes from the daemon's own beat on the
  // user row (users.daemonHeartbeat writes it at most every 50 s), never from
  // the newest managed_sessions heartbeat. That newest row is the top of an
  // index every session heartbeat moves, so reading it made every named watch
  // re-run on every heartbeat of every session the user ran: 16.8 full runs a
  // second and the busiest hours at 88 to 92% CPU on 2026-10-12 to 14
  // (ct-56547). The two agree whenever the daemon is beating its sessions; they
  // differ only for a daemon alive with no session heartbeating, where the
  // daemon's own beat is the truer answer to "is the daemon alive".
  const [user, rowLists] = await Promise.all([
    ctx.db.get(userId),
    Promise.all(
      [...covered.values()].map((c: any) =>
        ctx.db
          .query("managed_sessions")
          .withIndex("by_conversation_id", (q: any) =>
            q.eq("conversation_id", c._id),
          )
          .collect(),
      ),
    ),
  ]);
  const own = rowLists.flat().filter((s: any) => s.user_id?.toString() === uid);
  return {
    maps: sessionMapsFromManagedRows(
      own,
      await inboxHeartbeatsFor(ctx, own),
      now,
      user?.daemon_last_seen,
    ),
    children: childLists.flat(),
  };
}

// The one derivation of InboxSessionMaps from managed_sessions rows, shared by
// the user-wide and the named reads so the two cannot classify a row apart.
// `userLatestHeartbeat` is the newest heartbeat over ALL the user's rows when
// the caller read fewer than all of them.
export function sessionMapsFromManagedRows(
  managedSessions: any[],
  beats: number[],
  now: number,
  userLatestHeartbeat?: number,
): InboxSessionMaps {
  const liveConvIds = new Set<string>();
  const lastHeartbeatMap = new Map<string, number>();
  const liveLeaseIds = new Set<string>();
  let hasLiveDaemonLease = false;
  let latestHeartbeat: number | undefined;
  for (const [i, s] of managedSessions.entries()) {
    const beat = beats[i];
    const live = hasLiveInboxLease(s);
    if (live && isDaemonManagedRow(s)) hasLiveDaemonLease = true;
    // Only a daemon's heartbeat vouches for the user's other sessions; a
    // hosted row's heartbeat is a running turn and stays on its own row.
    if (
      isDaemonManagedRow(s) &&
      (latestHeartbeat === undefined || beat > latestHeartbeat)
    ) {
      latestHeartbeat = beat;
    }
    if (s.conversation_id) {
      if (live) liveLeaseIds.add(s.conversation_id.toString());
      noteHeartbeat(
        { lastHeartbeatMap, liveConvIds, liveLeaseIds },
        s.conversation_id.toString(),
        beat,
        now,
      );
    }
  }

  const agentStatusMap = new Map<string, any>();
  const agentStatusUpdatedAtMap = new Map<string, number>();
  const settleFactsMap = new Map<
    string,
    { boundary: boolean; turnCompletedAt?: number }
  >();
  const hibernatedAtMap = new Map<string, number>();
  const tmuxSessionMap = new Map<string, string>();
  const sdkBackendConvIds = new Set<string>();
  const permissionModeMap = new Map<string, string>();
  const agentStartedAtMap = new Map<string, number>();
  const openTasksMap = new Map<string, { tasks: any[]; at: number }>();
  for (const s of managedSessions) {
    if (!s.conversation_id) continue;
    const cid = s.conversation_id.toString();
    if (s.tmux_session) tmuxSessionMap.set(cid, s.tmux_session);
    if (s.backend === "sdk") sdkBackendConvIds.add(cid);
    if (s.permission_mode) permissionModeMap.set(cid, s.permission_mode);
    // Above the agent_status guard on purpose: a session whose status hasn't
    // been reported yet still has a process generation, and that is exactly
    // what decides whether its standing watches are real.
    if (s.agent_started_at !== undefined)
      agentStartedAtMap.set(cid, s.agent_started_at);
    if (s.open_tasks !== undefined && s.open_tasks_at !== undefined)
      openTasksMap.set(cid, { tasks: s.open_tasks, at: s.open_tasks_at });
    if (!s.agent_status) continue;
    if (s.agent_status_updated_at !== undefined)
      agentStatusUpdatedAtMap.set(cid, s.agent_status_updated_at);
    settleFactsMap.set(cid, {
      boundary: s.agent_status_boundary === true,
      turnCompletedAt: s.turn_completed_at,
    });
    if (s.hibernated_at !== undefined)
      hibernatedAtMap.set(cid, s.hibernated_at);
    // Raw status. The heartbeat-staleness coercion lives in trustedAgentStatus
    // (consumers pass liveConvIds membership as heartbeatAlive) so it can weigh
    // the conversation's own activity — a lapsed heartbeat on a session that is
    // actively syncing messages must not read as dead.
    agentStatusMap.set(cid, s.agent_status);
  }

  if (
    typeof userLatestHeartbeat === "number" &&
    (latestHeartbeat === undefined || userLatestHeartbeat > latestHeartbeat)
  ) {
    latestHeartbeat = userLatestHeartbeat;
  }
  // At the minute, against a six minute window. The newest heartbeat over all
  // of a user's rows moves with every batched heartbeat flush (every few
  // seconds with forty live agents), and it sets every row's
  // daemon_alive_until, so at full precision each flush re-sent the whole
  // liveness overlay to every client (about 28 times a minute on 2026-10-11).
  // Flooring keeps the deadline honest: at most a minute early.
  if (latestHeartbeat !== undefined)
    latestHeartbeat = Math.floor(latestHeartbeat / 60_000) * 60_000;
  const userDaemonAlive = userDaemonAliveAt(
    { latestHeartbeat, hasLiveDaemonLease },
    now,
  );

  return {
    agentStatusMap,
    agentStatusUpdatedAtMap,
    settleFactsMap,
    hibernatedAtMap,
    tmuxSessionMap,
    sdkBackendConvIds,
    permissionModeMap,
    agentStartedAtMap,
    openTasksMap,
    liveConvIds,
    userDaemonAlive,
    lastHeartbeatMap,
    latestHeartbeat,
    liveLeaseIds,
    hasLiveDaemonLease,
  };
}

// Empty maps for computeInboxSessions({includeLiveness:false}): this path skips
// the managed-session read and strips the facts owned by sessionsLiveness.
export const EMPTY_INBOX_MAPS: InboxSessionMaps = {
  agentStatusMap: new Map(),
  agentStatusUpdatedAtMap: new Map(),
  settleFactsMap: new Map(),
  hibernatedAtMap: new Map(),
  tmuxSessionMap: new Map(),
  sdkBackendConvIds: new Set(),
  permissionModeMap: new Map(),
  agentStartedAtMap: new Map(),
  openTasksMap: new Map(),
  liveConvIds: new Set(),
  userDaemonAlive: false,
  lastHeartbeatMap: new Map(),
  latestHeartbeat: undefined,
  liveLeaseIds: new Set(),
  hasLiveDaemonLease: false,
};

// Liveness for second-party-owned rows: their managed_sessions belong to the
// RUNNING account, which buildUserSessionMaps (scoped to the viewer's user_id)
// never sees. Fetch per conversation — owned foreign rows are sparse — and
// merge with the exact same status-trust rules. Deliberately leaves
// userDaemonAlive untouched: that flag describes the viewer's own daemon.
export async function mergeForeignConversationLiveness(
  ctx: any,
  maps: InboxSessionMaps,
  convs: any[],
  now: number,
): Promise<void> {
  const managedRows = await Promise.all(
    convs.map((conv: any) =>
      ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) =>
          q.eq("conversation_id", conv._id),
        )
        .first(),
    ),
  );
  const beats = await inboxHeartbeatsFor(ctx, managedRows);
  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    const cid = conv._id.toString();
    const managed = managedRows[i];
    if (!managed) continue;
    if (hasLiveInboxLease(managed)) maps.liveLeaseIds.add(cid);
    noteHeartbeat(maps, cid, beats[i], now);
    if (managed.tmux_session)
      maps.tmuxSessionMap.set(cid, managed.tmux_session);
    if (managed.backend === "sdk") maps.sdkBackendConvIds.add(cid);
    if (managed.permission_mode)
      maps.permissionModeMap.set(cid, managed.permission_mode);
    if (managed.agent_started_at !== undefined)
      maps.agentStartedAtMap.set(cid, managed.agent_started_at);
    if (managed.open_tasks !== undefined && managed.open_tasks_at !== undefined)
      maps.openTasksMap.set(cid, {
        tasks: managed.open_tasks,
        at: managed.open_tasks_at,
      });
    if (managed.hibernated_at !== undefined)
      maps.hibernatedAtMap.set(cid, managed.hibernated_at);
    if (!managed.agent_status) continue;
    if (managed.agent_status_updated_at !== undefined) {
      maps.agentStatusUpdatedAtMap.set(cid, managed.agent_status_updated_at);
    }
    maps.settleFactsMap.set(cid, {
      boundary: managed.agent_status_boundary === true,
      turnCompletedAt: managed.turn_completed_at,
    });
    // Raw status — same contract as buildUserSessionMaps: trustedAgentStatus
    // applies the heartbeat coercion with conversation context.
    maps.agentStatusMap.set(cid, managed.agent_status);
  }
}

// The heartbeat-derived fields that move to the sessionsLiveness overlay. Stripped from
// the base rows when liveness is excluded so the client can't read a stale value before
// the overlay merges (it overlays these back, keyed by id, via syncOverlay).
//
// DERIVED from the shared INBOX_FACT_FIELDS constant (sync-convergence C1):
// the overlay owns exactly those fields, the strip list here and the client's
// preserve list both re-derive from it, and a signature test pins the split.
// The two fast fields change on every streamed message; a client that opts in
// (`fast_fields_in_overlay`) gets them from the overlay instead, so a streaming
// session no longer changes the list result and Convex stops re-pushing the
// whole ~1.7MB list on every token. The wake-cost pair moves on every model
// call the same way.
export const INBOX_FAST_FIELDS = [
  "message_count",
  "updated_at",
  "context_tokens",
  "last_model_call_at",
] as const;

export const INBOX_LIVENESS_FIELDS = INBOX_FACT_FIELDS.filter(
  (f) => !(INBOX_FAST_FIELDS as readonly string[]).includes(f),
);

export function stripInboxLiveness(row: any, fastFieldsToo = false): void {
  for (const f of INBOX_LIVENESS_FIELDS) row[f] = null;
  if (fastFieldsToo) for (const f of INBOX_FAST_FIELDS) row[f] = null;
}

// Enrich one conversation into the inbox session row, including the AskUserQuestion
// scrape, idle/grace classification, and plan/task/workflow context. `clusterCutoff`
// of 0 disables the stale-cluster hide (the crawl passes 0 — completeness wins).
// Debug-only cost knobs for the temporary timing harness (debugTmp.ts): each
// flag skips one class of per-row reads so their cost can be measured from
// outside (Date.now() is frozen inside a query). Production callers pass none.
export type InboxEnrichSkip = {
  children?: boolean;
  auq?: boolean;
  transcript?: boolean;
  refs?: boolean;
};

// A db.get memoized on the PROMISE for one recompute: rows enrich concurrently,
// and two rows asking for the same plan, task, workflow run or user must share
// one read — every duplicate counts against the system-operation budget.
export function makeMemoGet(ctx: any): (id: any) => Promise<any> {
  const cache = new Map<string, Promise<any>>();
  return (id: any) => {
    const key = id.toString();
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve(ctx.db.get(id)).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

// The viewer-relative half of an inbox row: what this row means to the person
// reading it, on top of enrichInboxSessionRow's viewer-free half. EVERY feeder
// of the client's `sessions` cache (the base list, byIds, the completeness
// floor, favorites, the killed shelf) stamps through here, so one row is
// written one way whichever feeder delivered it last (the delta syncTable
// replaces the whole row; a field one feeder omits flaps on every catch-up).
//   - owned_by_me, always a boolean: the viewer holds a session_owners row;
//   - author_name/author_email on a row the viewer does not run;
//   - assigned_ping on an owner row someone else added and the viewer has not
//     acked (ackSessionAssignment clears it);
//   - owner_name/owner_email, the PRIMARY owner's (the row shows one chip; the
//     full owner set is fetched on demand by the session panel).
export async function stampInboxViewerFields(
  row: any,
  conv: any,
  viewerId: Id<"users">,
  myOwnerRow: any | null,
  getDoc: (id: any) => Promise<any>,
): Promise<void> {
  if (conv.user_id.toString() !== viewerId.toString()) {
    const author = await getDoc(conv.user_id);
    row.author_name = author?.name ?? author?.email ?? null;
    row.author_email = author?.email ?? null;
  }
  row.owned_by_me = !!myOwnerRow;
  if (
    myOwnerRow &&
    !myOwnerRow.seen_at &&
    myOwnerRow.added_by?.toString() !== viewerId.toString()
  ) {
    const byDoc = await getDoc(myOwnerRow.added_by);
    row.assigned_ping = {
      by_name: byDoc?.name ?? byDoc?.email ?? "A teammate",
      note: myOwnerRow.note ?? null,
      at: myOwnerRow.added_at,
    };
  }
  if (conv.owner_user_id) {
    const ownerDoc = await getDoc(conv.owner_user_id);
    row.owner_name = ownerDoc?.name ?? null;
    row.owner_email = ownerDoc?.email ?? null;
  }
}

// The per-row fold flag over a scan: a selection member reads the shared fold
// set (so a teammate folds with its lead — computeFold's ride), and a row
// outside the selection (a team row, a filed extra, an assigned session) reads
// the per-row cut, 0 for the deliberate ones. Pure over the doc and the scan
// so the base list, the liveness overlay and the CLI agree byte for byte.
export function belowFoldFor(
  scan: {
    selectionIds: ReadonlySet<string>;
    belowFold: ReadonlySet<string>;
    deliberateIds: ReadonlySet<string>;
    ownedByMeIds: ReadonlySet<string>;
    clusterCutoff: number;
  },
  conv: {
    _id: { toString(): string } | string;
    updated_at: number;
    has_pending_messages?: boolean | null;
    inbox_pinned_at?: number | null;
    inbox_dismissed_at?: number | null;
    inbox_stashed_at?: number | null;
  },
): boolean {
  const cid = conv._id.toString();
  if (scan.selectionIds.has(cid)) return scan.belowFold.has(cid);
  return isBelowFoldAt(
    conv as any,
    scan.deliberateIds.has(cid) || scan.ownedByMeIds.has(cid)
      ? 0
      : scan.clusterCutoff,
  );
}

// `truncated` as the payload carries it: the fixed alphabet's order, so two
// executions that hit the same caps serialize identically.
export function truncatedList(
  truncated: Set<InboxTruncation>,
): InboxTruncation[] {
  return INBOX_TRUNCATION_KINDS.filter((k) => truncated.has(k));
}

// The child whose liveness we can answer from the maps. Own children carry a
// heartbeat in lastHeartbeatMap (buildUserSessionMaps); a child the maps never
// saw falls back to the liveConvIds set computed at the epoch, which is what
// hand-built maps in tests supply.
export function isLiveAt(
  maps: Pick<InboxSessionMaps, "liveConvIds"> &
    Partial<Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveLeaseIds">>,
  cid: string,
  now: number,
): boolean {
  if (maps.liveLeaseIds?.has(cid)) return true;
  const heartbeat = maps.lastHeartbeatMap?.get(cid);
  return heartbeat === undefined
    ? maps.liveConvIds.has(cid)
    : now - heartbeat < HEARTBEAT_ALIVE_MS;
}
