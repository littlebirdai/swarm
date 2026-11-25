import { defineTable } from "convex/server";
import { v } from "convex/values";

export const notificationTables = {
  notifications: defineTable({
    recipient_user_id: v.id("users"),
    type: v.union(
      v.literal("mention"),
      v.literal("comment_reply"),
      v.literal("conversation_comment"),
      v.literal("team_invite"),
      v.literal("session_idle"),
      v.literal("permission_request"),
      v.literal("session_error"),
      v.literal("session_assigned"),
      v.literal("team_session_start"),
      v.literal("task_completed"),
      v.literal("task_failed"),
      v.literal("task_assigned"),
      v.literal("task_status_changed"),
      v.literal("task_commented"),
      v.literal("doc_updated"),
      v.literal("doc_commented"),
      v.literal("plan_status_changed"),
      v.literal("plan_task_completed"),
      v.literal("artifact_commented"),
      // Team chat. By default ordinary chatter produces unread state only —
      // never a notification row, never a push. A direct message is one
      // exception (addressed to you by construction, it notifies like a
      // mention); chat_post is the other: a plain channel line, written only
      // for members who set that channel's notify level to "all".
      v.literal("chat_mention"),
      v.literal("chat_reply"),
      v.literal("chat_here"),
      v.literal("chat_dm"),
      // Someone added you to a private channel or a group message.
      v.literal("chat_added"),
      v.literal("chat_post"),
      // One machine's daemon event loop froze past the budget in the last hour
      // (daemonLogs.checkDeviceLoopFreeze). Entity is the device, not a session:
      // the whole machine is late, not one conversation.
      v.literal("daemon_overloaded"),
      // A laptop under sustained CPU or memory pressure, announced from the
      // sample that confirmed it (machineResources.storeResourceSnapshot).
      v.literal("machine_overloaded"),
      // A role telling a person who reports to it that a high priority goal
      // has stalled (org-roles-run-work.md R6); one a day at most.
      v.literal("goal_stall"),
      // The needs-input digest: one row naming every session that started
      // waiting inside the window. Names no conversation on purpose — it
      // points at the inbox, not at one session out of several.
      v.literal("sessions_need_input"),
      // A teammate opened one of their machines to a team you are on, so you
      // can now start sessions there (devices.performSetDeviceShares).
      v.literal("device_shared"),
      // The line (the-line-end-to-end.md LE16): a change card waits on the
      // recipient, a cause's change shipped, a watched cause reopened.
      v.literal("card_waiting"),
      v.literal("change_shipped"),
      v.literal("cause_reopened"),
      // A deploy took off what the recipient's uncommitted push had put on its
      // target (deploys.noticeDroppedWork). Entity is the dropping deploy.
      v.literal("deploy_dropped_work"),
      // The last blocker of a task assigned to the recipient cleared and no
      // session owns it (taskWaits.onUnblocked, task-graph.md TG2).
      v.literal("task_unblocked"),
      // Someone outside a decision's people answered or dismissed it for
      // them (sessionDecisions.noticeAnsweredForPeople).
      v.literal("decision_answered_for_you"),
      // A decision handed to the recipient with a note: passed by a teammate,
      // or escalated to them as the owner's manager or an admin (decisionHandoff.ts).
      v.literal("decision_passed"),
      v.literal("decision_escalated"),
      v.literal("decision_assigned"),
      // A card waiting on the recipient: every card one session asked in one turn (lib/decisionPush.ts).
      v.literal("decision_waiting"),
      // A comment in the thread of a decision the recipient owns or takes part in (decisionThread.ts).
      v.literal("decision_comment"),
      // Finding a team by work email (teamDiscovery.ts): someone asked to
      // join (to its admins), and an admin let them in (to them).
      v.literal("team_join_request"),
      v.literal("team_join_approved"),
      // A passkey added to or removed from the recipient's account (passkeys.ts).
      v.literal("passkey_changed"),
      // The person's weekly card is ready to look at and share (weeklyCards.ts).
      v.literal("weekly_card"),
      // A metric watch that names the recipient crossed its line, is still
      // past it, or recovered (metricAlerts.ts).
      v.literal("metric_alert"),
      // A role's standing session failed over off a quiet host, or could not
      // (roleFailover.ts). Entity is the role: it opens the role's page.
      v.literal("role_moved"),
    ),
    actor_user_id: v.optional(v.id("users")),
    // Display identity for actors without an account (an anonymous artifact
    // commenter): name + avatar snapshot, used when actor_user_id is absent.
    actor_name: v.optional(v.string()),
    actor_avatar: v.optional(v.string()),
    comment_id: v.optional(v.union(v.id("comments"), v.id("review_comments"))),
    conversation_id: v.optional(v.id("conversations")),
    entity_type: v.optional(
      v.union(
        v.literal("task"),
        v.literal("doc"),
        v.literal("plan"),
        v.literal("conversation"),
        v.literal("artifact"),
        v.literal("chat_channel"),
        v.literal("device"),
        // A place in a repository (`owner/repo@sha` or `owner/repo#12`): a code
        // comment named the recipient.
        v.literal("code"),
        // A role (its short id): the goal stall notice opens the role's page,
        // where the person reads their goals with what moved and what stalled.
        v.literal("org_role"),
        // A team: a join request or approval opens its settings.
        v.literal("team"),
        // A machine by daemon device id: the overload alert opens its offload review.
        v.literal("machine"),
        // A passkey added or removed: opens Settings > Accounts.
        v.literal("passkey"),
        // A weekly card by its week key: opens /week on that week.
        v.literal("weekly_card"),
        // A metric watch by its short id: opens /ops/metrics/mw-N.
        v.literal("metric_watch"),
        // A deploy by its short id: opens /deploys?deploy=dp-N.
        v.literal("deploy"),
      ),
    ),
    entity_id: v.optional(v.string()),
    // The exact chat message a chat notification points at. entity_id names the
    // channel; this names the row inside it, so the bell, the toast and the phone
    // all deep-link to the same message instead of "the channel, somewhere".
    // Routing goes through entity_type + these ids, never through `link` — `link`
    // is for pages outside the app and web opens it in a new tab.
    chat_message_id: v.optional(v.id("chat_messages")),
    // Deep link the notification opens (e.g. codecast.sh/a/<slug>?c=<comment>
    // — the artifact page opens that comment thread). Takes precedence over
    // the entity_type route when present.
    link: v.optional(v.string()),
    message: v.string(),
    read: v.boolean(),
    created_at: v.number(),
    // A row that belongs in the list but must not interrupt: no desktop
    // banner, no push. The needs-input digest writes these while its window is
    // open, then one aggregate row carries the alert for all of them.
    quiet: v.optional(v.boolean()),
    // How many events this one row stands for, when a burst folded into it
    // (tasks.ts foldMachineAssignment). Absent means one.
    fold_count: v.optional(v.number()),
  })
    .index("by_recipient", ["recipient_user_id"])
    .index("by_recipient_read", ["recipient_user_id", "read"])
    .index("by_recipient_created", ["recipient_user_id", "created_at"])
    // Global recency scan for the email digest sweep (emails/digest.ts): find
    // recently-created unread rows without touching every user.
    .index("by_created", ["created_at"])
    // Session-state notifications (ready / needs permission / error) replace
    // per (recipient, conversation) instead of stacking — this is the lookup
    // for the row(s) being superseded.
    .index("by_recipient_conversation", [
      "recipient_user_id",
      "conversation_id",
    ]),

  // "A human is at a desktop surface" — one row per user, heartbeat-written by
  // the web/Electron client while visible (pushRouter.reportPresence). This is
  // presence of the PERSON (input recency), distinct from daemon liveness
  // (users.daemon_last_seen tracks the machine's agent). Read at push time to
  // decide whether the phone needs a copy; goes stale on its own when the tab
  // closes or the machine sleeps.
  user_presence: defineTable({
    user_id: v.id("users"),
    surface: v.string(),
    last_seen: v.number(),
    last_input_at: v.number(),
    focused: v.boolean(),
    updated_at: v.number(),
    // The conversation this person has open right now, as their focused
    // window reports it (usePresenceReporter). Written only when it changes,
    // so the heartbeat stays the one regular write on this hot row. Readers
    // (teams.getTeamMembers) reveal it only to callers who can open that
    // conversation, and never off a stale row: a closed tab stops reporting
    // and the id goes with it.
    viewing_conversation_id: v.optional(v.id("conversations")),
    viewing_since: v.optional(v.number()),
    // The viewed conversation's access fields, copied when the id is written
    // and refreshed by patchConversationVisibility (the one writer of the
    // mutable ones), so the roster gates the id without reading the
    // conversation: a read there re-ran getTeamMembers for every subscriber
    // at the viewed session's streaming rate (ct-92571).
    viewing_access: v.optional(
      v.object({
        user_id: v.id("users"),
        team_id: v.optional(v.id("teams")),
        is_private: v.boolean(),
        team_visibility: v.optional(v.string()),
        started_at: v.optional(v.number()),
      }),
    ),
  })
    .index("by_user", ["user_id"])
    .index("by_viewing_conversation", ["viewing_conversation_id"]),

  dispatch_outbox_receipts: defineTable({
    owner: v.id("users"),
    id_hash: v.string(),
    action: v.string(),
    response: v.string(),
    response_parts: v.optional(v.array(v.id("dispatch_outbox_receipts"))),
    deployment_key: v.optional(v.boolean()),
    expires_at: v.number(),
  })
    .index("by_owner_and_id", ["owner", "id_hash"])
    .index("by_expiry", ["expires_at"]),

  // Mobile push staging (pushRouter.ts). Rows wait out a routing delay (short
  // away-debounce, or a longer hold while the desktop is active), then a
  // per-user flush sends everything pending as ONE push — a burst of
  // notifications aggregates instead of buzzing the phone N times. Rows whose
  // notification is read (or superseded away) before the flush are dropped.
  // Rows are deleted on send; the table only ever holds in-flight pushes.
  push_outbox: defineTable({
    user_id: v.id("users"),
    notification_id: v.optional(v.id("notifications")),
    type: v.optional(v.string()),
    title: v.string(),
    // iOS second line ("#team", "thread · #team"). Only a single-row flush
    // shows it — a batch collapses to counts where a subtitle would lie.
    subtitle: v.optional(v.string()),
    body: v.string(),
    data: v.optional(v.any()),
    created_at: v.number(),
    due_at: v.number(),
    deferred: v.boolean(),
  }).index("by_user", ["user_id"]),

  push_ring: defineTable({
    user_id: v.id("users"),
    workspace: v.string(),
    epoch: v.string(),
    seq: v.number(),
    key: v.string(),
    type: v.optional(v.string()),
    title: v.string(),
    subtitle: v.optional(v.string()),
    body: v.string(),
    data: v.optional(v.any()),
    channel_id: v.optional(v.string()),
    interruption_level: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_user_seq", ["user_id", "seq"]),

  // The Lock Screen Live Activity: one row per user, the phone's side of the
  // merged strip (liveActivity.ts). Holds the two APNs credentials ActivityKit
  // hands out — the push-to-start token (iOS 17.2+, starts an activity while
  // the app is closed) and the per-activity update token — plus the coalescing
  // clocks the refresh uses to decide start / update / end / wait. One row per
  // user mirrors users.push_token: one phone per account for now.
  live_activities: defineTable({
    user_id: v.id("users"),
    // Which APNs host the tokens belong to. Reported by the device from its
    // build configuration: a development build's tokens only work on sandbox.
    environment: v.union(v.literal("production"), v.literal("sandbox")),
    push_to_start_token: v.optional(v.string()),
    push_to_start_token_at: v.optional(v.number()),
    // The running activity. Both come from the device after the activity
    // exists (ActivityKit assigns the id); until they arrive updates cannot be
    // addressed and the refresh waits out the start grace.
    activity_id: v.optional(v.string()),
    activity_token: v.optional(v.string()),
    // When a start push went out (no id yet). Cleared when the id lands or the
    // activity ends; while set and inside the grace, no second start goes out.
    start_sent_at: v.optional(v.number()),
    last_push_at: v.optional(v.number()),
    // liveActivityStateKey / liveActivityStatusKey of the last pushed state, so
    // an unchanged derivation pushes nothing and a status change is urgent.
    last_state_key: v.optional(v.string()),
    last_status_key: v.optional(v.string()),
    // The status key at the moment the person swiped the activity away. No
    // start goes out for that same picture: a dismissal is an answer, and
    // only a new event (a row entering, leaving or changing status) earns
    // another strip.
    dismissed_status_key: v.optional(v.string()),
    // The refresh is a single per-user job: a scheduled fire carries its due
    // stamp and stands down when the row has moved on to a newer one.
    refresh_due_at: v.optional(v.number()),
    updated_at: v.number(),
  }).index("by_user", ["user_id"]),
};

export const entitySubscriptionTables = {
  entity_subscriptions: defineTable({
    user_id: v.id("users"),
    entity_type: v.union(
      v.literal("task"),
      v.literal("doc"),
      v.literal("plan"),
      v.literal("conversation"),
      v.literal("artifact"),
      // Chat notifications never fan out over this table — the sender computes the
      // recipient list and re-checks channel access for each one, because a chat
      // preview carries real message text. This member exists only so the
      // notification and subscription entity unions stay one shape. Should a row
      // ever appear, `emit` re-checks team membership for a chat_channel entity
      // and both membership-removal paths (`teams.removeMember` and
      // `teams.removeFromTeam`) delete the rows of a departing member.
      v.literal("chat_channel"),
      // Device alerts go straight to the machine's owner, so nothing subscribes
      // to a device either. Present for the same reason: one shape.
      v.literal("device"),
      // A code comment names its recipients directly. Same reason: one shape.
      v.literal("code"),
      // A role, by short id: a goal stall notice to a person who reports to
      // it. Direct recipients only, like a device — nothing subscribes to a
      // role. Present for the same reason: one shape.
      v.literal("org_role"),
      // A team, for join requests. Direct recipients only. Same reason.
      v.literal("team"),
      // A machine, for the overload alert. Direct recipients only. Same reason.
      v.literal("machine"),
      // A passkey, for its owner's add and remove notices. Same reason.
      v.literal("passkey"),
      // A weekly card, for its owner's Monday notice. Same reason.
      v.literal("weekly_card"),
      // A metric watch, for its alert to the people it names. Same reason.
      v.literal("metric_watch"),
      // A deploy, for the notice that it dropped someone's work. Same reason.
      v.literal("deploy"),
    ),
    entity_id: v.string(),
    reason: v.union(
      v.literal("creator"),
      v.literal("assignee"),
      v.literal("mentioned"),
      v.literal("commenter"),
      v.literal("watching"),
    ),
    // Who performed the act that enrolled this user. "human": a person typed
    // it (web, manual CLI, meeting, human board origin). "agent": an agent
    // acting under the owner's token. Absent = legacy row, classified by the
    // retroactive sweep. Membership rules (thread inbox) read this; identity
    // alone never implies attention.
    via: v.optional(v.union(v.literal("human"), v.literal("agent"))),
    muted: v.boolean(),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_user", ["user_id", "entity_type"])
    .index("by_user_entity", ["user_id", "entity_type", "entity_id"]),
};
