import { readInboxChildren } from "./cli-inbox-reads.rules";
import { wakeFieldsOf } from "../wakeCost";
import { fleetRowFields } from "../subagentFleet";
import { identityFieldsOf } from "./sessionIdentityFields";
import { Id } from "../_generated/dataModel";
import {
  isAdoptedChild,
  isRunLog,
  deriveSessionActivity,
  trustedAgentStatus,
  userRestOf,
  userRestStampOf,
  isSettleVerdictCurrent,
  ACTIVE_AGENT_STATUSES,
} from "../inboxFilters";
import { subagentLinkFields } from "../ccAccountsShared";
import { handoffLinkDetails } from "./conversationChildHelpers";
import { resolveActingAuthor } from "./conversationHelpers";
import {
  daemonAliveUntil,
  inboxLeaseEnd,
  newestMessage,
  producingUntilOf,
} from "./inboxLivenessPlacement";
import {
  CONV_DAEMON_ALIVE_MS,
  type InboxEnrichSkip,
  type InboxSessionMaps,
  userDaemonAliveAt,
  verifiedWaitingFor,
} from "./inboxMaps";

export async function enrichInboxSessionRow(
  ctx: any,
  conv: any,
  maps: InboxSessionMaps,
  now: number,
  // The row's fold flag (belowFoldFor over the caller's scan; false on the
  // paths that never fold — favorites, the completeness crawl, byIds).
  hidden: boolean,
  skip?: InboxEnrichSkip,
  getDoc: (id: any) => Promise<any> = (id) => ctx.db.get(id),
  scopedChildren?: any[],
): Promise<{
  row: any;
  subagentChildren: any[];
  dismissed: boolean;
  stashed: boolean;
  hidden: boolean;
}> {
  let hasPending = !!conv.has_pending_messages;
  let lastMsgRole = conv.last_message_role;
  let lastUserMessage = conv.last_message_preview || null;

  let lastMsg: any;
  if (!skip?.transcript && !lastMsgRole && conv.message_count > 0) {
    lastMsg = await newestMessage(ctx, conv._id);
    if (lastMsg) {
      lastMsgRole = lastMsg.role;
      if (lastMsg.role === "user" && lastMsg.content?.trim()) {
        lastUserMessage = lastMsg.content
          .replace(/\[Image[:\s][^\]]*\]/gi, "")
          .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
          .trim()
          .slice(0, 200);
      }
    }
  }

  if (conv.team_summary_only) lastUserMessage = null;

  const pinned = !!conv.inbox_pinned_at;
  const dismissed = !!conv.inbox_dismissed_at;
  const stashed = !!conv.inbox_stashed_at;
  let producingUntil: number | null = null;

  // Stop trusting a frozen "active" status once the conversation has gone quiet
  // past the trust TTL — otherwise a daemon re-asserting a stale "working" over
  // content-free heartbeats pins the session in WORKING forever. Coerced here, at
  // the single enrichment boundary, so is_idle / the row's agent_status / the CLI
  // classifier all see the same trustworthy value.
  const agentStatus = trustedAgentStatus(
    maps.agentStatusMap.get(conv._id.toString()),
    conv.updated_at,
    now,
    maps.liveConvIds.has(conv._id.toString()),
    verifiedWaitingFor(maps, conv._id.toString(), now),
  );
  // Don't let userDaemonAlive resurrect sessions we know are stopped
  const daemonAlive =
    agentStatus === "stopped"
      ? false
      : maps.liveConvIds.has(conv._id.toString()) ||
        (userDaemonAliveAt(maps, now) &&
          now - conv.updated_at < CONV_DAEMON_ALIVE_MS);

  // Even when the agent reports idle, recent activity (assistant just
  // finished streaming), pending messages, or a trailing user message all
  // mean work is in flight — don't flag as idle yet. The grace is measured
  // from the agent's status-change time, not conv.updated_at, so a syncing
  // message backlog can't hold a finished agent in "working". See
  // deriveSessionActivity / isSessionIdle.
  const activity = deriveSessionActivity({
    agentStatus,
    agentStatusUpdatedAt: maps.agentStatusUpdatedAtMap.get(conv._id.toString()),
    lastMessageRole: lastMsgRole,
    lastMessagePreview: lastUserMessage,
    hasPending,
    status: conv.status,
    updatedAt: conv.updated_at,
    daemonAlive,
    agentType: conv.agent_type,
    now,
  });
  let isIdle = activity.isIdle;
  const isUnresponsive = activity.isUnresponsive;

  // An open AskUserQuestion poll is the agent blocking on the user — it
  // belongs in "needs input", never "working". The daemon's agent_status is
  // raced (it sends permission_blocked once, then a later "working" signal
  // overwrites it while the poll is still open), so we derive the fact from
  // the authoritative data: the chronologically-latest message is the
  // assistant's AskUserQuestion tool_use (an answer would be a later-timestamped
  // tool_result, so if the poll is still last, it's unanswered).
  //
  // Gate only on the working bucket (!isIdle) to keep this off the idle path.
  // Do NOT pre-filter on conv.last_message_role — that field reflects sync
  // batch order, which can disagree with timestamp order (Claude writes the
  // poll's tool_use line out of order relative to surrounding entries), so it
  // would miss exactly the blocked sessions we care about. The order("desc")
  // read below is authoritative.
  let awaitingInput = false;
  if (
    !skip?.auq &&
    !skip?.transcript &&
    (!isIdle || agentStatus === "hibernated") &&
    conv.message_count > 0
  ) {
    if (lastMsg === undefined) lastMsg = await newestMessage(ctx, conv._id);
    if (
      lastMsg?.role === "assistant" &&
      lastMsg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion")
    ) {
      awaitingInput = true;
      isIdle = true; // blocked on the user, not actively working
    }
  }

  const deferred =
    conv.inbox_deferred_at && conv.inbox_deferred_at >= conv.updated_at;

  let implementationSession: { _id: string; title?: string } | undefined;
  const subagentChildren: any[] = [];
  if (!skip?.children && !dismissed && !stashed && conv.message_count > 0) {
    const children =
      scopedChildren ?? (await readInboxChildren(ctx.db, conv._id));
    const implChild = children.find(
      (c: any) => c.parent_message_uuid === "plan-handoff" && !c.is_subagent,
    );
    if (implChild) {
      implementationSession = {
        _id: implChild._id.toString(),
        title: implChild.title,
      };
    }
    // Until when a subagent child is genuinely PRODUCING, not merely alive (see
    // subagentIsProducing): a settled parent is parked on it until then
    // (classifyWorkState's childProducing).
    producingUntil = producingUntilOf(children, maps);
    for (const c of children) {
      if (
        (c.is_subagent ||
          (c.parent_conversation_id && !c.parent_message_uuid)) &&
        c.message_count > 0
      ) {
        subagentChildren.push(c);
      }
    }
  }

  let active_plan:
    | { _id: string; short_id: string; title: string; status: string }
    | undefined;
  if (!skip?.refs && conv.active_plan_id) {
    const p = await getDoc(conv.active_plan_id);
    if (p)
      active_plan = {
        _id: p._id,
        short_id: p.short_id,
        title: p.title,
        status: p.status,
      };
  }

  let active_task:
    | { _id: string; short_id: string; title: string; status: string }
    | undefined;
  if (!skip?.refs && conv.active_task_id) {
    const t = await getDoc(conv.active_task_id);
    if (t)
      active_task = {
        _id: t._id,
        short_id: t.short_id,
        title: t.title,
        status: t.status,
      };
  }

  // The card's workflow bar renders from these scalars alone (the run doc is
  // already in hand — zero extra reads): identity, progress, and the latest
  // running agent's "what it's doing" line.
  let workflow_run_status: string | null = null;
  // "workflow" for a Workflow-tool run, which runs inside this session's own agent process.
  let workflow_run_kind: string | null = null;
  let workflow_run_name: string | null = null;
  let workflow_run_agents_done: number | null = null;
  let workflow_run_agents_total: number | null = null;
  let workflow_run_activity: string | null = null;
  let workflow_run_started_at: number | null = null;
  if (!skip?.refs && conv.workflow_run_id) {
    const run = await getDoc(conv.workflow_run_id);
    if (run) {
      workflow_run_status = run.status;
      workflow_run_kind = run.run_kind ?? null;
      workflow_run_name = run.workflow_name ?? null;
      const nodes = run.node_statuses ?? [];
      workflow_run_agents_total = run.agent_count ?? (nodes.length || null);
      workflow_run_agents_done = nodes.filter(
        (n: any) => n.status === "completed",
      ).length;
      const runningNode = [...nodes]
        .reverse()
        .find((n: any) => n.status === "running");
      workflow_run_activity =
        runningNode?.activity || runningNode?.label || null;
      workflow_run_started_at = run.created_at ?? null;
    }
  }

  // An adopted flow station (shared isAdoptedChild) stands alone in the inbox,
  // so its row names the flow it works for: its parent is the run's log, and
  // the run carries the flow's name. Two reads, adopted rows only.
  let flow_name: string | null = null;
  let flow_run_id: string | null = null;
  if (!skip?.refs && isAdoptedChild(conv) && conv.parent_conversation_id) {
    const log = await getDoc(conv.parent_conversation_id);
    if (log && isRunLog(log)) {
      const run = await getDoc(log.workflow_run_id);
      flow_run_id = String(log.workflow_run_id);
      flow_name = run?.workflow_name ?? null;
    }
  }

  // Anchor identity: a personal anchor's bot isn't in the team roster, so the
  // client can't resolve it — stamp the bot's name/avatar here (self-guarded:
  // returns null for ordinary rows) so the sidebar shows the bot chip.
  const acting = skip?.refs
    ? null
    : await resolveActingAuthor(ctx, conv, getDoc);

  // Open teammate-comment threads (message, code-line, or global anchors) so
  // the card can surface "someone flagged this" without the conversation being
  // open. Read off the denormalized signal comments.refreshCommentSignal
  // maintains on the row — no per-row comments collect on this hot path.
  const open_comment_threads = conv.unresolved_comment_count ?? 0;

  const row = {
    _id: conv._id,
    session_id: conv.session_id,
    title: conv.title,
    subtitle: conv.subtitle,
    updated_at: conv.updated_at,
    started_at: conv.started_at,
    ...(conv.history_import ? { history_import: true } : {}),
    project_path: conv.project_path,
    rewind_staged: conv.rewind_staged ?? null,
    git_root: conv.git_root,
    git_branch: conv.git_branch,
    git_remote_url: conv.git_remote_url,
    agent_type: conv.agent_type,
    model: conv.model ?? null,
    effort: conv.effort ?? null,
    message_count: conv.message_count,
    transcript_revision: conv.transcript_revision ?? 0,
    idle_summary: conv.idle_summary,
    // The agent's pinned "where this stands" line; the card shows its headline
    // in place of the generated summary. msg_count rides along so the card can
    // say how far the thread has moved since the agent wrote it.
    thread_state: conv.thread_state ?? null,
    thread_state_at: conv.thread_state_at ?? null,
    thread_state_msg_count: conv.thread_state_msg_count ?? null,
    thread_state_status: conv.thread_state_status ?? null,
    is_idle: isIdle,
    awaiting_input: awaitingInput,
    // The conversation status is an input to the live derivation (an
    // unresponsive daemon is only ever an ACTIVE conversation's problem), so
    // every row channel carries it; a replica defaulting it to "active" filed a
    // completed conversation with queued work as unresponsive while the server
    // kept it working (two-replica simulation, ct-47609).
    status: conv.status ?? "active",
    // The is_idle inputs, on the enriched row too (the CLI and liveness-on
    // clients), so every channel that carries is_idle carries what derived it.
    agent_status_updated_at:
      maps.agentStatusUpdatedAtMap.get(conv._id.toString()) ?? null,
    // The settle's own facts (ct-49533): a boundary settle carries no verdict,
    // and the turn stamp is the identity a completion consumer dedupes on.
    agent_status_boundary:
      maps.settleFactsMap.get(conv._id.toString())?.boundary === true,
    turn_completed_at:
      maps.settleFactsMap.get(conv._id.toString())?.turnCompletedAt ?? null,
    hibernated_at: maps.hibernatedAtMap.get(conv._id.toString()) ?? null,
    last_heartbeat: maps.lastHeartbeatMap.get(conv._id.toString()) ?? null,
    liveness_lease_end: inboxLeaseEnd(maps, conv._id.toString()),
    last_role_is_user: activity.lastRoleIsUser,
    auq_open: awaitingInput,
    daemon_alive_until: daemonAliveUntil(
      maps,
      conv._id.toString(),
      conv.updated_at,
    ),
    producing_until: producingUntil,
    is_unresponsive: isUnresponsive,
    is_connected: !!daemonAlive,
    has_pending: hasPending,
    is_deferred: !!deferred,
    // The raw stamp beside its twin: the defer action writes it on the row for
    // its dispatch, so the row carries the server's value back.
    inbox_deferred_at: conv.inbox_deferred_at ?? null,
    // The user's own rest verdict, current per userRestOf (the raw stamp rides
    // along so the client re-checks currency as updated_at moves), and the
    // settle classifier's verdict, current per isSettleVerdictCurrent — the
    // client's sessionRestState reads these next to agent_status to place a
    // settled row in Needs You / Done / Dormant exactly as classifyWorkState does.
    user_rest: userRestOf(conv),
    inbox_rest: userRestStampOf(conv)?.rest ?? null,
    inbox_rest_at: userRestStampOf(conv)?.at ?? null,
    settle_verdict: isSettleVerdictCurrent(conv)
      ? (conv.settle_verdict ?? null)
      : null,
    is_pinned: pinned,
    inbox_pinned_at: conv.inbox_pinned_at ?? null,
    inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
    inbox_stashed_at: conv.inbox_stashed_at ?? null,
    inbox_snoozed_until: conv.inbox_snoozed_until ?? null,
    inbox_stash_hidden: conv.inbox_stash_hidden ?? null,
    // The retired marker: classifyWorkState uses it to keep a killed row out of
    // the Working bucket no matter what stale flags it still carries.
    inbox_killed_at: conv.inbox_killed_at ?? null,
    inbox_closed_at: conv.inbox_closed_at ?? null,
    inbox_adopted_at: conv.inbox_adopted_at ?? null,
    // The daemon's own status: every reader derives what it means at its own
    // clock (trustedStatusAt), since a verdict does not replay (ct-56054).
    agent_status: maps.agentStatusMap.get(conv._id.toString()) ?? null,
    tmux_session: maps.tmuxSessionMap.get(conv._id.toString()) ?? null,
    claude_backend: maps.sdkBackendConvIds.has(conv._id.toString())
      ? ("sdk" as const)
      : null,
    permission_mode: maps.permissionModeMap.get(conv._id.toString()) ?? null,
    agent_started_at: maps.agentStartedAtMap.get(conv._id.toString()) ?? null,
    open_tasks: maps.openTasksMap.get(conv._id.toString())?.tasks ?? null,
    open_tasks_at: maps.openTasksMap.get(conv._id.toString())?.at ?? null,
    // What the agent is doing now (see schema.activity); the overlay's twin of
    // this field for liveness-on clients and the CLI.
    activity: conv.activity ?? null,
    last_user_message: lastUserMessage,
    // Newest image in the conversation (see schema) — the inbox row thumbnail.
    // Presence doubles as "this session has images".
    image_preview_url: conv.team_summary_only
      ? null
      : (conv.image_preview_url ?? null),
    open_comment_threads,
    // Who spoke last in the open threads and what they said — the chip's
    // "Alice: typo in step 2" without any per-row query. author_id is a users
    // id string or "agent"; the client mutes the chip when it's the viewer.
    last_comment_author: conv.last_comment_author ?? null,
    last_comment_author_id: conv.last_comment_author_id ?? null,
    last_comment_excerpt: conv.last_comment_excerpt ?? null,
    last_comment_at: conv.last_comment_at ?? null,
    session_error: conv.session_error,
    // True when the latest turn is an unresolved Claude Code auth/API-error
    // banner ("Please run /login · API Error: 401 …", "You've hit your session
    // limit · resets 11:30pm"). The CLI got signed out, rejected, or
    // rate-limited mid-turn and the session is parked waiting on the user (or
    // the limit reset). Cleared automatically once a real turn supersedes the
    // banner (see messages.ts / apiErrorBatchAction). The kind ("auth" |
    // "limit" | "error") picks the session-pill label.
    pending_api_error: conv.pending_api_error === true,
    pending_api_error_kind: conv.pending_api_error_kind ?? null,
    pending_api_error_at: conv.pending_api_error_at ?? null,
    hosted_stop: conv.hosted_stop ?? null,
    // Size and last model call: what restarting it would cost (restart bar).
    ...wakeFieldsOf(conv),
    implementation_session: implementationSession,
    active_plan,
    active_task,
    worktree_name: conv.worktree_name,
    worktree_branch: conv.worktree_branch,
    cloud_placement: (conv as any).cloud_placement ?? null,
    cloud_workspace: (conv as any).cloud_workspace ?? null,
    cloud_seed: (conv as any).cloud_seed ?? null,
    local_mirror: (conv as any).local_mirror ?? null,
    cloud_context_too_large: (conv as any).cloud_context_too_large ?? null,
    cloud_placement_progress: (conv as any).cloud_placement_progress ?? null,
    migration_batch_id: (conv as any).migration?.batch_id ?? null,
    workflow_run_id: conv.workflow_run_id || null,
    // Read by the web's isSub (inboxStore) via isAgentSpawnedConversation so
    // the waiting chime stands down on a workflow sub as the push does.
    is_workflow_sub: conv.is_workflow_sub || false,
    is_workflow_primary: conv.is_workflow_primary || false,
    workflow_run_status,
    workflow_run_kind,
    workflow_run_name,
    flow_name,
    flow_run_id,
    workflow_run_agents_done,
    workflow_run_agents_total,
    workflow_run_activity,
    workflow_run_started_at,
    // Schedule that spawned this conversation as a run (see schema) — lets the
    // sidebar badge and the schedule strip attribute ANY run, not just the
    // latest one webList can resolve from last_run_session_uuid.
    agent_task_id: conv.agent_task_id?.toString() || null,
    // Denormalized armed inject-trigger state (see schema) — the classifier's
    // structural dormancy input, read off the row instead of agent_tasks.
    armed_trigger_kind: conv.armed_trigger_kind ?? null,
    // The pull request this session shepherds (see schema). Folded onto the row
    // so the inbox card and the thread state panel can show its state without
    // reading pull_requests per card.
    pr_status: conv.pr_status ?? null,
    ...fleetRowFields(conv),
    // Harness /loop state (see loopState.ts) — an armed self-wakeup makes this
    // session a standing machine intent, so the trigger set can row it like an
    // armed trigger. Stopped loops are a server-side tombstone only.
    loop_state:
      conv.loop_state && conv.loop_state.status !== "stopped"
        ? conv.loop_state
        : null,
    forked_from: conv.forked_from?.toString() || null,
    // Parent-link fields so a session emitted via THIS top-level scan self-identifies
    // as a subagent and nests under its parent (a subagent active in the last 30d is
    // pulled in here too — recentConversations has no subagent filter). Without them
    // it renders as a loose flat card. See subagentLinkFields (ct-37439).
    ...subagentLinkFields(conv),
    // Visible-child pointer + agent-team identity (see schema): links a
    // teammate/spawned session to its parent WITHOUT the subagent
    // nesting/hiding that parent_conversation_id implies.
    spawned_by_conversation_id:
      conv.spawned_by_conversation_id?.toString() || null,
    // The project a person put this session in; workers derive theirs from
    // the links above (packages/sessions/src/sessionProject).
    project_id: conv.project_id?.toString() || null,
    // Handoff link (see schema): the card reads handed_off_from the way it
    // reads spawned_by, since a handoff run from a human shell has no spawner.
    handed_off_from_conversation_id:
      conv.handed_off_from_conversation_id?.toString() || null,
    handed_off_to_conversation_id:
      conv.handed_off_to_conversation_id?.toString() || null,
    handed_off_from_details: skip?.refs
      ? null
      : await handoffLinkDetails(getDoc, conv.handed_off_from_conversation_id),
    handed_off_to_details: skip?.refs
      ? null
      : await handoffLinkDetails(getDoc, conv.handed_off_to_conversation_id),
    agent_team_name: conv.agent_team_name ?? null,
    agent_name: conv.agent_name ?? null,
    parent_message_uuid: conv.parent_message_uuid || null,
    icon: conv.icon,
    icon_color: conv.icon_color,
    ...(skip?.refs ? {} : await identityFieldsOf(conv, getDoc)),
    team_id: conv.team_id ?? null,
    is_private: conv.is_private ?? false,
    // The team feed reads the viewer's own sharing level off this row
    // (web lib/teamFeedRows), and the sharing actions write it here.
    team_visibility: conv.team_visibility ?? null,
    owner_device_id: (conv as any).owner_device_id ?? null,
    // The saved Claude account this session is pinned to (its setup-token),
    // null when it runs on the machine's login. The park card names the
    // account that actually hit the limit from it.
    cc_account: conv.cc_account ?? null,
    // The Codex account the process is signed in as. Null when the session
    // never recorded one: that is not the machine's current login, which a
    // switch can change out from under a still-running process.
    codex_account: conv.codex_account ?? null,
    // Second-party owner (the member responsible for steering; see schema).
    // author/owner display names are stamped by computeInboxSessions, which
    // caches the user docs across rows.
    owner_user_id: (conv as any).owner_user_id?.toString() ?? null,
    user_id: conv.user_id,
    acting_user_id: (conv as any).acting_user_id ?? null,
    is_anchor: !!(conv as any).anchor_id,
    anchor_id: (conv as any).anchor_id ?? null,
    last_turn_origin: conv.last_turn_origin ?? null,
    author_name: acting ? acting.name : undefined,
    author_avatar: acting ? acting.avatar : undefined,
    // Carried through so the client can filter the same session cache into the
    // Favorites view (a kept, long-term set) without a second row shape. The
    // favorites query below force-loads these regardless of the recency window.
    is_favorite: !!conv.is_favorite,
    // The page an agent offered as a pane; the card wears a small glyph while
    // the offer is unhandled (web lib/browserPaneOffer).
    browser_pane_offer: conv.browser_pane_offer ?? null,
  };

  return {
    row: spellAbsentAsNull(row),
    subagentChildren,
    dismissed,
    stashed,
    hidden,
  };
}

// An inbox row spells every absent optional as null, the spelling the
// sync-log cargo planner writes for an unset column (web lib/syncLogCargo
// planSessions). A key one feeder omits and another nulls replaces the whole
// row on every push of the other, so both row builders end here.
function spellAbsentAsNull<T extends Record<string, any>>(row: T): T {
  for (const k of Object.keys(row))
    if (row[k] === undefined) (row as any)[k] = null;
  return row;
}

// Build a subagent child row (lighter — children carry no AUQ/plan context).
export async function buildSubagentChildRow(
  child: any,
  maps: InboxSessionMaps,
  now: number,
  parentId: Id<"conversations">,
  getDoc: (id: any) => Promise<any>,
) {
  const childDaemon = maps.liveConvIds.has(child._id.toString());
  const childAgentStatus = trustedAgentStatus(
    maps.agentStatusMap.get(child._id.toString()),
    child.updated_at,
    now,
    childDaemon,
    verifiedWaitingFor(maps, child._id.toString(), now),
  );
  const childRecentlyUpdated = now - child.updated_at < 45 * 1000;
  const childHasPending = !!child.has_pending_messages;
  const childAgentIdle = childAgentStatus
    ? !ACTIVE_AGENT_STATUSES.has(childAgentStatus)
    : false;
  const childIsIdle = childAgentStatus
    ? childAgentIdle && !childHasPending
    : childDaemon
      ? !childHasPending && !childRecentlyUpdated
      : !childRecentlyUpdated;
  return spellAbsentAsNull({
    _id: child._id,
    session_id: child.session_id,
    title: child.title,
    subtitle: child.subtitle,
    updated_at: child.updated_at,
    started_at: child.started_at,
    project_path: child.project_path,
    rewind_staged: child.rewind_staged ?? null,
    git_root: child.git_root,
    git_branch: child.git_branch,
    git_remote_url: child.git_remote_url,
    agent_type: child.agent_type,
    model: child.model ?? null,
    message_count: child.message_count,
    transcript_revision: child.transcript_revision ?? 0,
    idle_summary: child.idle_summary,
    thread_state: child.thread_state ?? null,
    thread_state_at: child.thread_state_at ?? null,
    thread_state_msg_count: child.thread_state_msg_count ?? null,
    thread_state_status: child.thread_state_status ?? null,
    is_idle: childIsIdle,
    awaiting_input: false,
    is_unresponsive: false,
    // The facts placement re-derives the status from (PLACEMENT_LIVENESS_FIELDS),
    // carried exactly as the top-level row carries them. Without the heartbeat a
    // child quiet past the window read stopped while is_connected said live: a
    // station hand mid tool call settled as needs_input (ct-59591).
    status: child.status ?? "active",
    agent_status_updated_at:
      maps.agentStatusUpdatedAtMap.get(child._id.toString()) ?? null,
    agent_status_boundary:
      maps.settleFactsMap.get(child._id.toString())?.boundary === true,
    turn_completed_at:
      maps.settleFactsMap.get(child._id.toString())?.turnCompletedAt ?? null,
    hibernated_at: maps.hibernatedAtMap.get(child._id.toString()) ?? null,
    last_heartbeat: maps.lastHeartbeatMap.get(child._id.toString()) ?? null,
    liveness_lease_end: inboxLeaseEnd(maps, child._id.toString()),
    is_connected: !!childDaemon,
    has_pending: !!child.has_pending_messages,
    is_deferred: false,
    inbox_deferred_at: child.inbox_deferred_at ?? null,
    is_pinned: false,
    inbox_pinned_at: null,
    inbox_dismissed_at: child.inbox_dismissed_at ?? null,
    inbox_stashed_at: child.inbox_stashed_at ?? null,
    inbox_snoozed_until: child.inbox_snoozed_until ?? null,
    inbox_stash_hidden: child.inbox_stash_hidden ?? null,
    inbox_killed_at: child.inbox_killed_at ?? null,
    inbox_closed_at: child.inbox_closed_at ?? null,
    inbox_adopted_at: child.inbox_adopted_at ?? null,
    // The child's own rest verdict, carried like every other stamp above (the
    // is_deferred/is_pinned twins over it are hardcoded because a child never
    // holds those). Without these three the verdict is write-only on a
    // subagent row: stored by the dispatch, dropped by every read.
    user_rest: userRestOf(child),
    inbox_rest: userRestStampOf(child)?.rest ?? null,
    inbox_rest_at: userRestStampOf(child)?.at ?? null,
    agent_status: maps.agentStatusMap.get(child._id.toString()) ?? null,
    tmux_session: maps.tmuxSessionMap.get(child._id.toString()) ?? null,
    claude_backend: maps.sdkBackendConvIds.has(child._id.toString())
      ? ("sdk" as const)
      : null,
    permission_mode: maps.permissionModeMap.get(child._id.toString()) ?? null,
    agent_started_at: maps.agentStartedAtMap.get(child._id.toString()) ?? null,
    open_tasks: maps.openTasksMap.get(child._id.toString())?.tasks ?? null,
    open_tasks_at: maps.openTasksMap.get(child._id.toString())?.at ?? null,
    activity: child.activity ?? null,
    last_user_message: null,
    session_error: child.session_error,
    pending_api_error: child.pending_api_error === true,
    pending_api_error_kind: child.pending_api_error_kind ?? null,
    pending_api_error_at: child.pending_api_error_at ?? null,
    hosted_stop: child.hosted_stop ?? null,
    // Size and last model call: what restarting it would cost (restart bar).
    ...wakeFieldsOf(child),
    // Same parent-link fields as the top-level scan (subagentLinkFields), so the
    // two emission paths stay byte-consistent when the client dedups by _id. This
    // path is for confirmed children, so is_subagent is forced true (covers the
    // parent_message_uuid-less child that has no is_subagent flag of its own).
    ...subagentLinkFields({
      is_subagent: true,
      parent_conversation_id: parentId,
    }),
    spawned_by_conversation_id:
      child.spawned_by_conversation_id?.toString() || null,
    agent_team_name: child.agent_team_name ?? null,
    agent_name: child.agent_name ?? null,
    owner_device_id: child.owner_device_id ?? null,
    cc_account: child.cc_account ?? null,
    codex_account: child.codex_account ?? null,
    cloud_placement: child.cloud_placement ?? null,
    cloud_workspace: child.cloud_workspace ?? null,
    cloud_seed: child.cloud_seed ?? null,
    local_mirror: child.local_mirror ?? null,
    cloud_context_too_large: child.cloud_context_too_large ?? null,
    cloud_placement_progress: child.cloud_placement_progress ?? null,
    migration_batch_id: child.migration?.batch_id ?? null,
    worktree_name: child.worktree_name,
    worktree_branch: child.worktree_branch,
    ...fleetRowFields(child),
    workflow_run_id: null,
    is_workflow_sub: child.is_workflow_sub || false,
    is_workflow_primary: false,
    workflow_run_status: null,
    workflow_run_kind: null,
    workflow_run_name: null,
    workflow_run_agents_done: null,
    workflow_run_agents_total: null,
    workflow_run_activity: null,
    workflow_run_started_at: null,
    icon: child.icon,
    icon_color: child.icon_color,
    ...(await identityFieldsOf(child, getDoc)),
    team_id: child.team_id ?? null,
    is_private: child.is_private ?? false,
    team_visibility: child.team_visibility ?? null,
    user_id: child.user_id,
  });
}

// Stable inbox ordering shared by the live query (the crawl leaves ordering to
// the client, which re-sorts via sortSessions anyway).
export function sortInboxRows(results: any[]) {
  results.sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    const aNew = a.message_count === 0;
    const bNew = b.message_count === 0;
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
    if (a.is_deferred !== b.is_deferred) return a.is_deferred ? 1 : -1;
    if (a.is_idle) return a.updated_at - b.updated_at;
    return b.started_at - a.started_at;
  });
}
