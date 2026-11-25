import { syncOutboxTables } from "../syncOutboxSchema";
import { pushReceiptTables } from "../pushReceiptsSchema";
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const syncCursorTables = {
  sync_cursors: defineTable({
    user_id: v.id("users"),
    file_path_hash: v.string(),
    last_position: v.number(),
    last_synced_at: v.number(),
  }).index("by_user_id", ["user_id"]),
};

export const clientStateTables = {
  client_state: defineTable({
    user_id: v.id("users"),
    current_conversation_id: v.optional(v.string()),
    show_dismissed: v.optional(v.boolean()),
    dismissed_ids: v.optional(v.array(v.string())),

    // Client preference bags — typed on the client via ClientUI/ClientLayouts/etc.
    // Using v.any() so new prefs don't require schema migrations.
    ui: v.optional(v.any()),
    layouts: v.optional(v.any()),
    dismissed: v.optional(v.any()),
    tips: v.optional(v.any()),

    drafts: v.optional(v.any()),
    tabs: v.optional(v.any()),
    activeTabId: v.optional(v.string()),

    // deprecated: kept for backward compat during migration
    sidebar_collapsed: v.optional(v.boolean()),
    zen_mode: v.optional(v.boolean()),
    layout: v.optional(
      v.object({
        sidebar: v.number(),
        main: v.number(),
      }),
    ),

    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // Strict server revisions for named local materialized-view contracts. These
  // are deliberately independent from change_log: a revision is advanced in
  // the same Convex transaction as every write that can affect the complete
  // view, whereas change_log is a best-effort repair signal ordered by wall
  // clock time. Clients compare revisions only within one exact
  // principal+contract+view domain.
  local_view_heads: defineTable({
    principal_id: v.id("users"),
    contract_id: v.string(),
    view_key: v.string(),
    revision: v.number(),
    updated_at: v.number(),
  }).index("by_principal_contract_view", [
    "principal_id",
    "contract_id",
    "view_key",
  ]),

  // Durable, principal-scoped idempotency receipts for the v2 local command
  // protocol. Receipts are retained indefinitely in the initial protocol; a
  // future compactor must first negotiate a retry horizon with supported
  // clients. A SHA-256 fingerprint of canonical validated arguments prevents a
  // command id from being reused for different intent without retaining user
  // payload content in this long-lived table.
  local_command_receipts: defineTable({
    principal_id: v.id("users"),
    command_id: v.string(),
    command_name: v.string(),
    receipt_version: v.number(),
    argument_fingerprint: v.string(),
    status: v.union(v.literal("acknowledged"), v.literal("rejected")),
    result: v.optional(v.any()),
    rejection_code: v.optional(v.string()),
    rejection_message: v.optional(v.string()),
    correction: v.optional(v.any()),
    coverage: v.array(
      v.union(
        // Existing complete-view revision coverage (shape retained verbatim).
        v.object({
          contract_id: v.string(),
          view_key: v.string(),
          revision: v.number(),
        }),
        // Payload-free proof required by append/echo views such as messages.
        v.object({
          kind: v.literal("command-id"),
          contract_id: v.string(),
          view_key: v.string(),
          command_id: v.string(),
        }),
      ),
    ),
    created_at: v.number(),
  })
    .index("by_principal_command", ["principal_id", "command_id"])
    .index("by_principal_created", ["principal_id", "created_at"]),
};

export const counterAndSyncLogTables = {
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  // Cross-entity change feed — the per-user "what changed" log that lets a
  // client returning online catch up on EVERY change (including deletes) across
  // conversations, tasks, docs and plans, without re-reading whole lists and
  // diffing. One row PER ENTITY (not per change): every write upserts the row's
  // `seq` to now, so the table is bounded by entity count, not change volume.
  // The write interceptor in functions.ts is the sole writer (see changeLog.ts).
  //  - entity_id      the entity's _id as a string (entity_type says which table)
  //  - op             "upsert" (created/changed) | "delete" (hard-deleted)
  //  - owner_user_id  the entity's user_id — owner-scope catch-up (the inbox)
  //  - team_id        the entity's team_id when shared — team-scope catch-up
  //  - seq            Date.now() at write time; the monotonic cursor clients track
  change_log: defineTable({
    entity_type: v.union(
      v.literal("conversations"),
      v.literal("tasks"),
      v.literal("docs"),
      v.literal("plans"),
      v.literal("projects"),
    ),
    entity_id: v.string(),
    op: v.union(v.literal("upsert"), v.literal("delete")),
    owner_user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    seq: v.number(),
  })
    .index("by_entity", ["entity_id"])
    .index("by_owner_seq", ["owner_user_id", "seq"])
    .index("by_team_seq", ["team_id", "seq"]),

  // ── Sync log ────────────────────────────────────────────────────────────────
  // Append-only per-scope sync action log (docs/architecture/sync-log-migration.md).
  // Supersedes change_log's Date.now() heuristic for NEW clients; change_log stays
  // dual-written for deployed bundles.
  sync_actions: defineTable({
    // "user:<userId>" | "team:<teamId>" — same vocabulary as the workspace key.
    scope_key: v.string(),
    position: v.number(),
    entity_type: v.union(
      v.literal("conversations"),
      v.literal("tasks"),
      v.literal("docs"),
      v.literal("plans"),
      v.literal("projects"),
      // Scope membership lifecycle: entity_id is the team id, op is
      // scope_added | scope_removed, emitted in the affected USER's scope.
      v.literal("scope"),
      // Member lifecycle: entity_id is the departed USER id, op is
      // scope_removed, emitted in the TEAM's scope, so every remaining
      // member's client drops that user's rows from its team caches.
      v.literal("member"),
    ),
    entity_id: v.string(),
    op: v.union(
      v.literal("upsert"),
      v.literal("delete"),
      v.literal("scope_added"),
      v.literal("scope_removed"),
    ),
    ts: v.number(),
    // ── Cargo (docs/architecture/sync-log-cargo.md E1–E3) ──
    // The changed TOP-LEVEL fields as a merge patch ({ field: value }); `unset`
    // lists removed fields; `full` marks a whole-document patch (insert/replace,
    // self-heal) that needs no base row; `partial` marks a payload dropped by
    // the size guard or the cargo kill switch — the client applies what is here
    // and refetches the row. Denylisted (OMIT-class) fields are dropped silently
    // and only their NAMES ride in `omitted`; they never mark partial (E3).
    // Absent `patch` with op upsert means "no cargo": the client falls back to
    // the authorized byIds fetch (old rows, kill switch).
    patch: v.optional(v.any()),
    unset: v.optional(v.array(v.string())),
    full: v.optional(v.boolean()),
    partial: v.optional(v.boolean()),
    omitted: v.optional(v.array(v.string())),
    // ── Access stamp (E4) — enforced at READ by getRange, never by scope_key ──
    // scope_key stays ROUTING (which scopes the row fans to). These three say
    // who may read the cargo: the owner, explicit grants (a task's assignee),
    // and holders of the workspace access key. getRange projects a row the
    // caller may not read to a bare delete. Stamped from the post-write
    // document; a write that changes access is itself an action, so readers
    // who lose access see the delete on their next range.
    access_owner: v.optional(v.string()),
    access_key: v.optional(v.string()),
    access_grants: v.optional(v.array(v.string())),
  })
    .index("by_scope_position", ["scope_key", "position"])
    // Coalescing lookup: is this entity's latest action already at the head?
    .index("by_scope_entity", ["scope_key", "entity_id"])
    .index("by_ts", ["ts"]),

  // One row per scope: the head position (highest allocated) and the floor
  // (highest position retired by retention; a client whose cursor is below the
  // floor must resync via full backfill). Heads are never deleted.
  ...syncOutboxTables,
  ...pushReceiptTables,
  sync_heads: defineTable({
    scope_key: v.string(),
    position: v.number(),
    floor: v.number(),
    updated_at: v.number(),
  }).index("by_scope", ["scope_key"]),
};
