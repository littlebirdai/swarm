import { query } from "../functions";
import {
  placeProjectableRow,
  trustedStatusAt,
  rowLiveDeadlines,
  LIVE_INBOX_LEASE_END,
  type InboxBucket,
  type InboxPlacement,
  type SessionActivity,
} from "@codecast/inbox/inboxProjection";
import {
  rollupParentIdOf,
  isStackedAsk,
} from "@codecast/inbox/inboxMembership";
import { BLOCKED_BANNER_KINDS } from "@codecast/agent-clients/apiErrorBanner";
import { isClosedSession } from "@codecast/inbox/closedSession";
import { Id } from "../_generated/dataModel";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import {
  trustedAgentStatus,
  subagentIsProducing,
  SUBAGENT_PRODUCING_GRACE_MS,
  HEARTBEAT_ALIVE_MS,
  STATUS_TRUST_TTL_MS,
  type WorkState,
} from "../inboxFilters";
import { newestMessageCache } from "./inboxLivenessState";
import {
  CONV_DAEMON_ALIVE_MS,
  type InboxSessionMaps,
  USER_DAEMON_ALIVE_MS,
  isLiveAt,
  verifiedWaitingFor,
} from "./inboxMaps";

// The heartbeat-derived fields the sessionsLiveness overlay ships — the exact set the
// full row (enrichInboxSessionRow) exposes and the web client merges via syncOverlay.
export type LivenessFields = {
  // The daemon's own status, before any trust rule: every reader (this file's
  // placement included) derives the verdict at its own clock through
  // trustedStatusAt, since a verdict does not replay at a later instant
  // (ct-56054).
  agent_status: string | null;
  is_idle: boolean;
  is_unresponsive: boolean;
  awaiting_input: boolean;
  is_connected: boolean;
  tmux_session: string | null;
  claude_backend: "sdk" | null; // "sdk" while the session runs in an Agent SDK host
  permission_mode: string | null;
  // Start of the agent process currently behind this conversation. Rides the
  // overlay rather than the base row because it changes on restart, exactly
  // when the rest of the liveness picture does.
  agent_started_at: number | null;
  // The daemon's verified open background work (packages/sessions/src/openTasks) —
  // overlay-borne for the same reason: it changes when the session parks or
  // wakes, and the inbox draws its "↳ Background …" rows from it.
  open_tasks: any[] | null;
  open_tasks_at: number | null;
  // Fast fields (see INBOX_FAST_FIELDS): exact values for clients whose base
  // list omits them.
  message_count: number;
  updated_at: number;
  // Whether the newest user turn permits a structural park (machine-delivered
  // or absent — dormancy.lastTurnAllowsPark). Overlay-borne so the replica can
  // run the armed-trigger/loop park rule without the message body the server's
  // probe covered (sync-convergence C1).
  last_turn_allows_park: boolean;
  // The is_idle inputs (ct-47609), so a replica re-derives idleness,
  // responsiveness and the status trust at its own clock (shared deriveLiveAt).
  agent_status_updated_at: number | null;
  // The settle's own facts (ct-49533). agent_status_boundary is a placement
  // input (a boundary settle carries no verdict); turn_completed_at is the
  // per-turn identity a completion consumer dedupes on.
  agent_status_boundary: boolean | null;
  turn_completed_at: number | null;
  hibernated_at?: number | null;
  last_heartbeat: number | null;
  liveness_lease_end: number | null;
  last_role_is_user: boolean;
  auq_open: boolean;
  daemon_alive_until: number | null;
  producing_until: number | null;
  // A child (rollupParentIdOf) is asking: the rollup the replica cannot
  // compute when that child lives outside its scan window. Member rows only.
  child_asking?: boolean;
  child_asking_until?: number | null;
  // A nested child is live: lifts a standing session whose only work is a
  // subagent (rideLeadPlacements). Member rows only.
  child_live?: boolean;
  // What the agent is doing now (conversations.activity), overlay borne so a
  // tool call rides the flush push the overlay already makes and never
  // re-pushes the session list. Clients show it only while the row is working
  // and the stamp is fresh (shared isSessionActivityFresh).
  activity: SessionActivity | null;
  // Wake cost (wakeFieldsOf): fast fields, see INBOX_FAST_FIELDS.
  context_tokens: number | null;
  last_model_call_at: number | null;
};

// The projection stamps (sync-convergence C1/C3): the row's placement, its
// classifier verdict, the asking flag behind the questions bucket, the fold
// flag, and the time flip — computed once here, rendered everywhere.
export type InboxProjectionRowFields = {
  bucket: InboxBucket;
  work_state: WorkState;
  asking: boolean;
  below_fold: boolean;
  bucket_stale_at: number | null;
  stale_bucket: InboxBucket | null;
};

export type InboxLivenessRow = LivenessFields & InboxProjectionRowFields;

// A row in the overlay map: a projection MEMBER carries facts + stamps
// (InboxLivenessRow); a live probed CHILD carries facts only — no bucket key —
// so replicas can compute parent rollups from replicated child facts (C1).
export type InboxOverlayRow = LivenessFields &
  Partial<InboxProjectionRowFields>;

// The projection fields, by name: what the paginated / byIds / base channels
// must never carry (the overlay owns them), and what a client strips from
// every incoming sessions row before its merge. The list itself lives in the
// shared module (sync-convergence C1) so the client's strip list is the same
// constant; re-exported for existing importers.
export { INBOX_PROJECTION_FIELDS } from "@codecast/inbox/inboxFields";

// Convex env kill switch for the digest compare (sync-convergence C8): with
// `npx convex env set INBOX_DIGEST_DISABLED 1` every overlay payload carries
// set_digest null and every deployed client skips compare and heal.
export function inboxDigestDisabled(): boolean {
  try {
    return process.env.INBOX_DIGEST_DISABLED === "1";
  } catch {
    return false;
  }
}

// Foreign-run parents (a session run by another account but in my inbox) are
// the one blind spot of the pool-derived child sets — their children never
// appear in my scans — so the newest N of them keep a per-parent children scan.
export const FOREIGN_SCAN_BUDGET = 40;

// Is this child still producing for its parent at instant `now`? Pure over the
// child doc and the maps; see subagentIsProducing for the two proofs.
function childIsProducing(
  c: any,
  maps: Pick<InboxSessionMaps, "liveConvIds" | "agentStatusMap"> &
    Partial<Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveLeaseIds">>,
  now: number,
): boolean {
  const cid = c._id.toString();
  const live = isLiveAt(maps, cid, now);
  return subagentIsProducing({
    isSubagent: !!c.is_subagent,
    convStatus: c.status,
    updatedAt: c.updated_at,
    isLive: live,
    agentStatus: trustedAgentStatus(
      maps.agentStatusMap.get(cid),
      c.updated_at,
      now,
      live,
    ),
    now,
  });
}

// Children in the candidate pool, grouped by the parent their state rolls up
// to (the shared rollupParentIdOf rule — the replica's asking derivation
// groups by the same one): subagents and orphans, which are never members
// themselves, and agent-team teammates, whose asks surface on the lead. A plan
// handoff with its own inbox row is its own projection member and speaks for
// itself.
export function groupPoolChildren(pool: any[]): Map<string, any[]> {
  const byParent = new Map<string, any[]>();
  for (const c of pool) {
    const pid = rollupParentIdOf(c);
    if (!pid) continue;
    const list = byParent.get(pid);
    if (list) list.push(c);
    else byParent.set(pid, [c]);
  }
  return byParent;
}

// A parent's child_live fact: some nested child with content holds a trusted
// status that is still in play. A finished child (done, stopped, hibernated)
// no longer puts its parent in front of the person.
const SETTLED_CHILD_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "done",
  "stopped",
  "hibernated",
]);

export function hasLiveNestedChild(
  children: any[],
  maps: InboxSessionMaps,
  now: number,
): boolean {
  return children.some((c) => {
    if ((c.message_count ?? 0) === 0) return false;
    const cid = c._id.toString();
    const status = trustedAgentStatus(
      maps.agentStatusMap.get(cid),
      c.updated_at,
      now,
      isLiveAt(maps, cid, now),
      verifiedWaitingFor(maps, cid, now),
    );
    return status !== undefined && !SETTLED_CHILD_STATUSES.has(status);
  });
}

// The parents that a producing subagent child should keep in "working", derived ONCE
// per recompute instead of a per-parent by_parent_conversation_id scan for every idle
// row (~one indexed query per row — the op-count blowout behind "too many system
// operations" timeouts on this heartbeat-hot path). The derivation is sound because
// subagentIsProducing accepts only two proofs, and both pools are already in
// hand: a child that synced output within the last 5 minutes sits at the top of the
// recent window scan, and a live child with an active agent status is in
// maps.liveConvIds (its doc hydrated by hydrateLivePool when the window missed it —
// bounded by the count of actually-live daemons). Pure over its inputs so it's
// unit-testable.
export function deriveProducingParents(
  pool: any[],
  maps: Pick<InboxSessionMaps, "liveConvIds" | "agentStatusMap"> &
    Partial<Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveLeaseIds">>,
  now: number,
): Set<string> {
  const parents = new Set<string>();
  for (const c of pool) {
    if (!c.parent_conversation_id) continue;
    if (childIsProducing(c, maps, now))
      parents.add(c.parent_conversation_id.toString());
  }
  return parents;
}

// The candidate pool plus every live conversation the windows missed (a live
// child of a parent outside the window still parks that parent).
// The candidate pool the child rollups read: the scan's rows, every LIVE
// conversation (a producing child parks its settled parent), and every row
// holding a pending `cast decide` (a spawned worker's decision lifts its
// parent whether or not the worker is still live).
export async function hydrateLivePool(
  ctx: any,
  conversations: any[],
  maps: InboxSessionMaps,
  extraIds: Iterable<string> = [],
): Promise<any[]> {
  const seen = new Set<string>(conversations.map((c: any) => c._id.toString()));
  const pool = [...conversations];
  const missingLiveIds = [
    ...new Set([...maps.liveConvIds, ...extraIds]),
  ].filter((cid) => !seen.has(cid));
  const hydratedLive = await Promise.all(
    missingLiveIds.map((cid) =>
      Promise.resolve(ctx.db.get(cid as Id<"conversations">)).catch(() => null),
    ),
  );
  for (const c of hydratedLive) if (c) pool.push(c);
  return pool;
}

// Newest message of a conversation — the one authoritative read behind both the
// un-backfilled last-role fallback and the AskUserQuestion probe.
export async function newestMessage(
  ctx: any,
  convId: Id<"conversations">,
): Promise<any | null> {
  return ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) =>
      q.eq("conversation_id", convId),
    )
    .order("desc")
    .first();
}

// An open AskUserQuestion poll: the chronologically latest message is the
// assistant's AskUserQuestion tool_use (an answer would be a later-timestamped
// tool_result, so if the poll is still last, it's unanswered).
export function isOpenAskUserQuestion(msg: any): boolean {
  return (
    !!msg &&
    msg.role === "assistant" &&
    !!msg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion")
  );
}

// Pending `cast decide` questions for the user that lift a session into
// QUESTIONS (isStackedAsk: blocking, or filed into a named stack). Same people set as
// listForUserCore: decision_inbox (assignment), then the legacy owner index
// for rows minted before asked_user_ids existed. session_decisions.user_id
// is the RUNNER — using it here kept a hosted session's questions on the
// host's stack after the seat was assigned away.
export async function loadPendingDecisionConvIds(
  ctx: any,
  userId: Id<"users">,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const uid = userId.toString();
  const inbox = await ctx.db
    .query("decision_inbox")
    .withIndex("by_user_status", (q: any) =>
      q.eq("user_id", userId).eq("status", "pending"),
    )
    .collect();
  for (const r of inbox) {
    const d = await ctx.db.get(r.decision_id);
    if (!d || !isStackedAsk(d)) continue;
    if (
      d.asked_user_ids !== undefined &&
      !d.asked_user_ids.some((id: any) => String(id) === uid)
    )
      continue;
    ids.add(d.conversation_id.toString());
  }
  const legacy = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) =>
      q.eq("user_id", userId).eq("status", "pending"),
    )
    .collect();
  for (const r of legacy) {
    if (r.asked_user_ids !== undefined || !isStackedAsk(r)) continue;
    ids.add(r.conversation_id.toString());
  }
  return ids;
}

// The child AUQ probe answers, cached across executions by (child id,
// message_count): a heartbeat re-execution over an unchanged fleet pays zero
// newest-message reads for its children. Sound because message_count moves on
// every message insert (an AUQ answer is a new tool_result message), and the
// child's conversation doc is in the subscription's read set through the pool
// scan — so a change re-executes with a fresh key. Bounded; cleared wholesale
// at the cap rather than tracking recency.
const CHILD_AUQ_PROBE_CACHE_MAX = 4096;

export const childAuqProbeCache = new Map<string, boolean>();

export function _resetChildAuqProbeCacheForTests(): void {
  childAuqProbeCache.clear();
  newestMessageCache.clear();
}

// Parents with a child that is asking: a child whose trusted status is
// permission_blocked (from the maps), or a child with an open AskUserQuestion —
// the same probe as the parent's own, run only for children with a non-idle
// trusted status and content, so it is bounded by live children.
//
// Read discipline (pinned by the overlay read-budget test): set membership is
// checked BEFORE a probe is enqueued — a parent already asking through a
// pending `cast decide` (alreadyAsking) or a sibling's permission block never
// spends a message read — and cache hits answer without one.
//
// A child's ask rests on its trusted status, which decays with time alone (a
// heartbeat ages out, a status outlives its trust), so the lift does too.
// `liftUntil` is the instant a lifted parent's last asking child stops
// asking, over what this execution read (null: no time bound). The overlay
// ships it as child_asking_until, so the replica, which never holds the
// child, drops the lift at the instant the server would (childAskingAt).
export async function buildAskingParents(
  ctx: any,
  childrenByParent: Map<string, any[]>,
  maps: Pick<
    InboxSessionMaps,
    "liveConvIds" | "agentStatusMap" | "openTasksMap"
  > &
    Partial<Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveLeaseIds">>,
  now: number,
  alreadyAsking?: ReadonlySet<string>,
  // Whether a child is still in the pool at instant t (default: always). A
  // child the scan did not return joins the pool only while it is live
  // (hydrateLivePool), so its ask leaves with its heartbeat.
  pooledAt: (cid: string, t: number) => boolean = () => true,
  maxProbes = Infinity,
): Promise<{
  asking: Set<string>;
  probedAuqOpen: Map<string, boolean>;
  liftUntil: (pid: string) => number | null;
}> {
  const asking = new Set<string>();
  const probedAuqOpen = new Map<string, boolean>();
  const probes: Array<{
    pid: string;
    cid: string;
    convId: Id<"conversations">;
    key: string;
  }> = [];
  const probeKey = (c: any) => `${c._id.toString()}:${c.message_count ?? 0}`;
  // What a child's status says about its ask at instant t: a permission
  // prompt, a status under which an AskUserQuestion poll may be open, or none.
  const childAskAt = (c: any, t: number): "permission" | "poll" | null => {
    const cid = c._id.toString();
    const status = trustedAgentStatus(
      maps.agentStatusMap.get(cid),
      c.updated_at,
      t,
      isLiveAt(maps, cid, t),
      verifiedWaitingFor(maps, cid, t),
    );
    // A permission prompt is the child's own ask (ownAsk) whatever its
    // message count, so it lifts the parent the same way on every side.
    if (status === "permission_blocked") return "permission";
    // Only a child with content can hold an AskUserQuestion poll: an empty
    // one never spends the probe's message read.
    if ((c.message_count ?? 0) > 0 && status !== undefined && status !== "idle")
      return "poll";
    return null;
  };
  for (const [pid, children] of childrenByParent) {
    if (alreadyAsking?.has(pid)) {
      asking.add(pid);
      continue;
    }
    for (const c of children) {
      const cid = c._id.toString();
      if (c.inbox_killed_at || isClosedSession(c)) continue;
      // A child's own pending `cast decide` (a spawned subagent worker posts
      // on ITS session) lifts the parent exactly as its open prompt does.
      if (alreadyAsking?.has(cid)) {
        asking.add(pid);
        break;
      }
      const ask = childAskAt(c, now);
      if (ask === "permission") {
        asking.add(pid);
        break;
      }
      if (ask === "poll") {
        const key = probeKey(c);
        const hit =
          maxProbes === Infinity ? childAuqProbeCache.get(key) : undefined;
        if (hit !== undefined) {
          probedAuqOpen.set(cid, hit);
          if (hit) {
            asking.add(pid);
            break;
          }
        } else if (probes.length < maxProbes) {
          probes.push({ pid, cid, convId: c._id, key });
        }
      }
    }
  }
  // `undefined` marks a probe skipped because its parent resolved first — a
  // skipped probe is never cached (its answer was never read).
  const results = await Promise.all(
    probes.map((p) =>
      asking.has(p.pid) ? undefined : newestMessage(ctx, p.convId),
    ),
  );
  probes.forEach((p, i) => {
    const msg = results[i];
    if (msg === undefined) return;
    const open = isOpenAskUserQuestion(msg);
    if (maxProbes === Infinity) {
      if (childAuqProbeCache.size >= CHILD_AUQ_PROBE_CACHE_MAX)
        childAuqProbeCache.clear();
      childAuqProbeCache.set(p.key, open);
    }
    probedAuqOpen.set(p.cid, open);
    if (open) asking.add(p.pid);
  });
  const askingAt = (pid: string, t: number): boolean => {
    if (alreadyAsking?.has(pid)) return true;
    return (childrenByParent.get(pid) ?? []).some((c) => {
      if (
        c.inbox_killed_at ||
        isClosedSession(c) ||
        !pooledAt(c._id.toString(), t)
      )
        return false;
      if (alreadyAsking?.has(c._id.toString())) return true;
      const ask = childAskAt(c, t);
      // A poll this execution never read (its parent resolved first) is not
      // known closed, so it keeps the lift.
      return (
        ask === "permission" ||
        (ask === "poll" &&
          (probedAuqOpen.get(c._id.toString()) ??
            (maxProbes === Infinity
              ? childAuqProbeCache.get(probeKey(c))
              : undefined)) !== false)
      );
    });
  };
  // A lift only decays (a trusted status never turns into an ask with time),
  // so it ends at the first of its children's live deadlines past which no
  // child asks.
  const liftUntil = (pid: string): number | null => {
    if (!asking.has(pid)) return null;
    // oxfmt-ignore
    const deadlines = (childrenByParent.get(pid) ?? []).flatMap((c) =>
      rowLiveDeadlines({ updated_at: c.updated_at, liveness_lease_end: inboxLeaseEnd(maps, c._id.toString()) }));
    const ahead = [
      ...new Set(deadlines.filter((d): d is number => d != null && d > now)),
    ].sort((a, b) => a - b);
    return ahead.find((d) => !askingAt(pid, d)) ?? null;
  };
  return { asking, probedAuqOpen, liftUntil };
}

// A row's own ask: an open AskUserQuestion poll or a permission prompt. An
// infrastructure park is not a decision: a row whose newest turn is an
// unresolved login / limit / dropped-connection banner (BLOCKED_BANNER_KINDS)
// is blocked on plumbing, and files needs_input through the pendingApiError
// arm — the same exception the web decision queue applies
// (lib/decisionQueue sessionHasOpenQuestion), so both sides share one rule.
export function ownAsk(
  lv: { awaiting_input?: boolean | null; agent_status?: string | null },
  conv?: { pending_api_error_kind?: string | null; agent_type?: string | null },
): boolean {
  if (
    conv?.pending_api_error_kind &&
    BLOCKED_BANNER_KINDS.has(conv.pending_api_error_kind)
  )
    return false;
  // A hosted conversation asks only through its decision row (the pending
  // decision ids every caller ORs in); its permission_blocked status lags an
  // answer. The web queue applies the same rule.
  if (isHostedAgentType(conv?.agent_type)) return false;
  return !!lv.awaiting_input || lv.agent_status === "permission_blocked";
}

// The one placement call for a conversation, from the doc plus its
// liveness-shaped fields (the overlay's derived values or the enriched row's —
// same names, same meaning). Both the overlay and inboxForCLI go through here.
// The liveness facts placeConversationRow reads off a row. Every row projection
// it places carries each of them (conversationFields.guard.test.ts): a fact a
// projection omits reads as absent, and an absent heartbeat reads as a dead one.
// oxfmt-ignore
export const PLACEMENT_LIVENESS_FIELDS = [
  "agent_status", "updated_at", "is_idle", "awaiting_input", "is_unresponsive", "agent_status_boundary",
  "open_tasks", "open_tasks_at", "producing_until", "last_heartbeat",
  "liveness_lease_end",
] as const satisfies ReadonlyArray<keyof LivenessFields>;

export function placeConversationRow(
  conv: any,
  lv: Partial<Pick<LivenessFields, (typeof PLACEMENT_LIVENESS_FIELDS)[number]>>,
  asking: boolean,
  lastUserMessage: string | null | undefined,
  now: number,
): InboxPlacement {
  // Delegates to the SHARED row adapter (placeProjectableRow) so the server and
  // every replica build the identical InboxPlacementInput from the identical
  // fields — a placement rule cannot exist on one side only (C3). The probed
  // lastUserMessage overrides the row's own preview (it covers the
  // un-backfilled fallback), and the loop park is time-dependent, so the
  // caller's clock rides through: the time-flip machinery re-runs this at
  // future instants and rowTimeDeadlines carries the loop's expiry boundary.
  return placeProjectableRow(
    {
      ...conv,
      // The row ships the daemon's raw status; placement reads the verdict.
      agent_status:
        trustedStatusAt(
          {
            agent_status: lv.agent_status ?? null,
            updated_at: lv.updated_at ?? conv.updated_at,
            last_heartbeat: lv.last_heartbeat ?? null,
            liveness_lease_end: lv.liveness_lease_end ?? null,
            open_tasks: lv.open_tasks ?? null,
            open_tasks_at: lv.open_tasks_at ?? null,
          },
          now,
        ) ?? null,
      agent_status_boundary: lv.agent_status_boundary ?? null,
      is_idle: lv.is_idle ?? null,
      awaiting_input: lv.awaiting_input ?? null,
      is_unresponsive: lv.is_unresponsive ?? null,
      open_tasks: lv.open_tasks ?? null,
      open_tasks_at: lv.open_tasks_at ?? null,
      // The open-task vouch holds only while the row's own heartbeat lives.
      last_heartbeat: lv.last_heartbeat ?? null,
      liveness_lease_end: lv.liveness_lease_end ?? null,
      producing_until: lv.producing_until ?? null,
      last_message_preview: lastUserMessage ?? null,
      last_user_message: null,
      last_turn_allows_park: undefined,
    },
    asking,
    now,
  );
}

export function inboxLeaseEnd(
  maps: Partial<Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveLeaseIds">>,
  cid: string,
): number | null {
  if (maps.liveLeaseIds?.has(cid)) return LIVE_INBOX_LEASE_END;
  const heartbeat = maps.lastHeartbeatMap?.get(cid);
  return heartbeat === undefined ? null : heartbeat + HEARTBEAT_ALIVE_MS;
}

// The instant after which the daemon behind this row no longer counts as
// alive, before the stopped override (deriveLiveAt applies that from the
// status): the row's own heartbeat window, or the user's most recent daemon
// vouching for a recently active conversation. Pure in the maps, so the same
// value ships at every execution over the same data.
export function daemonAliveUntil(
  maps: Pick<
    InboxSessionMaps,
    | "lastHeartbeatMap"
    | "latestHeartbeat"
    | "liveLeaseIds"
    | "hasLiveDaemonLease"
  >,
  cid: string,
  updatedAt: number,
): number | null {
  const own = inboxLeaseEnd(maps, cid);
  const user = maps.hasLiveDaemonLease
    ? updatedAt + CONV_DAEMON_ALIVE_MS
    : maps.latestHeartbeat !== undefined
      ? Math.min(
          maps.latestHeartbeat + USER_DAEMON_ALIVE_MS,
          updatedAt + CONV_DAEMON_ALIVE_MS,
        )
      : null;
  if (own == null) return user;
  if (user == null) return own;
  return Math.max(own, user);
}

// The instant after which no child keeps this parent producing. "A child is
// producing" (childIsProducing) only ever turns false as time passes
// (a grace lapses, a heartbeat dies, a status decays), so its flip is the
// largest child deadline at which the predicate still held one instant
// before. Evaluated through the predicate itself — never a re-derived
// formula — so the fact cannot disagree with the rule.
export function producingUntilOf(
  children: any[],
  maps: InboxSessionMaps,
): number | null {
  if (children.length === 0) return null;
  const producing = (t: number) =>
    children.some((c: any) => childIsProducing(c, maps, t));
  let until: number | null = null;
  for (const c of children) {
    const candidates = [
      c.updated_at + SUBAGENT_PRODUCING_GRACE_MS,
      c.updated_at + STATUS_TRUST_TTL_MS,
      c.updated_at + HEARTBEAT_ALIVE_MS,
      inboxLeaseEnd(maps, c._id.toString()),
    ];
    for (const d of candidates) {
      if (d == null || (until != null && d <= until)) continue;
      if (producing(d - 1)) until = d;
    }
  }
  return until;
}
