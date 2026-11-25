import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sessionPathStatTables = {
  // Exact session totals per folder for the Sync settings page, rebuilt by a
  // paging job (pathStats.ts) so a folder of any size counts exactly without
  // the page reading its sessions. Private to its user; never shared.
  path_session_stats: defineTable({
    user_id: v.id("users"),
    path: v.string(),
    count: v.number(),
    first_started_at: v.optional(v.number()),
    last_started_at: v.optional(v.number()),
    hidden: v.number(),
    manually_shared: v.number(),
    // Start time histogram: bucket start (ms) and sessions in it, ascending.
    buckets: v.array(v.number()),
    bucket_counts: v.array(v.number()),
    // 0 until the first rebuild lands.
    computed_at: v.number(),
    refresh_started_at: v.optional(v.number()),
  }).index("by_user_path", ["user_id", "path"]),
};

export const sessionOwnershipTables = {
  // The SET of team members who OWN a session — the humans whose inboxes it
  // appears in and who receive its notifications. A session has zero or more
  // owners, each an independent, separately-removable assignment. This is one of
  // a session's three independent ownership axes and is deliberately distinct
  // from the other two: conversations.user_id (the account that RUNS + bills it)
  // and conversations.owner_device_id (the machine it runs ON). Reassigning
  // owners never moves the device, and vice versa.
  //
  // This table is the canonical owner store. conversations.owner_user_id is a
  // denormalized cache of the PRIMARY (first-added, still-present) owner, kept in
  // lockstep by the owner mutations for back-compat while readers migrate off it.
  // Seeded from owner_user_id by sessionOwnership.backfillSessionOwners.
  session_owners: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"), // the human owner (bots may never be owners)
    added_by: v.id("users"), // who assigned them — provenance + "X assigned you" notif
    added_at: v.number(),
    note: v.optional(v.string()), // assigner's optional handoff message
    seen_at: v.optional(v.number()), // when the assignee acknowledged the handoff
  })
    // Powers the owner's inbox merge: newest-first owner rows for a user, then
    // hydrate the conversations and filter by the activity window in JS.
    // Deliberately NOT keyed on the conversation's updated_at — denormalizing
    // that here would make every conversation heartbeat fan out and patch all of
    // its owner rows (write amplification). The owned set per user is small.
    .index("by_user", ["user_id", "added_at"])
    // List the owners of one session (owner chips, notification fan-out).
    .index("by_conversation", ["conversation_id"])
    // Membership check / dedupe — is this user already an owner of this session?
    .index("by_conversation_user", ["conversation_id", "user_id"]),

  // A viewer's hide of a session they neither run nor own: a teammate's row on
  // the team board. The owner's own triage lives on the conversation
  // (inbox_stashed_at / inbox_dismissed_at) and hides the row from everyone's
  // team board; those fields are the OWNER's and the dispatch gate refuses them
  // from anyone else, so a viewer's hide needs its own row. One row per viewer
  // and conversation; the team scan skips what the viewer hid. `cast restore`
  // and the restore gesture delete it.
  inbox_hides: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    kind: v.union(v.literal("stash"), v.literal("dismiss")),
    at: v.number(),
  })
    // Everything one viewer hid: read once per team scan.
    .index("by_user", ["user_id"])
    // Upsert / restore for one viewer and one session.
    .index("by_user_conversation", ["user_id", "conversation_id"]),

  // A session its owner deleted (sessionDelete.ts). The transcript still sits
  // on their machine, and the daemon recreates a conversation it finds missing,
  // so createConversation refuses a session_id listed here for that user.
  deleted_sessions: defineTable({
    user_id: v.id("users"),
    session_id: v.string(),
    conversation_id: v.string(),
    deleted_at: v.number(),
  }).index("by_user_session", ["user_id", "session_id"]),
};

export const inboxTables = {
  bookmarks: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_conversation", ["user_id", "conversation_id"])
    .index("by_message_id", ["message_id"])
    .index("by_user_name", ["user_id", "name"]),

  // Manual session buckets: personal, lightweight named groups for organizing
  // inbox sessions by workstream. Purely attention-organization for the human —
  // orthogonal to plans (which carry agent-facing context). Archive = archived_at
  // set; rows are never hard-deleted so the delta sync cache converges.
  inbox_buckets: defineTable({
    user_id: v.id("users"),
    name: v.string(),
    color: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    archived_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // One row per (user, conversation): exclusive bucket membership. Unassign sets
  // bucket_id null (delta-friendly tombstone) rather than deleting the row, so
  // every change reaches clients as an upsert. Kept off the conversation row on
  // purpose: conversations are hot, shared docs; filing is per-user and cold.
  bucket_assignments: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    bucket_id: v.optional(v.id("inbox_buckets")),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_conversation", ["user_id", "conversation_id"]),

  // One row per (user, conversation): where the viewer's attention stopped.
  // Same reasoning as bucket_assignments above — conversations are hot shared
  // docs, a read mark is per-user and cold, so it lives off the row and ships
  // on its own query.
  //
  // Unread is DERIVED, never stored: acknowledged_at < conversations.updated_at.
  // That is the same "a stamp any later activity silently expires" contract as
  // inbox_rest_at (see userRestOf), which is what makes an agent re-reporting
  // the same state free — nothing bumps updated_at — while a real new turn
  // re-lights the card. Every replica re-derives from the same two numbers, so
  // web, mobile and the CLI cannot disagree.
  //
  // No `workspace` key: a read mark is never shared, so user_id IS the access
  // (the same choice thread_reads, bucket_assignments and bookmarks make).
  session_reads: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    // Forward-only. Written only while the conversation is the active view
    // under page presence (see useAckActiveConversation).
    acknowledged_at: v.number(),
    // The manual "mark unread" gesture: unread whatever the stamps say, until
    // the next presence ack clears it.
    manual_unread: v.optional(v.boolean()),
    updated_at: v.number(),
  })
    // Newest-touched first: the client carries a bounded window of marks, and
    // the ones it needs are the sessions it has looked at most recently.
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_user_conversation", ["user_id", "conversation_id"]),
};
