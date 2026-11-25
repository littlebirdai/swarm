import { resourceOffloadIntent } from "../resourceOffloadSchema";
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sessionMigrationTables = {
  // Stable-context records that arrived before their conversation existed. The
  // SessionStart hook fires at agent boot and reports by agent session id; a
  // terminal-started session's conversation row is only created when the daemon
  // first syncs the transcript, seconds later. recordStableContext parks the
  // record here and createConversation / updateSessionId consume it (patching
  // conversations.stable_context, deleting the row). Rows are transient — any
  // consumer also lazily prunes leftovers older than a day for its user.
  // ── Bulk session migration (sessionMigrations.ts) ────────────────────────
  // One batch = one gesture ("move these N sessions to <device>"). The rows
  // under it are the unit of progress the web narrates and the runner
  // advances; a batch's status is derived from its rows, never stored.
  migration_batches: defineTable({
    resource_offload: v.optional(resourceOffloadIntent),
    user_id: v.id("users"),
    // Short public id (mg-xxxxxxxx): what the daemon command, the CLI and the
    // web all name the batch by.
    batch_id: v.string(),
    to_device_id: v.string(),
    created_at: v.number(),
    updated_at: v.number(),
    // Human-cancelled: queued rows were cancelled; running ones finish.
    cancelled_at: v.optional(v.number()),
    // How long the runner waits for a mid-turn session to go idle before it
    // interrupts the turn and moves anyway. 0 = interrupt immediately.
    wait_for_idle_ms: v.number(),
    interrupt_on_timeout: v.optional(v.boolean()),
    // Sessions transferred in parallel per executor (SSH transfers).
    concurrency: v.number(),
    // The local daemons that run this batch, one command each.
    executor_device_ids: v.array(v.string()),
  })
    .index("by_batch_id", ["batch_id"])
    .index("by_user_created", ["user_id", "created_at"]),

  // A dry run of one session's move, made by the machine holding its files
  // (cast migrate rehearse) when the offload review asks: whether it would
  // land and what the session would miss on the destination. Read by the
  // review and by resourceOffload.start; MoveRehearsal is `result`.
  move_rehearsals: defineTable({
    user_id: v.id("users"),
    request_id: v.string(),
    source_device_id: v.string(),
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    destination_id: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    created_at: v.number(),
    finished_at: v.optional(v.number()),
  })
    .index("by_request", ["request_id"])
    .index("by_user_created", ["user_id", "created_at"])
    .index("by_session_destination", [
      "session_id",
      "destination_id",
      "created_at",
    ]),

  session_migrations: defineTable({
    user_id: v.id("users"),
    batch_id: v.string(),
    conversation_id: v.id("conversations"),
    session_id: v.optional(v.string()),
    // Snapshot for the progress list (the row must read on its own).
    title: v.optional(v.string()),
    short_id: v.optional(v.string()),
    direction: v.union(v.literal("to_cloud"), v.literal("to_local")),
    from_device_id: v.optional(v.string()),
    to_device_id: v.string(),
    // The online local daemon that performs this row's transfer.
    executor_device_id: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("waiting_idle"),
      v.literal("quiescing"),
      v.literal("transferring"),
      v.literal("switching"),
      v.literal("resuming"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // One line of narration for the current status ("pushing worktree…").
    stage: v.optional(v.string()),
    error: v.optional(v.string()),
    // Sequence in the batch (the order the executor works through rows).
    position: v.number(),
    attempt: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
    started_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
    // Where the files went, so a later batch can bring the session back
    // without the executor's local remote-moves.json.
    source_path: v.optional(v.string()),
    destination_path: v.optional(v.string()),
    verification: v.optional(v.string()),
    // The resume the flip enqueued on the destination — polled to confirm the
    // session actually came up there.
    resume_command_id: v.optional(v.id("daemon_commands")),
    // Repositories and folders on the source the move brings beside the
    // session's own checkout (a rehearsal found the session works in them).
    bring_paths: v.optional(v.array(v.string())),
  })
    .index("by_batch", ["batch_id", "position"])
    .index("by_conversation", ["conversation_id"])
    .index("by_user_created", ["user_id", "created_at"]),

  stable_context_spool: defineTable({
    user_id: v.id("users"),
    session_id: v.string(),
    data: v.string(),
    created_at: v.number(),
  })
    .index("by_session_id", ["session_id"])
    .index("by_user_created", ["user_id", "created_at"]),
};
