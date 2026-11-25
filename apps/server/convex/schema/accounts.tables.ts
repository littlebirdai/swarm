import { defineTable } from "convex/server";
import { v } from "convex/values";
import { cloudSessionSyncFields } from "../deviceSettingsShared";

export const accountTables = {
  users: defineTable({
    email: v.optional(v.string()),
    // Extra known addresses for assignee/name resolution only — never auth.
    // Auth identity and cross-provider dedupe key on `email` alone (auth.ts).
    alternate_emails: v.optional(v.array(v.string())),
    emailVerificationTime: v.optional(v.number()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    // Legacy mirror of the user's role in their first team (team creation
    // writes "admin"). It grants nothing outside that team; platform-wide
    // operator access is `staff`.
    role: v.optional(v.union(v.literal("member"), v.literal("admin"))),
    // Codecast operator: reads every user's daemon logs, sends daemon
    // commands, sets system config. Granted only by migrations:setStaff.
    staff: v.optional(v.boolean()),
    // Agent (non-human) account. Two flavors: a synthetic anchor identity (no
    // login; gives a standing agent member its own name/avatar in author chips
    // while a human host runs and bills the session — see anchors), or a full
    // agent member account like Mr Bot (own login + daemon). Either way no
    // human reads this account's inbox, so bots can never HOLD session
    // ownership: performSessionSend skips auto-own for bot senders (and
    // never claims a session a person started) and performSetSessionOwner
    // refuses a bot as the owner value (bots may still CALL it to park
    // sessions on humans).
    is_bot: v.optional(v.boolean()),
    // "anchor" is an anchor's synthetic identity. "slack" is the bridge identity
    // a Slack workspace speaks through when a Slack person has no codecast
    // account (slackSync): one per installation, named after the workspace, and
    // every line it authors carries an `external_author` snapshot of the real
    // Slack person so the UI renders them, not the bridge.
    bot_kind: v.optional(
      v.union(v.literal("anchor"), v.literal("slack"), v.literal("role")),
    ),
    active_team_id: v.optional(v.id("teams")),
    daemon_last_seen: v.optional(v.number()),
    last_message_sent_at: v.optional(v.number()),
    prev_message_sent_at: v.optional(v.number()),
    work_cluster_started_at: v.optional(v.number()),
    theme: v.optional(v.union(v.literal("dark"), v.literal("light"))),
    github_id: v.optional(v.string()),
    github_username: v.optional(v.string()),
    github_avatar_url: v.optional(v.string()),
    github_access_token: v.optional(v.string()),
    push_token: v.optional(v.string()),
    // PushKit VoIP token (hex device token, iOS only). Rings the phone through
    // CallKit even when the app is killed; sent DIRECTLY to APNs (the Expo push
    // service has no VoIP channel). Cleared when APNs reports it unregistered.
    voip_push_token: v.optional(v.string()),
    notifications_enabled: v.optional(v.boolean()),
    // Opt-in: widen push presence from "active in Codecast" to "active anywhere
    // on this Mac". Off, only the web/Electron client reports presence, so
    // working in an editor with no Codecast window reads as away and the phone
    // buzzes. On, the daemon's machine-wide input idle also counts as present
    // (devices.last_input_at), so pushes hold until you leave the computer.
    // Read in pushRouter.readPresence.
    machine_wide_presence: v.optional(v.boolean()),
    // Codecast-owned default model per agent client (client id → shared-contract
    // option key, e.g. { claude: "fable" }). enqueueStartSession applies it when
    // a launch carries no explicit per-session model, so every managed session
    // launches with an explicit model flag and the agent's own saved default —
    // a file any /model one-shot can rewrite — never decides. Set from the
    // model picker's "Set as default"; validated against findModelOption.
    default_models: v.optional(v.record(v.string(), v.string())),
    // The agent clients this user's pickers show (registry ids). Absent means
    // the registry default (pinnedAgentIds in agent-clients/src/agentClients).
    pinned_agents: v.optional(v.array(v.string())),
    // The registry ids pinned_agents was chosen from, written with it. A client
    // missing here was added later and follows its own default.
    pinned_agents_known: v.optional(v.array(v.string())),
    notification_preferences: v.optional(
      v.object({
        team_session_start: v.boolean(),
        mention: v.boolean(),
        permission_request: v.boolean(),
        session_idle: v.optional(v.boolean()),
        session_error: v.optional(v.boolean()),
        // Routed by notificationRouter's PREFERENCE_MAP, so it has to be storable
        // here — a preference key the row cannot hold is a mute that silently
        // never applies.
        session_assigned: v.optional(v.boolean()),
        task_activity: v.optional(v.boolean()),
        doc_activity: v.optional(v.boolean()),
        plan_activity: v.optional(v.boolean()),
        artifact_activity: v.optional(v.boolean()),
        // Team chat that is not a direct mention: a thread reply, an @here. A
        // direct @you rides the existing `mention` key. Absent reads as ON, so the
        // key must exist here or the settings toggle has nowhere to persist and the
        // mute silently does nothing.
        chat_activity: v.optional(v.boolean()),
        // Master switch for the "while you were away" email digest
        // (emails/digest.ts). Absent reads as ON; the unsubscribe link and the
        // settings toggle both write false here.
        email_notifications: v.optional(v.boolean()),
        // Fold the "a session is waiting for you" alerts into one an hour
        // (notifications.ts, the idle digest). Absent reads as ON: the first
        // settle in a quiet hour still alerts at once, and everything that
        // settles behind it rides one aggregate alert at the window's end.
        session_idle_digest: v.optional(v.boolean()),
        // The Lock Screen Live Activity (liveActivity.ts). Absent reads as ON;
        // false ends the running activity and stops every start.
        live_activity: v.optional(v.boolean()),
        // Which agent comments on tasks reach this person's Threads inbox
        // (threadReads.ts taskCommentIsNews). Absent reads as "needs_person":
        // blockers, reviews and @mentions; progress and notes are the board's.
        task_agent_comments: v.optional(
          v.union(
            v.literal("all"),
            v.literal("needs_person"),
            v.literal("none"),
          ),
        ),
        // Ring the bell when a task this person takes part in is done or
        // dropped (tasks.ts notifyTaskStatus). Absent reads as OFF: status
        // moves are the board's, like Linear's opt-in "status changes".
        task_status_changes: v.optional(v.boolean()),
        // A laptop or daemon under sustained load (machine_overloaded,
        // daemon_overloaded). Absent reads as ON.
        machine_alerts: v.optional(v.boolean()),
      }),
    ),
    // Cooldown stamp for the email digest — at most one digest per cooldown
    // window, and items created before this stamp are never re-emailed.
    email_digest_last_sent_at: v.optional(v.number()),
    // Bearer for the one-click unsubscribe link. Minted lazily on first digest.
    email_unsub_token: v.optional(v.string()),
    // Cooldown state for the needs-input digest (notifications.ts). One alert
    // per window per person: `last_alerted_at` stamps the alert that opened the
    // current window, `flush_due_at` the scheduled fold-up at its end (absent
    // once that fold-up has run).
    idle_digest_state: v.optional(
      v.object({
        last_alerted_at: v.number(),
        flush_due_at: v.optional(v.number()),
      }),
    ),
    pr_auto_comment_enabled: v.optional(v.boolean()),
    // Dedupe/cooldown state for the aggregated "sessions blocked" notification
    // (accountSwitch.blockedNotifyCheck). One write per incident, not per park.
    blocked_notify_state: v.optional(
      v.object({
        last_notified_at: v.number(),
        // Newest pending_api_error park covered by that notification; a park
        // newer than this is a fresh casualty worth announcing again.
        last_park_ts: v.number(),
      }),
    ),
    bio: v.optional(v.string()),
    title: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("available"), v.literal("busy"), v.literal("away")),
    ),
    // Walkie talkie door. Absent means "team" — the open door, the default the
    // product argues for: a teammate's push-to-talk burst plays live on this
    // person's client. "off" closes it; the burst still LANDS as a chat voice
    // message, it just never plays itself. The door gates live playback only,
    // never delivery, so nobody can be silenced by someone else's setting.
    walkie_pref: v.optional(v.union(v.literal("team"), v.literal("off"))),
    // The shutter, as opposed to the door above. "Leave me alone for an hour":
    // the pref stays on, and until this moment passes no burst plays itself
    // here. It lives on the user rather than in the client prefs bag because
    // snoozing is a statement about the PERSON, not about the browser they
    // happened to press it in — it has to hold on the laptop and the phone at
    // once. Delivery is untouched, exactly like the pref: the burst still
    // lands as a voice message with its unread and its push.
    walkie_snoozed_until: v.optional(v.number()),
    timezone: v.optional(v.string()),
    hide_activity: v.optional(v.boolean()),
    // The weekly card (weeklyCards.ts): built each Monday for the week just
    // ended and offered to share. Off unless the person turns it on.
    weekly_card_enabled: v.optional(v.boolean()),
    // Public-profile opt-in. A claimed, unique handle (lowercase alnum+dash) that
    // forms the anonymous URL /u/<username>; github_username only pre-fills the
    // suggestion. `public_profile_enabled` is the master switch — until it's true
    // the public page 404s for everyone. See privacy.ts (public visibility tier).
    username: v.optional(v.string()),
    public_profile_enabled: v.optional(v.boolean()),
    share_session_metadata: v.optional(v.boolean()),
    activity_visibility: v.optional(
      v.union(
        v.literal("detailed"),
        v.literal("summary"),
        v.literal("minimal"),
        v.literal("hidden"),
      ),
    ),
    encryption_enabled: v.optional(v.boolean()),
    encryption_master_key: v.optional(v.string()),
    sync_mode: v.optional(v.union(v.literal("all"), v.literal("selected"))),
    sync_projects: v.optional(v.array(v.string())),
    // With sync_mode "all": folders that never upload, the folders inside
    // them and their checkouts' worktrees included.
    sync_excluded: v.optional(v.array(v.string())),
    // Cloud sessions the user's daemons sync (claude.ai/code, Cursor Cloud,
    // Codex Cloud, the Agents API): one per CLOUD_SESSION_SOURCES entry,
    // unset = the source's default there.
    ...cloudSessionSyncFields,
    team_share_paths: v.optional(v.array(v.string())),
    muted_members: v.optional(v.array(v.id("users"))),
    team_conversations_last_seen: v.optional(v.number()),
    cli_version: v.optional(v.string()),
    cli_platform: v.optional(v.string()),
    autostart_enabled: v.optional(v.boolean()),
    has_tmux: v.optional(v.boolean()),
    daemon_pid: v.optional(v.number()),
    // Which device's daemon currently owns the per-machine fields above
    // (cli_version, cli_platform, daemon_pid, autostart_enabled, has_tmux,
    // local_project_roots). With two machines online, each daemon used to
    // overwrite the other's values on every beat, and every reader of the user
    // doc re-rendered on each flip. The owner keeps them until it goes offline.
    daemon_fields_device_id: v.optional(v.string()),
    last_heartbeat: v.optional(v.number()),
    // Sync backlog reported on each heartbeat. Lets the web show a "sync
    // stalled" warning while the daemon is alive but data isn't flowing.
    // count = logical ops (per-conversation), messages/conversations = honest
    // backlog depth, oldest_pending_ms = how far behind the oldest queued item,
    // sync_no_progress_ms = how long the queue has completed nothing. An old
    // head with recent progress is a backlog draining in order, not a stall.
    daemon_pending_sync_count: v.optional(v.number()),
    daemon_oldest_pending_ms: v.optional(v.number()),
    daemon_pending_sync_messages: v.optional(v.number()),
    daemon_pending_sync_conversations: v.optional(v.number()),
    daemon_sync_no_progress_ms: v.optional(v.number()),
    // Daemon boot time and ms its event loop was blocked in the last minute —
    // last-writer across machines, like daemon_last_seen. The web reads the
    // per-device twins on `devices` first and falls back to these only when a
    // daemon predates device rows.
    daemon_started_at: v.optional(v.number()),
    daemon_loop_freeze_ms: v.optional(v.number()),
    // Capability convergence: monotonic revision (bumped by any binding write)
    // and the reconciler mode kill switch ("off" | "dry" | "on").
    capability_revision: v.optional(v.number()),
    capabilities_mode: v.optional(v.string()),
    agent_permission_modes: v.optional(
      v.object({
        claude: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
        codex: v.optional(
          v.union(
            v.literal("default"),
            v.literal("full_auto"),
            v.literal("bypass"),
          ),
        ),
        gemini: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
        muse: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
      }),
    ),
    // Settings → Agents "Claude sessions run in": the backend new Claude
    // sessions start on. Unset = DEFAULT_CLAUDE_BACKEND (@codecast/agent-clients/claudeBackend).
    // Mirrored into the daemon's config.claude_backend by the heartbeat.
    claude_backend: v.optional(v.union(v.literal("sdk"), v.literal("tmux"))),
    agent_default_params: v.optional(
      v.object({
        claude: v.optional(v.record(v.string(), v.string())),
        codex: v.optional(v.record(v.string(), v.string())),
        gemini: v.optional(v.record(v.string(), v.string())),
        cursor: v.optional(v.record(v.string(), v.string())),
        muse: v.optional(v.record(v.string(), v.string())),
      }),
    ),
    available_agents: v.optional(
      v.array(
        v.object({
          name: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    ),
    available_skills: v.optional(v.string()),
    // Paths the running daemon can see on this user's machine. Published on
    // every heartbeat. Used by the project switcher to hide "ghost" folders
    // that exist on another device the user owns but not on this one.
    local_project_roots: v.optional(v.array(v.string())),
    local_project_roots_updated_at: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("by_email_unsub_token", ["email_unsub_token"])
    .index("by_github_username", ["github_username"])
    .index("by_github_id", ["github_id"])
    .index("by_username", ["username"])
    .index("by_team_id", ["team_id"])
    .index("by_last_heartbeat", ["last_heartbeat"])
    // The Monday weekly card sweep reads only the people who turned it on.
    .index("by_weekly_card", ["weekly_card_enabled"])
    // One phone, one account: storePushToken takes the token off any other user.
    .index("by_push_token", ["push_token"]),

  // Per-user skills blob, split out of the users doc. The users doc is patched
  // on every heartbeat, and Convex versions the WHOLE doc per patch — carrying
  // a 30-100KB skills map on it cost ~20GB of version churn per retention
  // window. Skills live here (written only when they actually change);
  // getCurrentUser overlays them back so clients still read
  // currentUser.available_skills. users.available_skills is legacy: shed on the
  // next setAvailableSkills write per user, kept in schema for dormant users.
  user_skills: defineTable({
    user_id: v.id("users"),
    project_path: v.optional(v.string()),
    skills_json: v.string(),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_user_project", ["user_id", "project_path"]),
};

export const accountAuthTables = {
  rate_limits: defineTable({
    user_id: v.id("users"),
    endpoint: v.string(),
    window_start: v.number(),
    request_count: v.number(),
    last_request_at: v.optional(v.number()),
    sequence: v.optional(v.number()),
  }).index("by_user_endpoint", ["user_id", "endpoint"]),

  api_tokens: defineTable({
    user_id: v.id("users"),
    token_hash: v.string(),
    name: v.string(),
    created_at: v.number(),
    last_used_at: v.number(),
    expires_at: v.optional(v.number()),
    // The machine this token was minted for. OPTIONAL, and the optionality is
    // the migration: every token already in the wild carries none and keeps
    // authenticating from anywhere, exactly as before. Only a token that names a
    // device is checked against the device presenting it, so a token lifted off
    // one machine stops working on another WITHOUT a backfill and without
    // logging anybody out.
    //
    // Enforced in verifyApiToken, which stays a pure read — see the comment
    // there. Binding is a comparison, not a write.
    device_id: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_token_hash", ["token_hash"]),

  // Server-relayed `cast auth` handoffs for CLIs the browser can't reach over
  // 127.0.0.1 (SSH / remote machines). The web page deposits the minted token
  // keyed by a hash of the CLI's one-time nonce; the CLI polls /cli/claim-auth
  // and the row is deleted on first claim. Rows are transient: claimed within
  // minutes or swept (token revoked) by the cleanup cron.
  cli_auth_requests: defineTable({
    nonce_hash: v.string(),
    user_id: v.id("users"),
    token: v.string(),
    device_name: v.string(),
    created_at: v.number(),
  })
    .index("by_nonce_hash", ["nonce_hash"])
    .index("by_created_at", ["created_at"]),

  // `cast auth` requests the CLI registered before opening the browser
  // (POST /cli/auth-request). The Authorize page shows these server-recorded
  // facts instead of URL text, a deposit for a registered nonce is accepted
  // once and only while fresh, and the relay hands the token only to a claim
  // carrying the verifier whose hash is stored here (convex/cliAuth.ts).
  cli_auth_registrations: defineTable({
    nonce_hash: v.string(),
    verifier_hash: v.string(),
    device_name: v.string(),
    device_id: v.optional(v.string()),
    ip: v.string(),
    country: v.optional(v.string()),
    user_agent: v.optional(v.string()),
    created_at: v.number(),
    authorized_at: v.optional(v.number()),
  })
    .index("by_nonce_hash", ["nonce_hash"])
    .index("by_created_at", ["created_at"]),
};

export const ipRateLimitTables = {
  // Fixed-window counters for the IP-keyed rate limiter (ipRateLimit.ts) used on
  // UNAUTHENTICATED endpoints (the auth relay, webhooks) — the existing per-user
  // rate_limits table can't cover them (no userId). Keyed per (endpoint, ip) so
  // counters distribute — no hot doc. Pruned hourly.
  ip_rate_limits: defineTable({
    key: v.string(),
    count: v.number(),
    window_start: v.number(),
  }).index("by_key", ["key"]),
};
