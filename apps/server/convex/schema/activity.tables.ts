import { defineTable } from "convex/server";
import { v } from "convex/values";

export const activityTables = {
  team_activity_events: defineTable({
    team_id: v.id("teams"),
    actor_user_id: v.id("users"),
    event_type: v.union(
      v.literal("session_started"),
      v.literal("session_completed"),
      v.literal("commit_pushed"),
      v.literal("member_joined"),
      v.literal("member_left"),
      v.literal("pr_created"),
      v.literal("pr_merged"),
    ),
    title: v.string(),
    description: v.optional(v.string()),
    timestamp: v.number(),
    related_conversation_id: v.optional(v.id("conversations")),
    related_commit_sha: v.optional(v.string()),
    related_pr_id: v.optional(v.id("pull_requests")),
    metadata: v.optional(
      v.object({
        duration_ms: v.optional(v.number()),
        message_count: v.optional(v.number()),
        git_branch: v.optional(v.string()),
        files_changed: v.optional(v.number()),
        insertions: v.optional(v.number()),
        deletions: v.optional(v.number()),
      }),
    ),
  })
    .index("by_team_id", ["team_id"])
    .index("by_team_timestamp", ["team_id", "timestamp"])
    .index("by_actor", ["actor_user_id"])
    // Time-bounded actor reads: activity charts scan a trailing window, and a
    // long-lived account accumulates far more events than any window shows.
    .index("by_actor_timestamp", ["actor_user_id", "timestamp"]),

  // Per-day human-send counters (the "Typed" and "Words" chart metrics). One row per
  // (user, team, UTC day); `hours` holds 24 UTC-hour buckets. Written at
  // message-insert time by messages.ts via lib/userSend.recordUserSend — a
  // send is a user-role message a person actually typed (noise-classified),
  // which is not reconstructable cheaply from `messages` after the fact.
  user_send_daily: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    day_start: v.number(),
    total: v.number(),
    hours: v.array(v.number()),
    // Words typed, in total and per UTC hour.
    words: v.optional(v.number()),
    word_hours: v.optional(v.array(v.number())),
    updated_at: v.number(),
  })
    .index("by_user_day", ["user_id", "day_start"])
    .index("by_user_team_day", ["user_id", "team_id", "day_start"]),

  // One row per counted send (the rows user_send_daily sums), so the Prompts
  // page reads a team's day of sends without scanning its sessions. Carries
  // the prompt as displayed, clipped, because a message row can hold inline
  // images and a day of them would pass a query's read limit. Written beside
  // the counter in recordSendFor and emptied with it by a send rebuild
  // (sendBackfill).
  user_sends: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    timestamp: v.number(),
    words: v.number(),
    text: v.string(),
    clipped: v.boolean(),
    // A decision answer: the question it answered, and whether it picked an
    // option (shown, not counted as typing) or was written.
    decision: v.optional(
      v.object({ question: v.string(), picked: v.boolean() }),
    ),
  })
    .index("by_team_timestamp", ["team_id", "timestamp"])
    .index("by_message", ["message_id"])
    // One person's sends across every team and their personal workspace,
    // newest first: the Messages feed (userSends.mine).
    .index("by_user_timestamp", ["user_id", "timestamp"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["user_id"],
    }),

  // Per-day token and spend counters (the "Tokens" and "Spend" chart
  // metrics). One row per (user, team, UTC day), 24 UTC-hour buckets each;
  // spend is dollars at API list price. Never written by a transcript insert:
  // the insert adds to its own session's usage_pending rows and a scheduled
  // fold moves them here (lib/usageDaily.ts).
  user_usage_daily: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    day_start: v.number(),
    // Set on the row holding sessions nobody was watching
    // (isUnattendedConversation); a day has one row of each.
    unattended: v.optional(v.boolean()),
    token_hours: v.array(v.number()),
    spend_hours: v.array(v.number()),
    updated_at: v.number(),
  })
    .index("by_user_day", ["user_id", "day_start"])
    .index("by_user_team_day", ["user_id", "team_id", "day_start"]),

  // A person's week with coding agents (@codecast/usage/weeklyCard): one row
  // per (user, local Monday). `stats` is built by weeklyCards.generate and
  // never holds a title, prompt, path or teammate; project names ride in it
  // but reach the public page only with show_projects. share_token is the
  // publicShare "card" kind's link; while it is set, the options are locked so
  // nothing reaches the page that the owner did not confirm.
  weekly_cards: defineTable({
    user_id: v.id("users"),
    workspace: v.string(),
    week_key: v.string(),
    week_start: v.number(),
    tz: v.string(),
    stats: v.any(),
    generated_at: v.number(),
    show_projects: v.optional(v.boolean()),
    show_tokens: v.optional(v.boolean()),
    share_token: v.optional(v.string()),
    // When the Monday sweep told the owner this week's card is ready.
    notified_at: v.optional(v.number()),
  })
    .index("by_user_week", ["user_id", "week_key"])
    .index("by_share_token", ["share_token"]),

  // A session's usage not yet folded into user_usage_daily, per UTC day.
  usage_pending: defineTable({
    conversation_id: v.id("conversations"),
    day_start: v.number(),
    // The account (email) the session's machine ran on when these turns
    // landed, so the fold can split a person's tokens by account
    // (account_usage_daily). Absent when the machine reports no account.
    account: v.optional(v.string()),
    token_hours: v.array(v.number()),
    spend_hours: v.array(v.number()),
  }).index("by_conversation_day", ["conversation_id", "day_start"]),

  // Per-day session-activity counters behind the profile contribution graph,
  // the hour punchcard and the team charts. One row per (user, team, UTC day,
  // attended or not); each counter holds 24 UTC-hour buckets. The raw sources (a year of
  // `team_activity_events`, `session_insights` and `conversations`) are one row
  // per session — tens of thousands for an active account, which blew the
  // per-transaction system-operation ceiling and made the profile fail. A day
  // is rolled up once (lib/activityDaily.ts) and read as one small row after
  // that; only today and yesterday are still computed from the raw rows.
  // `day_sessions` is the distinct sessions credited to the day, which per-hour
  // buckets cannot reconstruct (one session touches several hours).
  user_activity_daily: defineTable({
    user_id: v.id("users"),
    // The row's own routing team, matching the scope filter the profile
    // queries apply (a conversation's team_id, an event's team_id). Absent for
    // activity that carried no team.
    team_id: v.optional(v.id("teams")),
    day_start: v.number(),
    // Set on the row holding sessions nobody was watching
    // (isUnattendedConversation); a day has one row of each.
    unattended: v.optional(v.boolean()),
    hours: v.array(v.number()),
    msgs: v.array(v.number()),
    sessions: v.array(v.number()),
    day_sessions: v.number(),
    // Distinct project basenames worked on that day (a COUNT, never names —
    // the public contribution graph shows "N sessions on M projects").
    projects: v.number(),
    // The same counters over the sessions the owner SHARES with this team
    // (createTeamFeedFilter's rule at rollup time). A teammate's view of the
    // profile reads these; the owner and the anonymized public graph read the
    // totals above. A session whose conversation row is gone counts as shared:
    // the fallback sources carry no privacy facts, only a tally.
    shared_hours: v.array(v.number()),
    shared_msgs: v.array(v.number()),
    shared_sessions: v.array(v.number()),
    shared_day_sessions: v.number(),
    shared_projects: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_day", ["user_id", "day_start"])
    .index("by_user_team_day", ["user_id", "team_id", "day_start"]),
};

export const timelineTables = {
  day_timelines: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    date: v.string(),
    events: v.array(
      v.object({
        time: v.number(),
        t: v.string(),
        event: v.string(),
        type: v.string(),
        session_id: v.optional(v.id("conversations")),
        session_title: v.optional(v.string()),
        project: v.optional(v.string()),
      }),
    ),
    narrative: v.optional(v.string()),
    generated_at: v.number(),
  })
    .index("by_user_date", ["user_id", "date"])
    .index("by_team_date", ["team_id", "date"]),
};
