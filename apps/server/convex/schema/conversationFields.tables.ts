import { v } from "convex/values";

export const conversationFields = {
  user_id: v.id("users"),
  // Created for a session that started more than HISTORY_IMPORT_INBOX_MS
  // before it was uploaded (a newly linked machine's history): the inbox
  // shows it only while its activity is that recent (isStaleHistoryImport).
  history_import: v.optional(v.boolean()),
  team_id: v.optional(v.id("teams")),
  agent_type: v.union(
    v.literal("claude_code"),
    v.literal("codex"),
    v.literal("cursor"),
    v.literal("gemini"),
    v.literal("cowork"),
    // Widened ahead of their clients (plan phases 1-2) so rows can store them
    // before descriptors exist; see shared ConvexAgentType.
    v.literal("opencode"),
    v.literal("pi"),
    v.literal("grok"),
    v.literal("muse"),
    v.literal("antigravity"),
    // The hosted assistant (plan pl-840): Convex actions run its turns and
    // no device ever claims the row (convex/assistant).
    v.literal("codecast"),
  ),
  session_id: v.string(),
  slug: v.optional(v.string()),
  title: v.optional(v.string()),
  subtitle: v.optional(v.string()),
  // One- or two-word NAME for the session ("Broker render"), generated with
  // the title. Reference pills show it on repeat mentions so prose that
  // names a session four times does not read as four titles. Follows the
  // title's lifecycle: rewritten on every title pass, cleared for none.
  short_title: v.optional(v.string()),
  title_embedding: v.optional(v.array(v.float64())),
  project_hash: v.optional(v.string()),
  project_path: v.optional(v.string()),
  // The named project this session works in, set only where a person or the
  // project decided it (the composer's pick, a move, a project's default
  // session). Workers, spawns and task-bound sessions derive theirs at read
  // time (packages/sessions/src/sessionProject); never copy it onto a child.
  project_id: v.optional(v.id("projects")),
  model: v.optional(v.string()),
  // Last-known effort level (low|medium|high|max), same lifecycle as `model`:
  // stamped optimistically by the web picker / at create, confirmed by the
  // rollup parsing "Set effort level to X" / "with X effort" switch echoes.
  effort: v.optional(v.string()),
  // Saved Claude account profile this session launches on (its setup-token
  // is sourced into the launch env, see cli/ccAccounts.ts). Stamped at
  // create; the daemon re-reads it on every resume so a restart never
  // silently falls back to the machine's keychain login.
  cc_account: v.optional(v.string()),
  // True when the machine chose `cc_account` (the account its sessions ran
  // on at launch or at a switch), absent when a person named it
  // (`--account`). An automatic pin follows the machine's account on the
  // next resume (resumePinFor); a chosen one never moves.
  cc_account_auto: v.optional(v.boolean()),
  // Set when recovery moved this session ALONE onto an account with room on
  // the model whose week parked it ("Fable limit") while the fleet runs
  // another model (lib/modelLimitPins.ts). A resume keeps that pin while
  // `cc_account` still names `profile` and the account proves room on
  // `family` (resumePinFor). `tried`: the accounts it was pinned to for
  // `family`, never picked again for it within a week.
  cc_account_model_pin: v.optional(
    v.object({
      family: v.string(),
      profile: v.string(),
      at: v.number(),
      tried: v.optional(
        v.array(v.object({ profile: v.string(), at: v.number() })),
      ),
    }),
  ),
  // The Codex account profile this session's PROCESS is running on, recorded
  // by the daemon that launched it. Not a pin like cc_account: Codex reads
  // ~/.codex/auth.json once at start and holds that grant for life, so a
  // machine that has since signed into another account leaves this session
  // spending the old one. Compared against the device's current login to name
  // exactly the panes a switch left behind (ct-49528).
  codex_account: v.optional(v.string()),
  started_at: v.number(),
  updated_at: v.number(),
  message_count: v.number(),
  // Monotonic server watermark for material transcript changes. Unlike
  // message_count it advances for inserts AND same-UUID patches, so clients
  // can recover a streaming message that finalized while their subscription
  // was stalled.
  transcript_revision: v.optional(v.number()),
  is_private: v.boolean(),
  team_visibility: v.optional(
    v.union(v.literal("summary"), v.literal("full"), v.literal("private")),
  ),
  status: v.union(v.literal("active"), v.literal("completed")),
  share_token: v.optional(v.string()),
  // The owner lets anonymous viewers of the share link suggest messages
  // (guestSuggestions.ts). Each one waits for the owner to send it.
  guest_suggestions: v.optional(v.boolean()),
  // Unread: kept only because older rows carry it. A teammate's message
  // always waits as a suggestion while an owner is attending (teamSuggestions.ts).
  team_suggestions: v.optional(v.boolean()),
  parent_message_uuid: v.optional(v.string()),
  parent_conversation_id: v.optional(v.id("conversations")),
  // A cloud agent session whose agent is archived on the provider's site
  // (Codex Cloud): the header offers Unarchive instead of Archive.
  cloud_agent_archived: v.optional(v.boolean()),
  git_commit_hash: v.optional(v.string()),
  git_branch: v.optional(v.string()),
  git_remote_url: v.optional(v.string()),
  // LEGACY: now written to conversation_git_diffs.git_status (off the hot
  // doc). Still declared so pre-diet rows validate; unread everywhere.
  git_status: v.optional(v.string()),
  git_root: v.optional(v.string()),
  // The checkout's live git state, refreshed by the daemon's git plane sweep
  // (conversations.updateGitState) so the header can read like a shell
  // prompt: git_commit_hash and git_branch above move with HEAD, and these
  // say how far the branch is from its upstream and whether the tree is
  // dirty. Small scalars on purpose: the diff itself stays off the hot doc.
  git_ahead: v.optional(v.number()),
  git_behind: v.optional(v.number()),
  git_dirty: v.optional(v.boolean()),
  git_state_at: v.optional(v.number()),
  fork_count: v.optional(v.number()),
  forked_from: v.optional(v.id("conversations")),
  // Fork-copy progress (set on the fork target, not the source). The fork
  // mutation chain reads/writes these to copy >8192-message conversations
  // across multiple transactions without hitting Convex's per-mutation write
  // limit. Absence means "not a fork in progress".
  //   - fork_status: "copying" while batches are being copied; "complete"
  //     once finalized; "failed" if a watchdog marks it.
  //   - fork_copy_total: messages we expect to copy.
  //   - fork_copied: messages copied so far (kept in sync with message_count).
  //   - fork_copy_cursor: timestamp of the last message copied; the next
  //     batch reads messages where timestamp > this cursor.
  //   - fork_cutoff_timestamp: upper bound for partial forks (forked at a
  //     specific message). Absent = full copy.
  //   - fork_daemon_args: JSON args for the daemon_commands row to insert
  //     once copy completes; kept here so the daemon can't race a half-copied
  //     fork.
  fork_status: v.optional(
    v.union(v.literal("copying"), v.literal("complete"), v.literal("failed")),
  ),
  fork_copy_total: v.optional(v.number()),
  fork_copied: v.optional(v.number()),
  fork_copy_cursor: v.optional(v.number()),
  fork_cutoff_timestamp: v.optional(v.number()),
  fork_daemon_args: v.optional(v.string()),
  // Comment-thread agent reply: this conversation is a hidden fork spawned to
  // answer in a teammate comment thread. It points back at the parent
  // conversation, the anchored message (if any), and the placeholder comment to
  // mirror the reply into; comment_fork_prompt_at separates the agent's new
  // reply from the copied parent history (any assistant message newer than it
  // is the reply). Hidden from the feed via is_subagent.
  comment_fork_parent: v.optional(v.id("conversations")),
  comment_fork_message_id: v.optional(v.string()),
  comment_fork_comment_id: v.optional(
    v.union(v.id("comments"), v.id("review_comments")),
  ),
  comment_fork_prompt_at: v.optional(v.number()),
  // Denormalized comment signal for the inbox card, recomputed by
  // comments.refreshCommentSignal on every comment create/resolve/delete.
  // Count of OPEN threads plus who spoke last in them and what they said —
  // enough for the session row to show "Alice: typo in step 2" with no extra
  // query on the list render path. author_id is a users id string, or
  // "agent" for agent replies, so the client can mute the chip when the
  // viewer themselves commented last.
  unresolved_comment_count: v.optional(v.number()),
  last_comment_at: v.optional(v.number()),
  last_comment_author: v.optional(v.string()),
  last_comment_author_id: v.optional(v.string()),
  last_comment_excerpt: v.optional(v.string()),
  // Visible-child pointer: the session that spawned this one (agent-team
  // teammate → its lead, `cast spawn` → its caller). Unlike
  // parent_conversation_id — whose mere presence marks a row as a subagent
  // and nests/hides it from the inbox — this field only labels and links:
  // the child stays a first-class inbox card with a click-through to its
  // parent. Set by conversations.linkSpawnedBy (daemon-resolved).
  spawned_by_conversation_id: v.optional(v.id("conversations")),
  // Handoff link (`cast handoff --to <agent>`, handoff.start): the session
  // this one continues, and the session that continues this one. Both are
  // labels and click-throughs only: the child stays a first-class inbox
  // card and usually also carries spawned_by. Written together in one
  // mutation (spawn.createSessionFromCli with handoff_from_session) so the
  // pair never disagrees. by_handed_off_from is the reverse lookup for a
  // source whose forward pointer is missing (an older row, a failed patch).
  handed_off_from_conversation_id: v.optional(v.id("conversations")),
  handed_off_to_conversation_id: v.optional(v.id("conversations")),
  // Agent-team identity, from the teamName/agentName stamps Claude Code
  // writes on every teammate JSONL line (the lead's transcript is never
  // stamped; linkSpawnedBy stamps the lead as "team-lead" when it links a
  // worker). Lets the client resolve a teammate name in a transcript to the
  // sibling session that carries it.
  agent_team_name: v.optional(v.string()),
  agent_name: v.optional(v.string()),
  is_favorite: v.optional(v.boolean()),
  short_id: v.optional(v.string()),
  auto_shared: v.optional(v.boolean()),
  skip_title_generation: v.optional(v.boolean()),
  // Last time generateTitle was scheduled for this conversation — floors the
  // re-scheduling rate (see titleGeneration.maybeScheduleTitleGeneration).
  title_gen_scheduled_at: v.optional(v.number()),
  title_is_custom: v.optional(v.boolean()),
  // What the session was when it began and what it has been called since,
  // for search: a long session drifts ("K-pop music video" becomes "Warmintro
  // landing site") and the person looking for it remembers the start.
  // first_prompt is the opening of the first prompt a person or a brief
  // wrote (messages.ts stamps it once, firstPromptOf picks it);
  // earlier_titles are the titles a generated title replaced
  // (searchCore.earlierTitlesAfter, bounded). Neither is indexed: the message
  // index finds the session, these decide how it ranks and what the row shows.
  first_prompt: v.optional(v.string()),
  earlier_titles: v.optional(v.array(v.string())),
  // What the title was before a role's seat renamed the thread after the
  // role (org-staffing.md S16); unseating with the session kept restores it.
  seat_previous: v.optional(
    v.object({
      title: v.optional(v.string()),
      title_is_custom: v.optional(v.boolean()),
    }),
  ),
  idle_summary: v.optional(v.string()),
  // The pinned thread state: a short standing answer to "where does this
  // thread stand right now?", written and kept current by the agent itself
  // (`cast state "…"`, cleared with `cast state clear`). Unlike idle_summary —
  // an AI-generated blurb about what the session was about — this is a live
  // status the agent owns and revises as the work moves, so the human can open
  // a noisy thread and know the situation without reading the backscroll.
  // Rendered pinned above the composer and truncated on the inbox card.
  thread_state: v.optional(v.string()),
  thread_state_at: v.optional(v.number()),
  // message_count when the state was written. The gap against the live count
  // is the honest staleness signal the UI shows ("12 messages since"), and the
  // only defence against a stale state reading as current.
  thread_state_msg_count: v.optional(v.number()),
  // Declared tri-state of the work ("working" | "blocked" | "done"), written
  // with the text. Drives the status chip on the panel and the row tint on
  // the inbox card; absent on rows written before it existed.
  thread_state_status: v.optional(v.string()),
  // The pin's json block, whole: what a workflow station reports for its
  // edges to route on (cast state; the text above is capped for display).
  // It is the run's input, not a claim on anyone's attention, so a person's
  // message takes the pin down and leaves the report and its time standing.
  thread_state_result: v.optional(v.string()),
  thread_state_result_at: v.optional(v.number()),
  // The page an agent offered as a pane (`cast browser pane <url>`). One
  // latest offer, never a list: an agent that started three dev servers is
  // telling the reader about the newest, and a queue of dead addresses reads
  // worse than the freshest answer. `opened_at` is set the moment the reader
  // opens or dismisses the chip, which is what keeps a handled offer handled
  // on every other device.
  browser_pane_offer: v.optional(
    v.object({
      url: v.string(),
      title: v.optional(v.string()),
      offered_at: v.number(),
      opened_at: v.optional(v.number()),
    }),
  ),
  // The folder this session needs, live while the owner's machine fetches it
  // from another of theirs (peerTransfers.ts); removed once it arrives.
  peer_transfer: v.optional(
    v.object({
      phase: v.union(
        v.literal("asking"),
        v.literal("receiving"),
        v.literal("unpacking"),
        v.literal("done"),
        v.literal("failed"),
      ),
      from: v.optional(v.string()),
      mode: v.optional(v.union(v.literal("direct"), v.literal("relay"))),
      bytes: v.optional(v.number()),
      total: v.optional(v.number()),
      reason: v.optional(v.string()),
      started_at: v.number(),
      updated_at: v.number(),
      cancel_requested_at: v.optional(v.number()),
    }),
  ),
  // Dedupe for the needs-input push: "<message_count>:<kind>" of the last
  // waiting episode already notified (see notifications.checkNeedsInput).
  // Mirrors the web idle-sound's notified-keys map so one episode pushes
  // once but each new turn can push again.
  needs_input_notified_key: v.optional(v.string()),
  // The settle episode that last woke whoever this session reports to: a
  // hand's role (org-roles-standing.md T3), or a spawned worker's parent
  // (workerSettle.ts), so one settle tells once, not once per check.
  hand_wake_notified_key: v.optional(v.string()),
  // When a spawned worker last `cast send`-ed its parent, cleared by any new
  // input to the worker. A worker that reported its own result does not also
  // get a settle wake sent on its behalf (workerSettle.ts).
  reported_to_parent_at: v.optional(v.number()),
  // Absolute flag: a truthy value means dismissed until a user action clears
  // it. Never compare against `updated_at` — dozens of mutations bump that
  // field and a relative check re-opens the session. Set by:
  // dismissFromInbox, linkSessions*, linkPlanHandoff (auto-dismiss parent),
  // killSession-adjacent paths. Cleared only by: dispatch.sendMessage,
  // pendingMessages.create, inboxStore.restoreSession, adminUnlinkSession.
  // The list predicates live in inboxFilters.ts. Dismiss also KILLS the
  // agent (dispatch.applyPatches enqueues kill_session on the transition).
  inbox_dismissed_at: v.optional(v.number()),
  // Stash = set aside WITHOUT killing: hides the session from the active inbox
  // buckets into the "Stashed" group (above Dismissed) while the agent keeps
  // running. Same absolute-flag semantics as inbox_dismissed_at (cleared by
  // any send — human or a trigger wake — or an explicit restore, see
  // enqueuePendingMessage); unlike dismiss it never triggers a kill. A
  // dismiss clears it (the row moves to Dismissed).
  inbox_stashed_at: v.optional(v.number()),
  inbox_snoozed_until: v.optional(v.number()),
  // "Stash and hide": the stash survives machine wakes. A trigger firing into
  // a plain stash pulls the row back into the inbox ("something happened,
  // show me"); into a hidden stash it keeps working out of sight. Asks still
  // surface both (blocked declaration, --needs-attention, a stall). Honored
  // only while inbox_stashed_at is set — every stash write sets it (true or
  // cleared), so a clear of the stamp needs no companion clear here.
  inbox_stash_hidden: v.optional(v.boolean()),
  inbox_killed_at: v.optional(v.number()),
  // A Close (web/phone): equal to the inbox_dismissed_at it stamped while the
  // row stays closed (shared isClosedSession). Never cleared: an un-hide clears
  // the dismissed stamp, which ends the equality.
  inbox_closed_at: v.optional(v.number()),
  pending_kill_generation: v.optional(v.number()),
  inbox_deferred_at: v.optional(v.number()),
  // The user's own rest verdict — where they filed the row (Needs You,
  // Done or Dormant) by gesture or by dragging it into that section. A stamp
  // that any later activity silently expires — honored only while
  // inbox_rest_at >= updated_at (see inboxFilters.userRestOf), the same
  // contract as inbox_deferred_at. Never cleared by hand; a wake, a message,
  // or a new turn bumps updated_at past it and the row moves on.
  inbox_rest: v.optional(
    v.union(v.literal("needs_input"), v.literal("done"), v.literal("dormant")),
  ),
  inbox_rest_at: v.optional(v.number()),
  // Legacy dormant-only stamp from before inbox_rest; userRestOf still reads
  // it so rows parked then keep their verdict. Nothing writes it any more.
  inbox_dormant_at: v.optional(v.number()),
  inbox_pinned_at: v.optional(v.number()),
  // The person talked to this NESTED session (a flow station opened from its
  // decision, or a message they sent into it), so it stands alone in their
  // inbox instead of riding a parent they never see (inboxProjection
  // isAdoptedChild). Only nested rows carry it. Read by the adopted window.
  inbox_adopted_at: v.optional(v.number()),
  // The settle classifier's verdict for the settle it last inspected: "done"
  // (delivered, no ask present) or "needs_input" — never "dormant", which
  // needs a wake the system can verify. Written by idleSummary alongside idle_summary, from the
  // same model call over the same transcript tail, so the two can never
  // describe different turns. Honored only while settle_verdict_at >=
  // updated_at (inboxFilters.isSettleVerdictCurrent) and only when the agent
  // made no declaration of its own — a declaration (agent_status dormant /
  // done) always outranks the classifier.
  settle_verdict: v.optional(v.string()),
  settle_verdict_at: v.optional(v.number()),
  // Distinct from inbox_pinned_at: this is the PUBLIC-profile pin. Setting it
  // is the consent act that makes a session world-visible (the mutation also
  // guarantees a share_token, so the card deep-links to the existing /share
  // guest viewer). Timestamp = curation order, GitHub-pinned-repos style.
  profile_pinned_at: v.optional(v.number()),
  draft_message: v.optional(v.string()),
  last_user_message_at: v.optional(v.number()),
  // Who started the latest turn: a person's own send ("person") or a
  // machine-delivered one (a wake, a session message, a program's send).
  // Written by messages.ts through lib/userSend.turnOpener; tool results and
  // noise leave it alone. A standing session's turn a person started files
  // in the inbox like any session's (inboxProjection placeInboxRow).
  last_turn_origin: v.optional(
    v.union(v.literal("person"), v.literal("machine")),
  ),
  // The person whose send started that turn, set only while last_turn_origin
  // is "person" (lib/userSend.turnOpenerPatch). A brief the session writes
  // while working on it is theirs (actingPersonOf), not its runner's.
  last_turn_by: v.optional(v.id("users")),
  is_subagent: v.optional(v.boolean()),
  // Started with nobody watching (`cast spawn --unattended`, a role's hand).
  // Read through isUnattendedConversation (@codecast/sessions/unattended), which also
  // counts workers, workflow stations, trigger runs and standing sessions.
  unattended: v.optional(v.boolean()),
  cli_flags: v.optional(v.string()),
  // LEGACY: now written to conversation_context.stable_context (off the hot
  // doc). Still declared so pre-diet rows validate; readers fall back to it
  // until the doc diet sweep moves it.
  stable_context: v.optional(v.string()),
};
