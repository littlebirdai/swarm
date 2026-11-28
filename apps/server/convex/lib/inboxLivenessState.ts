import { wakeFieldsOf } from "../wakeCost";
import { v } from "convex/values";
import {
  computeBucketStale,
  digestProjection,
  inboxEpoch,
  emptyInboxTally,
  rideLeadPlacements,
  deriveLiveAt,
  rowLiveDeadlines,
  childAskingAt,
  rowLastTurnAllowsPark,
  INBOX_PROJECTION_VERSION,
  type InboxBucket,
  type InboxPlacement,
  type InboxProjection,
} from "@codecast/inbox/inboxProjection";
import { Id } from "../_generated/dataModel";
import {
  shouldShowInInbox,
  lastRoleIsUserOf,
  trustedAgentStatus,
  type WorkState,
} from "../inboxFilters";
import {
  FOREIGN_SCAN_BUDGET,
  type InboxOverlayRow,
  type LivenessFields,
  type NewestMessageFacts,
  buildAskingParents,
  childAuqProbeCache,
  daemonAliveUntil,
  groupPoolChildren,
  hasLiveNestedChild,
  hydrateLivePool,
  inboxDigestDisabled,
  inboxLeaseEnd,
  isOpenAskUserQuestion,
  loadPendingDecisionConvIds,
  newestMessage,
  newestMessageCache,
  ownAsk,
  placeConversationRow,
  producingUntilOf,
} from "./inboxLivenessPlacement";
import {
  type InboxSessionMaps,
  belowFoldFor,
  buildNamedSessionMaps,
  buildUserSessionMaps,
  isLiveAt,
  mergeForeignConversationLiveness,
  truncatedList,
  verifiedWaitingFor,
} from "./inboxMaps";
import { scanInboxConversations } from "./inboxScan";

// Everything one liveness row needs that costs a read, gathered once per row at
// the epoch. The derivation over it (deriveLivenessAt) is pure in `now`, which
// is what lets the time flip re-run it at a later instant with zero reads.
type LivenessRowReads = {
  lastMsgRole: string | undefined;
  lastUserMessage: string | null;
  // The AskUserQuestion probe's answer. Gated on the working bucket (!isIdle at
  // the epoch) exactly as enrichInboxSessionRow gates it; a row idle at the
  // epoch is idle at every later instant (isIdle is monotone in time), so the
  // gate never re-opens and the answer stays valid for the flip.
  auqOpen: boolean;
};

// The overlay row's live fields at instant `now`: the row's FACTS (pure in the
// doc, the maps and the probe reads — no clock) fed through the SHARED
// deriveLiveAt. The same call a replica makes over the shipped facts, so the
// stamp, the time flip (placeAt at each deadline) and the replica's render
// are one function of (facts, t) — sync-convergence C1/C2, ct-47609.
function deriveLivenessAt(
  conv: any,
  maps: InboxSessionMaps,
  reads: LivenessRowReads,
  producingUntil: number | null,
  now: number,
): LivenessFields {
  const cid = conv._id.toString();
  const openTasks = maps.openTasksMap.get(cid);
  const settle = maps.settleFactsMap.get(cid);
  const facts = {
    status: conv.status,
    agent_type: conv.agent_type,
    updated_at: conv.updated_at,
    message_count: conv.message_count ?? 0,
    has_pending_messages: !!conv.has_pending_messages,
    inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
    inbox_stashed_at: conv.inbox_stashed_at ?? null,
    inbox_snoozed_until: conv.inbox_snoozed_until ?? null,
    agent_status: maps.agentStatusMap.get(cid) ?? null,
    agent_status_updated_at: maps.agentStatusUpdatedAtMap.get(cid) ?? null,
    last_heartbeat: maps.lastHeartbeatMap.get(cid) ?? null,
    liveness_lease_end: inboxLeaseEnd(maps, cid),
    daemon_alive_until: daemonAliveUntil(maps, cid, conv.updated_at),
    producing_until: producingUntil,
    last_role_is_user: lastRoleIsUserOf(
      reads.lastMsgRole,
      reads.lastUserMessage,
    ),
    auq_open: reads.auqOpen,
    open_tasks: openTasks?.tasks ?? null,
    open_tasks_at: openTasks?.at ?? null,
  };
  const live = deriveLiveAt(facts, now);
  return {
    // Every fact is EXPLICIT, null when there is none (C1: facts have one
    // writer). Convex drops an undefined key from the payload, and a replica
    // that merges only the keys it receives then keeps the previous
    // execution's value forever — a "stopped" from the day the daemon died
    // outlived the managed row and filed a declared-done session under Needs
    // Input on every replica while this stamp said done (prod, 2026-09-01).
    agent_status: facts.agent_status,
    is_idle: live.is_idle,
    is_unresponsive: live.is_unresponsive,
    awaiting_input: live.awaiting_input,
    is_connected: live.daemon_alive,
    tmux_session: maps.tmuxSessionMap.get(cid) ?? null,
    claude_backend: maps.sdkBackendConvIds.has(cid) ? ("sdk" as const) : null,
    permission_mode: maps.permissionModeMap.get(cid) ?? null,
    agent_started_at: maps.agentStartedAtMap.get(cid) ?? null,
    open_tasks: facts.open_tasks,
    open_tasks_at: facts.open_tasks_at,
    message_count: facts.message_count,
    updated_at: conv.updated_at,
    // reads.lastUserMessage is the row's preview with the probed fallback for
    // un-backfilled rows — exactly the input the park rule needs (C1).
    last_turn_allows_park: rowLastTurnAllowsPark({
      last_message_preview: reads.lastUserMessage,
    }),
    agent_status_updated_at: facts.agent_status_updated_at,
    agent_status_boundary: settle?.boundary === true,
    turn_completed_at: settle?.turnCompletedAt ?? null,
    hibernated_at: maps.hibernatedAtMap.get(cid) ?? null,
    last_heartbeat: facts.last_heartbeat,
    liveness_lease_end: facts.liveness_lease_end,
    last_role_is_user: facts.last_role_is_user,
    auq_open: facts.auq_open,
    daemon_alive_until: facts.daemon_alive_until,
    producing_until: facts.producing_until,
    activity: conv.activity ?? null,
    ...wakeFieldsOf(conv),
  };
}

// One row's liveness facts and placement at instant `t`: the per-row input
// builder every classifier consumer goes through — the overlay's stamp and
// its time flip (computeSessionsLiveness) and the org tree (classifyWorkStates)
// — so a placement can never be derived from a different set of inputs on
// one path only.
function placeLivenessRowAt(
  conv: any,
  maps: InboxSessionMaps,
  reads: LivenessRowReads,
  producingUntil: number | null,
  askingFor: (lv: LivenessFields, t: number) => boolean,
  t: number,
): { lv: LivenessFields; asking: boolean; placement: InboxPlacement } {
  const lv = deriveLivenessAt(conv, maps, reads, producingUntil, t);
  const asking = askingFor(lv, t);
  return {
    lv,
    asking,
    placement: placeConversationRow(conv, lv, asking, reads.lastUserMessage, t),
  };
}

// The classifier verdict for rows OUTSIDE the inbox scan (the org tree,
// org.ts): the caller's managed-session maps with the foreign rows' liveness
// merged, the same per-row reads, and placeLivenessRowAt — one classifier,
// one alphabet. `childrenByParent` (keyed by nestParentIdOf) supplies the
// producing rollup that parks a settled parent while a child streams. The
// asking input only moves the bucket, never work_state, so the row's own ask
// is all it needs.
export async function classifyWorkStates(
  ctx: any,
  userId: Id<"users">,
  conversations: any[],
  childrenByParent: Map<string, any[]>,
  now: number,
): Promise<Map<string, WorkState>> {
  const maps = await buildUserSessionMaps(ctx, userId, now);
  const uid = userId.toString();
  const foreign = conversations.filter((c) => c.user_id.toString() !== uid);
  if (foreign.length > 0)
    await mergeForeignConversationLiveness(ctx, maps, foreign, now);
  const reads = await Promise.all(
    conversations.map((conv) => readLivenessRowInputs(ctx, conv, maps, now)),
  );
  const out = new Map<string, WorkState>();
  conversations.forEach((conv, i) => {
    const cid = conv._id.toString();
    const producingUntil = producingUntilOf(
      childrenByParent.get(cid) ?? [],
      maps,
    );
    const { placement } = placeLivenessRowAt(
      conv,
      maps,
      reads[i],
      producingUntil,
      (lv) => ownAsk(lv, conv),
      now,
    );
    out.set(cid, placement.work_state);
  });
  return out;
}

// One session's work state and when its status last moved, for a surface
// that names it (a published page's agent chip). Reads the named liveness
// (buildNamedSessionMaps), not the runner's whole managed_sessions set, so a
// page polled by many viewers costs a handful of documents a poll.
export async function classifyNamedWorkState(
  ctx: any,
  conv: any,
  now: number,
): Promise<{ state: WorkState; since: number }> {
  const { maps, children } = await buildNamedSessionMaps(
    ctx,
    conv.user_id,
    [conv],
    now,
  );
  const reads = await readLivenessRowInputs(ctx, conv, maps, now);
  const cid = conv._id.toString();
  const producingUntil = producingUntilOf(
    groupPoolChildren(children).get(cid) ?? [],
    maps,
  );
  const { placement } = placeLivenessRowAt(
    conv,
    maps,
    reads,
    producingUntil,
    (lv) => ownAsk(lv, conv),
    now,
  );
  return {
    state: placement.work_state,
    since: maps.agentStatusUpdatedAtMap.get(cid) ?? conv.updated_at,
  };
}

// The reads for one row: the un-backfilled last-role fallback and the AUQ
// probe are the same newest-message read, so a row pays it at most once.
async function readLivenessRowInputs(
  ctx: any,
  conv: any,
  maps: InboxSessionMaps,
  now: number,
): Promise<LivenessRowReads> {
  let lastMsgRole: string | undefined = conv.last_message_role;
  let lastUserMessage: string | null = conv.last_message_preview || null;
  let facts: NewestMessageFacts | null | undefined = undefined; // undefined = not read yet
  if (!lastMsgRole && conv.message_count > 0) {
    facts = await newestMessageFacts(ctx, conv);
    if (facts) {
      lastMsgRole = facts.role;
      if (facts.userText !== null) lastUserMessage = facts.userText;
    }
  }
  const reads: LivenessRowReads = {
    lastMsgRole,
    lastUserMessage,
    auqOpen: false,
  };
  const base = deriveLivenessAt(conv, maps, reads, null, now);
  if (
    (!base.is_idle || base.agent_status === "hibernated") &&
    conv.message_count > 0
  ) {
    if (facts === undefined) facts = await newestMessageFacts(ctx, conv);
    reads.auqOpen = !!facts?.auqOpen;
  }
  return reads;
}

// The newest message as the liveness readers use it, cached across executions
// by (conversation id, message_count) like the child probe cache above. The
// probe reads a whole message document (tool results, inline images, the
// embedding), tens of KB for a working session, and the overlay and the org
// tree re-ran it for every non-idle row on every heartbeat: about 2 MB a
// sessionsLiveness run on 2026-11-12 (ct-92571). A message is cached only when
// no in-place edit can turn it into an open AskUserQuestion: a streamed row
// is patched without touching the conversation (so message_count holds), and
// only an assistant row without its final usage is still streaming. Anything
// else that moves the answer is a new message, which moves message_count.
const NEWEST_MESSAGE_CACHE_MAX = 4096;

async function newestMessageFacts(
  ctx: any,
  conv: any,
): Promise<NewestMessageFacts | null> {
  const key = `${conv._id.toString()}:${conv.message_count ?? 0}`;
  const hit = newestMessageCache.get(key);
  if (hit) return hit;
  const msg = await newestMessage(ctx, conv._id);
  if (!msg) return null;
  const facts: NewestMessageFacts = {
    role: msg.role,
    userText:
      msg.role === "user" && msg.content?.trim()
        ? msg.content
            .replace(/\[Image[:\s][^\]]*\]/gi, "")
            .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
            .trim()
            .slice(0, 200)
        : null,
    auqOpen: isOpenAskUserQuestion(msg),
  };
  if (msg.role !== "assistant" || msg.usage || facts.auqOpen) {
    if (newestMessageCache.size >= NEWEST_MESSAGE_CACHE_MAX)
      newestMessageCache.clear();
    newestMessageCache.set(key, facts);
  }
  return facts;
}

export async function computeSessionsLiveness(
  ctx: any,
  userId: Id<"users">,
  teamScope?: Id<"teams">,
): Promise<{
  liveness: Record<string, InboxOverlayRow>;
  projection: InboxProjection;
}> {
  // The epoch is the payload's ONLY clock: no raw Date.now() may reach the
  // result, so two executions inside one minute are byte identical (C2).
  const now = inboxEpoch(Date.now());
  const scan = await scanInboxConversations(ctx, userId, now, {
    includeLiveness: true,
    teamScope,
    subagentWindow: true,
    indexedLiveness: teamScope === undefined,
  });
  const { conversations, maps, truncated } = scan;
  // Decisions FIRST: a parent already asking through a pending `cast decide`
  // never spends child message probes (see buildAskingParents), and a child
  // holding one joins the pool so its parent is lifted.
  const pendingDecisionIds = await loadPendingDecisionConvIds(ctx, userId);
  const pool = await hydrateLivePool(
    ctx,
    conversations,
    maps,
    pendingDecisionIds,
  );
  await scan.loadIndexedLiveness?.(
    [...pool, ...scan.recentSubagents].map((c) => c._id),
  );
  const childrenByParent = groupPoolChildren(pool);
  const scannedIds = new Set(conversations.map((c: any) => c._id.toString()));
  const pooledAt = (cid: string, t: number) =>
    scannedIds.has(cid) ||
    pendingDecisionIds.has(cid) ||
    isLiveAt(maps, cid, t);
  const {
    asking: askingParents,
    probedAuqOpen,
    liftUntil,
  } = await buildAskingParents(
    ctx,
    childrenByParent,
    maps,
    now,
    pendingDecisionIds,
    pooledAt,
  );
  const uid = userId.toString();
  const shownConvs = conversations.filter((conv) => shouldShowInInbox(conv));

  // Phase 1 — the per-row reads, concurrently (one await depth, not one per row).
  const reads = await Promise.all(
    shownConvs.map((conv) => readLivenessRowInputs(ctx, conv, maps, now)),
  );

  const producingUntilFor = (cid: string): number | null =>
    producingUntilOf(childrenByParent.get(cid) ?? [], maps);

  const foreignCandidates: Array<{ conv: any; i: number }> = [];
  shownConvs.forEach((conv, i) => {
    if (conv.user_id.toString() === uid) return;
    if (
      conv.inbox_dismissed_at ||
      conv.inbox_stashed_at ||
      !(conv.message_count > 0)
    )
      return;
    const cid = conv._id.toString();
    const base = deriveLivenessAt(conv, maps, reads[i], null, now);
    const pu = producingUntilFor(cid);
    if (base.is_idle && !(pu != null && now < pu))
      foreignCandidates.push({ conv, i });
  });
  foreignCandidates.sort((a, b) => b.conv.updated_at - a.conv.updated_at);
  if (foreignCandidates.length > FOREIGN_SCAN_BUDGET)
    truncated.add("foreign_scan");
  const scanTargets = foreignCandidates.slice(0, FOREIGN_SCAN_BUDGET);
  const scannedChildren = await Promise.all(
    scanTargets.map(({ conv }) =>
      ctx.db
        .query("conversations")
        .withIndex("by_parent_conversation_id", (q: any) =>
          q.eq("parent_conversation_id", conv._id),
        )
        .order("desc")
        .take(20),
    ),
  );
  if (scannedChildren.length)
    await scan.loadIndexedLiveness?.(scannedChildren.flat().map((c) => c._id));
  scanTargets.forEach(({ conv }, k) => {
    const cid = conv._id.toString();
    const known = new Set(
      (childrenByParent.get(cid) ?? []).map((c: any) => c._id.toString()),
    );
    const merged = [...(childrenByParent.get(cid) ?? [])];
    for (const c of scannedChildren[k])
      if (!known.has(c._id.toString())) merged.push(c);
    childrenByParent.set(cid, merged);
  });

  // Phase 3 — derive, place, stamp. Pure from here on.
  const liveness: Record<string, InboxOverlayRow> = {};
  const tally = { shown: emptyInboxTally(), folded: emptyInboxTally() };
  const entries: Array<[string, InboxBucket, boolean]> = [];
  shownConvs.forEach((conv, i) => {
    const cid = conv._id.toString();
    const producingUntil = producingUntilFor(cid);
    // The child half of the asking rollup, as a fact (the producing_until
    // precedent): the asking child may be a live pool row the replica never
    // holds, and its fact-only overlay row cannot create one. A parent with
    // its own pending decide is lifted by that, and its children are not
    // probed in this execution (buildAskingParents), so it reads false.
    const childAsking = askingParents.has(cid) && !pendingDecisionIds.has(cid);
    const childFacts = {
      child_asking: childAsking,
      child_asking_until: childAsking ? liftUntil(cid) : null,
      child_live: hasLiveNestedChild(
        childrenByParent.get(cid) ?? [],
        maps,
        now,
      ),
    };
    const askingFor = (lv: LivenessFields, t: number) =>
      ownAsk(lv, conv) ||
      pendingDecisionIds.has(cid) ||
      childAskingAt(childFacts, t);
    const placeAt = (t: number): InboxPlacement =>
      placeLivenessRowAt(conv, maps, reads[i], producingUntil, askingFor, t)
        .placement;
    const { lv, asking, placement } = placeLivenessRowAt(
      conv,
      maps,
      reads[i],
      producingUntil,
      askingFor,
      now,
    );
    const stale = computeBucketStale(
      // The shared deadline list over the SHIPPED facts: the replica's
      // recompute scheduler reads the same list, so no time term exists on
      // one side only (C2).
      {
        deadlines: rowLiveDeadlines({ ...conv, ...lv, ...childFacts }),
        placeAt,
        current: placement.bucket,
      },
      now,
    );
    liveness[cid] = {
      ...lv,
      ...childFacts,
      bucket: placement.bucket,
      work_state: placement.work_state,
      asking,
      below_fold: belowFoldFor(scan, conv),
      bucket_stale_at: stale.bucket_stale_at,
      stale_bucket: stale.stale_bucket,
    };
  });
  // Every shown row stamped on its own facts; then a teammate rides its
  // lead's bucket and time flip (the shared rideLeadPlacements — the fold rode
  // inside computeFold). The tally and the digest read the FINAL stamps.
  const convById = new Map(
    shownConvs.map((conv) => [conv._id.toString(), conv]),
  );
  const stamped = new Map(
    shownConvs.map((conv) => [
      conv._id.toString(),
      liveness[conv._id.toString()] as InboxOverlayRow & {
        bucket: InboxBucket;
        below_fold: boolean;
      },
    ]),
  );
  const rideRowOf = (id: string) =>
    liveness[id]?.child_live
      ? { ...convById.get(id), child_live: true }
      : convById.get(id);
  rideLeadPlacements(stamped, rideRowOf, (rider, lead) => {
    rider.bucket_stale_at = lead.bucket_stale_at;
    rider.stale_bucket = lead.stale_bucket;
  });
  for (const [cid, row] of stamped) {
    if (row.bucket !== "hidden")
      (row.below_fold ? tally.folded : tally.shown)[row.bucket]++;
    entries.push([cid, row.bucket, row.below_fold]);
  }

  // FACT-ONLY child rows (no bucket key): the live children the pool probes —
  // a non-idle trusted status with content — of shown parents, so a replica
  // can compute parent rollups (producing grace, asking) from replicated child
  // facts instead of message bodies (C1). Never members: no stamps, no tally,
  // no digest entry. The AUQ answer comes from this execution's probes or the
  // (child id, message_count) cache, so a warm and a cold execution over the
  // same data emit the same row.
  const shownIds = new Set(shownConvs.map((c) => c._id.toString()));
  for (const [pid, children] of childrenByParent) {
    if (!shownIds.has(pid)) continue;
    for (const c of children) {
      const cid = c._id.toString();
      if (liveness[cid] || (c.message_count ?? 0) === 0) continue;
      const status = trustedAgentStatus(
        maps.agentStatusMap.get(cid),
        c.updated_at,
        now,
        isLiveAt(maps, cid, now),
        verifiedWaitingFor(maps, cid, now),
      );
      if (status === undefined || status === "idle") continue;
      const auqOpen =
        probedAuqOpen.get(cid) ??
        childAuqProbeCache.get(`${cid}:${c.message_count ?? 0}`) ??
        false;
      const childReads: LivenessRowReads = {
        lastMsgRole: c.last_message_role,
        lastUserMessage: c.last_message_preview || null,
        auqOpen,
      };
      liveness[cid] = deriveLivenessAt(c, maps, childReads, null, now);
    }
  }
  for (const c of scan.recentSubagents) {
    const cid = c._id.toString();
    if (liveness[cid] || (c.message_count ?? 0) === 0) continue;
    const pid = c.parent_conversation_id?.toString();
    if (!pid || !shownIds.has(pid)) continue;
    const childReads: LivenessRowReads = {
      lastMsgRole: c.last_message_role,
      lastUserMessage: c.last_message_preview || null,
      auqOpen:
        probedAuqOpen.get(cid) ??
        childAuqProbeCache.get(`${cid}:${c.message_count ?? 0}`) ??
        false,
    };
    liveness[cid] = deriveLivenessAt(c, maps, childReads, null, now);
  }

  const projection: InboxProjection = {
    v: INBOX_PROJECTION_VERSION,
    epoch: now,
    user_id: uid,
    scope: teamScope ? "team" : "mine",
    team_id: teamScope ? teamScope.toString() : null,
    tally,
    set_digest: inboxDigestDisabled() ? null : digestProjection(entries),
    truncated: truncatedList(truncated),
  };
  return { liveness, projection };
}
