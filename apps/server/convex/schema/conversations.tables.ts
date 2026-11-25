import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  cloudPlacementProgressValidator,
  localMirrorValidator,
} from "../lib/cloudHostValidators";
import { roleIconValidator } from "../lib/roleIconValidator";
import { conversationFields } from "./conversation-fields.tables";

export const conversationTables = {
  conversations: defineTable({
    ...conversationFields,
    last_message_role: v.optional(
      v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
        v.literal("tool"),
      ),
    ),
    last_message_preview: v.optional(v.string()),
    // Files this session recently edited (absolute paths, newest first, capped).
    // Denormalized at message-write time from Edit/Write/NotebookEdit tool
    // calls (see mergeRecentFiles in messages.ts). Feed/search cards render it
    // so agents and humans can see WHERE a session actually works — including
    // a worktree path that project_path alone would hide.
    recent_files: v.optional(v.array(v.string())),
    // What the session did, counted at message write (messages.ts
    // bumpSessionTallies) as the change between a row's old and new tool
    // results, so a re-synced row counts once: results that came back as
    // errors, and commits it made (a result printing git's new-commit line). Absent for a session that
    // had messages before counting began. Search hits show it.
    session_tallies: v.optional(
      v.object({ failed_tools: v.number(), commits: v.number() }),
    ),
    // What the agent is doing right now: a present tense line from the newest
    // assistant tool call ("editing chat.ts", "running npx tsc"), the raw
    // tool name, and the timestamp of the message that carried the call.
    // Stamped at message ingest (messages.ts deriveActivity) in the same
    // transaction as recent_files; cleared when an active status settles
    // (managedSessions.updateAgentStatus). Rides the liveness overlay
    // (INBOX_FACT_FIELDS) and is churn only for the sync log, so a tool call
    // never re-pushes the session list or contends on the sync head row.
    // Clients show it only while the row is working and the stamp is fresh
    // (shared isSessionActivityFresh).
    activity: v.optional(
      v.object({ text: v.string(), tool: v.string(), at: v.number() }),
    ),
    // The open agent-status check for this conversation (messages.ts
    // nextAgentStatusProbe): one scheduled check per window, with the evidence
    // of every batch in the window folded in. Server bookkeeping, never sent.
    agent_status_probe: v.optional(
      v.object({
        due_at: v.number(),
        at: v.number(),
        has_assistant_message: v.boolean(),
        has_tool_result_reply: v.boolean(),
      }),
    ),
    // Serving URL of the newest image in this conversation (attachment,
    // screenshot, or a trusted markdown image in prose) — the inbox row
    // thumbnail. Denormalized at message-write time (latestImagePreviewUrl);
    // never cleared, so presence also means "this session has images".
    image_preview_url: v.optional(v.string()),
    // When the conversation's whole history was swept into conversation_images
    // (backfillConversationImages). Live ingest materializes every new image, so
    // this only marks that the pre-feature history was caught up. Set = never
    // sweep this conversation again.
    images_backfilled_at: v.optional(v.number()),
    // When every message in this conversation carries its nav_prompt flag
    // (backfillNavPrompts). Until then getUserMessages scans the user-role
    // range; after, it reads the prompt index. Set = never sweep again.
    nav_prompts_indexed_at: v.optional(v.number()),
    // When the running backfillNavPrompts sweep started; a later open does not
    // start a second one unless this is stale. Cleared when the sweep finishes.
    nav_prompts_backfill_started_at: v.optional(v.number()),
    has_pending_messages: v.optional(v.boolean()),
    // True while the conversation's newest message is a transient Claude Code
    // API/auth-error banner (see isApiErrorBanner). Cleared when a real turn
    // supersedes it. Gates the banner-cleanup scan in addMessages so the common
    // (no-error) write path never pays for the extra read.
    pending_api_error: v.optional(v.boolean()),
    // Which banner family parked the session ("auth" | "limit" | "error" |
    // "connection" | "fatal" | "throttle" | "safety" | "context", see
    // classifyApiErrorBanner) — drives the
    // session-card pill label. Set/cleared in lockstep with pending_api_error.
    pending_api_error_kind: v.optional(v.string()),
    // When the block landed — the newest banner message's timestamp. Set and
    // cleared in lockstep with pending_api_error; the web blocked-sessions
    // banner and session rows render "Xm ago" from it.
    pending_api_error_at: v.optional(v.number()),
    // When codecast last restarted this session after its context filled and
    // could not be compacted (handoff.recoverContext). A second overflow
    // inside the cooldown after a brief stays parked for a person.
    context_recovered_at: v.optional(v.number()),
    // The rung that recovery took (handoff.contextRecoveryMode): a "rebuild"
    // that overflows again inside the cooldown falls back to a "brief".
    context_recovery_mode: v.optional(
      v.union(v.literal("rebuild"), v.literal("brief")),
    ),
    // A hosted assistant conversation whose last turn ended on a stop notice:
    // the notice's kind (NOTICE_KINDS in packages/hosted-assistant/src/assistant). Written by
    // assistant/turns.ts tellStopped and cleared when the next turn starts,
    // so the inbox files a failed turn under "Couldn't finish" from the row
    // alone, without its transcript loaded.
    hosted_stop: v.optional(v.string()),
    session_error: v.optional(v.string()),
    active_plan_id: v.optional(v.id("plans")),
    active_task_id: v.optional(v.id("tasks")),
    plan_ids: v.optional(v.array(v.id("plans"))),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    // Set on a row the web created for the cloud host BEFORE a local daemon has
    // prepared the host and acquired its worktree (cloud_spawn). While pending
    // no daemon may deliver into the row: the host would resume a session with
    // no checkout, and a laptop would claim it for itself. Cleared by
    // cloud.placeConversation together with the real start.
    cloud_placement: v.optional(v.literal("pending")),
    // Fresh per park (cloudPlacement.parkOnCloudHost), carried in the
    // cloud_spawn args and cleared by placeConversation / un-park. Fences a
    // late `cast cloud start`: a placement whose token no longer matches is
    // refused, so a row re-pointed at a laptop (or re-parked) cannot be dragged
    // back by a child that was already mid-SSH. A pending row with NO token is
    // one nobody is preparing (an occupancy refusal) and is never re-issued.
    cloud_placement_token: v.optional(v.string()),
    // When the laptop's `cast cloud start` for THIS park failed (the child
    // reports it through cloud.reportPlacementFailure, which ignores a report
    // whose token no longer matches the row). A failed park is not retried on
    // its own: the heartbeat re-issue skips it, so a host that cannot be
    // prepared is not woken again by every laptop that comes online. Cleared
    // by a fresh pick (parkOnCloudHost) and by placeConversation.
    cloud_placement_failed_at: v.optional(v.number()),
    // The failure above was a project context over the cap: the files that
    // would have to stay behind for it to fit (home-relative, largest first).
    // The session banner asks whether to leave them out; the answer re-parks
    // with them as leave_out, which the laptop adds to cloud_mirror_exclude.
    // Cleared with cloud_placement_failed_at.
    cloud_context_too_large: v.optional(
      v.object({
        total_bytes: v.number(),
        cap_bytes: v.number(),
        files: v.array(v.object({ path: v.string(), bytes: v.number() })),
      }),
    ),
    // Where the placement stands while the laptop's child prepares the host:
    // the host, the step and its log lines (packages/cloud-hosts/src/cloudPlacementProgress).
    // Kept after a failure (failed_at) so the strip names the step that broke;
    // cleared by placeConversation and by a fresh park.
    cloud_placement_progress: v.optional(cloudPlacementProgressValidator),
    // A cloud session's working tree mirrored live into a worktree on one of
    // the owner's laptops (`cast remote sync` as a daemon job). The laptop
    // running it writes the state (cloud.reportLocalMirror) on landing and on
    // state change only; the web asks for start and stop (dispatch
    // setLocalMirror). Absent = no mirror.
    local_mirror: v.optional(localMirrorValidator),
    // Where a cloud session runs on the host: its own worktree (absent =
    // isolated) or the host's main checkout (shared). Stamped at create
    // (createQuickSession / dispatch.createSession / the CLI spawn) and by
    // cloud.placeConversation.
    cloud_workspace: v.optional(
      v.union(v.literal("isolated"), v.literal("shared")),
    ),
    // The host main checkout a SHARED row has claimed (cloud.claimSharedCheckout,
    // or the parked insert of `cast spawn --shared`), kept through placement.
    // The occupancy key: one checkout holds one alive shared row
    // (@codecast/cloud-hosts/cloudWorkspace sharedCheckoutOccupant).
    cloud_checkout_path: v.optional(v.string()),
    // The launch choice for an isolated cloud worktree: the preparing laptop's
    // checkout (absent = checkout; its branch, HEAD and uncommitted changes)
    // or a clean origin/main. Rides the cloud_spawn as start_from. A shared
    // row is always origin_main.
    cloud_start_from: v.optional(
      v.union(v.literal("checkout"), v.literal("origin_main")),
    ),
    // What the worktree actually started from, stamped at placement
    // (cloud.placeConversation, spawn.createSessionFromCli, forkFromMessage):
    // source, the full base commit, the laptop branch (absent when detached),
    // whether that tree was dirty, the laptop root, the preparing device and
    // why an automatic downgrade to origin/main happened. Placement-time
    // truth, never patched by the daemon (git_commit_hash is the live field).
    cloud_seed: v.optional(
      v.object({
        source: v.union(v.literal("checkout"), v.literal("origin_main")),
        base: v.string(),
        branch: v.optional(v.string()),
        dirty: v.optional(v.boolean()),
        laptop_root: v.optional(v.string()),
        device_id: v.optional(v.string()),
        reason: v.optional(v.string()),
        tree: v.optional(v.string()),
        at: v.number(),
      }),
    ),
    // A bulk migration (sessionMigrations.ts) is moving this row between
    // machines. Present = FENCED: no daemon may deliver into it (the source is
    // being quiesced and its transcript transferred; the destination does not
    // own it yet), so messages sent meanwhile wait as pending and ride the
    // resume on the destination. Set by sessionMigrations.beginSession and
    // cleared — in the same transaction as the ownership flip — by
    // finishSession / failSession, so a stale fence can only outlive a crashed
    // runner, and the batch's reaper clears those.
    migration: v.optional(
      v.object({
        batch_id: v.string(),
        migration_id: v.id("session_migrations"),
        to_device_id: v.string(),
        started_at: v.number(),
      }),
    ),
    worktree_path: v.optional(v.string()),
    worktree_status: v.optional(
      v.union(v.literal("active"), v.literal("merged"), v.literal("archived")),
    ),
    // The subagent fleet (subagentFleet.ts, packages/agent-clients/src/subagentFleet.ts):
    // a `cast spawn --subagent` row holds a slot ("running") or waits for one
    // ("queued"); absent once the worker ends or for rows the fleet never
    // counted. `subagent_slot_at` orders the queue, `subagent_slot_device` is
    // the machine it counts against, `subagent_caps` the limits it was
    // spawned under, and `subagent_queued_start` the start a queued row runs
    // when a slot frees.
    subagent_slot: v.optional(
      v.union(v.literal("running"), v.literal("queued")),
    ),
    subagent_slot_at: v.optional(v.number()),
    subagent_slot_device: v.optional(v.string()),
    subagent_caps: v.optional(
      v.object({ per_session: v.number(), per_machine: v.number() }),
    ),
    subagent_queued_start: v.optional(v.any()),
    // Bring this isolated worker's changes into its parent's checkout when it
    // finishes done (agent definition merge_back, or cast spawn --merge-back).
    merge_back_on_done: v.optional(v.boolean()),
    // What became of them (MergeBackStatus): the worker row's chip.
    merge_back: v.optional(
      v.object({
        state: v.union(
          v.literal("pending"),
          v.literal("merged"),
          v.literal("empty"),
          v.literal("conflict"),
          v.literal("kept"),
          v.literal("failed"),
        ),
        at: v.number(),
        files: v.optional(v.array(v.string())),
        reason: v.optional(v.string()),
      }),
    ),
    // A rewind of this session's checkout staged by "Rewind to here"
    // (cli/src/rewindTree.ts), as the daemon that holds it reported it: the
    // header's Put back chip in every window reads this. Null once put back
    // or kept.
    rewind_staged: v.optional(
      v.union(
        v.null(),
        v.object({
          id: v.string(),
          files: v.number(),
          staged_at: v.number(),
          at: v.number(),
          device_id: v.optional(v.string()),
        }),
      ),
    ),
    workflow_run_id: v.optional(v.id("workflow_runs")),
    is_workflow_sub: v.optional(v.boolean()),
    is_workflow_primary: v.optional(v.boolean()),
    // The schedule (agent_tasks row) that spawned this conversation as a run.
    // Stamped by the daemon shortly after spawn (agentTasks.linkRunConversation)
    // and backfilled on run completion/failure, so EVERY run — not just the
    // latest — stays attributable to its schedule (panel, badges, provenance).
    agent_task_id: v.optional(v.id("agent_tasks")),
    // Denormalized: is this conversation the home of an armed inject trigger,
    // and of which strength (dormancy.ts ArmedTriggerHomes)? Written by the
    // agent_tasks lifecycle (agentTasks.refreshArmedTriggerKind) so the inbox
    // projection classifies dormancy off the row alone, with no agent_tasks
    // read per execution. Absent = "none". Semantic (not churn), so it rides
    // the sync log.
    armed_trigger_kind: v.optional(
      v.union(v.literal("none"), v.literal("standing"), v.literal("once")),
    ),
    // The pull request this session shepherds, folded for the inbox card and
    // the thread state panel. Single writer: prShepherd.refreshConversationPrStatus.
    // state mirrors pull_requests.shepherd_state.
    // A ship session (ship.ts): the target it lands, as ship_runs.target_key.
    ship_target_key: v.optional(v.string()),
    pr_status: v.optional(
      v.object({
        pr_id: v.id("pull_requests"),
        repository: v.string(),
        number: v.number(),
        title: v.optional(v.string()),
        state: v.string(),
        at: v.number(),
      }),
    ),
    // Harness /loop state, folded from the message stream at ingest (see
    // loopState.ts): the agent scheduled its own wakeup (ScheduleWakeup) or is
    // mid-wakeup-turn. Lets the inbox trigger set treat a self-pacing loop
    // like an armed trigger without reading messages. "stopped" is kept as a
    // tombstone so replayed history can't re-arm a finished loop.
    loop_state: v.optional(
      v.object({
        status: v.union(
          v.literal("armed"),
          v.literal("waking"),
          v.literal("stopped"),
        ),
        wakeup_at: v.number(),
        armed_at: v.number(),
        fired_at: v.optional(v.number()),
        event_at: v.number(),
        reason: v.optional(v.string()),
        prompt: v.optional(v.string()),
      }),
    ),
    // LEGACY: never read (skills live in user_skills; getConversationWithMeta
    // strips this). Declared only so pre-diet rows validate; setAvailableSkills
    // no longer writes it and the doc diet sweep sheds it.
    available_skills: v.optional(v.string()),
    subagent_description: v.optional(v.string()),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    // The session's character (docs/architecture/session-characters.md S1):
    // an avatar key and a short name a person chose. Absent = the stable hash
    // default; a role's standing session ignores both and wears the role.
    character_avatar: v.optional(v.string()),
    character_name: v.optional(v.string()),
    // A plain session's drawn icon (org-staffing.md S13), in the role icon
    // language: drawn from its title when it sits in someone's header pins
    // with characters off. The stamp spaces requests, so a failed drawing is
    // asked for again later rather than on every paint.
    drawn_icon: v.optional(roleIconValidator),
    drawn_icon_requested_at: v.optional(v.number()),
    // Which device currently OWNS (runs) this session. Set by the managing
    // daemon. Absent = legacy/unowned. The single-owner invariant: a daemon
    // only manages sessions whose owner_device_id matches its own device id.
    // "Move to remote" flips this from the local device to the Mac's device.
    owner_device_id: v.optional(v.string()),
    // DENORMALIZED CACHE of the PRIMARY (first-added, still-present) owner. The
    // canonical owner store is the session_owners join table — a session may have
    // SEVERAL owners and this single field cannot express that, so never branch
    // inbox/feed membership on it (use session_owners; see scanInboxConversations).
    // Kept because the row-level UI shows one owner chip and it's a cheap fast
    // path in checkConversationAccess. Maintained in lockstep by the owner
    // mutations. Absent = unowned.
    //
    // An owner is the team member RESPONSIBLE for a session — whose inbox it
    // appears in and who may reply into it — distinct from user_id (the account
    // that RUNS + bills it) and owner_device_id (the DEVICE its daemon runs on).
    // These three axes move independently: reassigning owners never moves the
    // device, and reparenting the device never changes the owners.
    owner_user_id: v.optional(v.id("users")),
    // Tombstone forwarding: the id of a DELETED conversation this row replaced
    // when a kill/restart restored its session (resolveRestartTarget). Lets
    // resolveConversation heal stale links/cards that still point at the dead
    // id. A plain string — the referenced row no longer exists.
    restored_from_conversation_id: v.optional(v.string()),
    // ── Anchor / persistent-session support ──────────────────────────────────
    // `persistent` exempts a conversation from auto-completion so a standing
    // agent member can sit dormant indefinitely and be re-woken by an event. The
    // guard lives in markSessionCompleted (covers the watchdog, SessionEnd hook,
    // daemon kill teardown) plus matching checks in the direct-patch kill paths
    // (killSession + dispatch dismiss→kill). It is flipped to "completed" only by
    // decommissionAnchor, which clears `persistent` first.
    persistent: v.optional(v.boolean()),
    // The IDENTITY a session renders as. When set (to a synthetic is_bot user),
    // the author chip / feed show the bot, while `user_id` stays the human host
    // that actually runs and bills the session. Absent = render as user_id.
    acting_user_id: v.optional(v.id("users")),
    // The ORIGINAL human author, pinned the first time a session is reparented
    // ACROSS accounts (reparentSessionToDevice). Author is immutable, but
    // account-follows-device rewrites user_id when a session moves to another
    // user's machine — so before that overwrite we stamp the pre-move user_id
    // here, and resolveInitiatorRef prefers it. Absent = author is still user_id
    // (never reparented across accounts). Distinct from acting_user_id (rendered
    // identity) and owner_user_id (inbox responsibility).
    author_user_id: v.optional(v.id("users")),
    // Back-link to the owning anchors row when this conversation IS an anchor's
    // standing session (vs an ephemeral hand it spawned).
    anchor_id: v.optional(v.id("anchors")),
    // The org role this session reports to (docs/architecture/org-roles.md
    // S1). Written only by orgRoles.reparentSession / retire; absent = the
    // session files under its primary owner in the org tree. Owners are
    // untouched by it — the role sits between the session and the person.
    org_role_id: v.optional(v.id("org_roles")),
    // Why the role holds it (org-staffing.md S35): `bound`, the rule moved it
    // for the task or plan it is bound to, so a binding may move it again;
    // `filed`, a person or role put it there, so only a person or role moves
    // it. Absent on rows from before the stamp: read as filed, and
    // `migrations:releaseFolderHeldSessions` sorts them by the org log.
    org_role_hold: v.optional(v.union(v.literal("bound"), v.literal("filed"))),
    // RETIRED (org-staffing.md S28): the escalation stamp `cast escalate` wrote.
    // Nothing reads or writes it. It stays in the schema only until
    // `migrations:clearEscalationStamps` has run in prod (rows still carry it,
    // and Convex refuses a schema the rows do not fit); drop it after.
    escalated_by_role: v.optional(
      v.object({
        role_id: v.id("org_roles"),
        line: v.string(),
        at: v.number(),
        direct: v.optional(v.boolean()),
      }),
    ),
    // Set when this row IS a role's standing session (org-roles-standing.md
    // T1), the way anchor_id marks the workspace anchor's. Reserved for the
    // provisioning wave; nothing writes it in the org page slice.
    standing_role_id: v.optional(v.id("org_roles")),
    // paneRecovery.ts: when this unattended seat last restarted itself
    // because its terminal refused a message, and when a refusal after that
    // restart marked its session_error (cleared on the next delivery).
    pane_recovered_at: v.optional(v.number()),
    pane_refused_at: v.optional(v.number()),
    // The task this session was started to review (the-line.md L3). Stamped
    // by the spawn route when the line starts its review station; such a
    // session is never a hand of the task's role, so its approve is the
    // outside verdict the independence rule needs.
    review_of_task_id: v.optional(v.id("tasks")),
    // Claude token usage rolled up from messages.usage at insert time
    // (org-roles-standing.md T4). Absent on backends that report no usage;
    // the role page counts those sessions as "tokens not counted".
    usage_totals: v.optional(
      v.object({
        input: v.number(),
        output: v.number(),
        cache_read: v.number(),
        cache_write: v.number(),
        updated_at: v.number(),
        // Input + cache read + cache write of the latest counted call: the context
        // the session's next call carries, and so what waking it costs (wakeCost.ts).
        context_tokens: v.optional(v.number()),
        // The Claude message id last counted, so a turn split across two sync
        // batches counts once (messages.rollUpUsage).
        last_api_message_id: v.optional(v.string()),
        // Cost-weighted tokens billed inside ONE calibration slot, and which slot
        // that is. The usage calibration needs tokens spent in a period, and every
        // other field here is a lifetime total; a slot-stamped bucket gives the
        // period figure without a second write or a second table. Reset by
        // rollUpUsage the first time a conversation bills into a new slot.
        slot: v.optional(v.number()),
        slot_weighted: v.optional(v.number()),
      }),
    ),
    // Durable execution fencing is opt-in during the mixed-version rollout.
    // Absence means the conversation is still served by the legacy daemon rail.
    // `legacy-quiescing` closes every legacy claim/status endpoint while the
    // owning supervisor proves the exact old daemon boot has stopped. `fenced`
    // means execution_bindings + delivery_attempts are the only authority.
    execution_protocol_state: v.optional(
      v.union(v.literal("legacy-quiescing"), v.literal("fenced")),
    ),
    execution_protocol_version: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_updated", ["user_id", "updated_at"])
    // Sparse in practice (only banner-parked conversations are true) — lets the
    // stale-flag sweep find expired pending_api_error rows without a table scan.
    .index("by_pending_api_error", ["pending_api_error", "updated_at"])
    // One person's parked conversations (accountSwitch listBlockedConversations):
    // reading them through by_user_updated took every busy session along, and
    // the scheduled checks lost every commit to those sessions' writes.
    .index("by_user_pending_api_error", [
      "user_id",
      "pending_api_error",
      "updated_at",
    ])
    // started_at last: a folder's rows come newest session first, not newest
    // row first. A folder's past sessions synced today get new rows, and the
    // Sync page's list must still open on the sessions run most recently.
    .index("by_user_git_root", ["user_id", "git_root", "started_at"])
    .index("by_user_git_remote_url", ["user_id", "git_remote_url"])
    .index("by_user_project_path", ["user_id", "project_path", "started_at"])
    .index("by_project_id", ["project_id", "updated_at"])
    .index("by_user_favorite", ["user_id", "is_favorite"])
    .index("by_user_private", ["user_id", "is_private"])
    .index("by_team_id", ["team_id"])
    .index("by_team_user_updated", ["team_id", "user_id", "updated_at"])
    // A member's ACTIVE rows in the window (the org scan, collectOrgSessions).
    // Filtering status on by_team_user_updated still read every completed row:
    // one Union member's 30 days held 16,009 rows, 12,214 of them completed
    // workflow children, 60 MB of a 100 MB read limit (2026-10-27).
    .index("by_team_user_status_updated", [
      "team_id",
      "user_id",
      "status",
      "updated_at",
    ])
    .index("by_user_status_updated", ["user_id", "status", "updated_at"])
    // (Removed: by_owner_updated. The owner's inbox merge and feed --mine now
    // read the canonical owner SET from session_owners — a single owner_user_id
    // can't express multiple owners. It was also not free: Convex indexes every
    // document (a missing optional field indexes as undefined), so with
    // updated_at as the second key EVERY conversation heartbeat rewrote an entry
    // in it. Nothing reads it anymore.)
    .index("by_share_token", ["share_token"])
    .index("by_session_id", ["session_id"])
    .index("by_short_id", ["short_id"])
    .index("by_forked_from", ["forked_from"])
    .index("by_git_branch", ["git_branch"])
    .index("by_parent_conversation_id", ["parent_conversation_id"])
    // Sparse and STATIC key (spawned_by never changes after creation, so no
    // write amplification — the cost that killed by_user_updated_at above).
    // Powers the hide cascade: killing/stashing a team lead must find its
    // teammates (spawned_by + agent_team_name), which by_parent_conversation_id
    // can't see. See cascadeHideToNestedChildren (cleanup.ts).
    .index("by_spawned_by", ["spawned_by_conversation_id"])
    .index("by_handed_off_from", ["handed_off_from_conversation_id"])
    .index("by_user_pinned", ["user_id", "inbox_pinned_at"])
    // The adopted window (scanInboxConversations): nested rows the person
    // talked to, newest adoption first.
    .index("by_user_adopted", ["user_id", "inbox_adopted_at"])
    .index("by_user_stashed", ["user_id", "inbox_stashed_at"])
    .index("by_user_live_snoozed", [
      "user_id",
      "is_subagent",
      "inbox_killed_at",
      "inbox_snoozed_until",
    ])
    // Inbox scan indexes (scanInboxConversations): exclude subagent / killed
    // rows at the index so the scan never reads docs the inbox filter drops.
    // The recent window reads PLAIN rows only: the four filing stamps are
    // pinned to absent ahead of updated_at, so a stashed agent's fresh
    // heartbeats cannot take a recent seat from a settled plain row (the
    // shared rule: inboxProjection isFiled). The subagent window reads the
    // same index — a parked parent's children carry its stamp (the hide
    // cascade) and every caller discards them.
    .index("by_user_plain_updated", [
      "user_id",
      "is_subagent",
      "inbox_pinned_at",
      "inbox_dismissed_at",
      "inbox_stashed_at",
      "inbox_snoozed_until",
      "updated_at",
    ])
    .index("by_user_live_dismissed", [
      "user_id",
      "is_subagent",
      "inbox_killed_at",
      "inbox_dismissed_at",
    ])
    .index("by_user_live_stashed", [
      "user_id",
      "is_subagent",
      "inbox_killed_at",
      "inbox_stashed_at",
    ])
    .index("by_user_profile_pinned", ["user_id", "profile_pinned_at"])
    .index("by_user_dismissed", ["user_id", "inbox_dismissed_at"])
    // The Killed shelf (listKilledSessions): a user's kills newest-first, paged
    // on demand — the inbox scan excludes killed rows, so this is their one
    // server channel.
    .index("by_user_killed", ["user_id", "inbox_killed_at"])
    // The Closed shelf's closes (listClosedSessions), newest-first.
    .index("by_user_closed", ["user_id", "inbox_closed_at"])
    .index("by_owner_device", ["user_id", "owner_device_id"])
    // A device's live rows (cloud.hostSessions): a host that has run thousands
    // of stations reads only the ones still active, not its whole history.
    .index("by_owner_device_status", ["user_id", "owner_device_id", "status"])
    // The rows that can hold a host's checkout as shared (cloudPlacement
    // findSharedCheckoutOccupant): a start reads these, not every station the
    // host runs, so a station's transcript writes never conflict with a spawn.
    .index("by_owner_device_workspace", [
      "user_id",
      "owner_device_id",
      "cloud_workspace",
    ])
    // Sparse: rows parked on a cloud host for a laptop to prepare
    // (cloudPlacement reissueStrandedCloudSpawns). A laptop's catch-up reads
    // these, not every station its hosts run, so it commits against their
    // transcript writes instead of retrying forever in a scheduler slot.
    .index("by_user_cloud_placement", [
      "user_id",
      "cloud_placement",
      "owner_device_id",
    ])
    // Sparse and written only at a worker's start, queue and end: the fleet's
    // running and queued rows for one user (subagentFleet.ts).
    .index("by_user_subagent_slot", [
      "user_id",
      "subagent_slot",
      "subagent_slot_at",
    ])
    .index("by_restored_from", ["restored_from_conversation_id"])
    // `persistent` and `anchor_id` are plain fields with no index: anchors
    // resolve their conversation via anchors.conversation_id, and no query
    // scans conversations by either field. Indexes on written-to tables are
    // not free (each one adds rows to the backing `indexes` table and
    // tombstone cost on every delete) — don't add indexes speculatively.
    // Sparse: only spawned schedule runs carry agent_task_id. Powers the run
    // history strip (agentTasks.webListRuns) — every run of one schedule.
    .index("by_agent_task", ["agent_task_id"])
    // Sparse: only sessions filed under an org role carry org_role_id. Powers
    // retire's "clear every session under this role" sweep (orgRoles.retire).
    .index("by_org_role", ["org_role_id"])
    // Sparse: the one row that IS a role's standing session (T1).
    .index("by_standing_role", ["standing_role_id"])
    .searchIndex("search_title_v2", {
      searchField: "title",
      filterFields: ["user_id"],
    })
    // Summaries are searched alongside titles (searchConversations): subtitle is
    // the generated multi-line session summary, idle_summary the one-line blurb.
    .searchIndex("search_subtitle", {
      searchField: "subtitle",
      filterFields: ["user_id"],
    })
    .searchIndex("search_idle_summary", {
      searchField: "idle_summary",
      filterFields: ["user_id"],
    }),
};
