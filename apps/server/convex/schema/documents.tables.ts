import { defineTable } from "convex/server";
import { v } from "convex/values";
import { DOC_TYPES } from "@codecast/docs";

export const documentTables = {
  docs: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // The id a client painted the doc under before the server made it (a board opened at once from a
    // placeholder): the synced row supersedes that placeholder through the docs altKey.
    client_key: v.optional(v.string()),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    title: v.string(),
    content: v.string(),
    // Derived from @codecast/docs DOC_TYPES so the schema and every
    // client's type list cannot drift.
    doc_type: v.union(...DOC_TYPES.map((t) => v.literal(t))),

    // Hierarchy: parent doc for nesting (Notion-like pages-within-pages)
    parent_id: v.optional(v.id("docs")),
    sort_order: v.optional(v.number()),
    // Explicit doc-to-doc links (wiki-style [[links]])
    linked_doc_ids: v.optional(v.array(v.id("docs"))),

    project_id: v.optional(v.id("projects")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    conversation_id: v.optional(v.id("conversations")),
    related_conversation_ids: v.optional(v.array(v.id("conversations"))),
    // related_conversation_ids[0], indexed (lib/accessKeys.ts firstLinkedConversationStamp).
    first_linked_conversation: v.optional(v.id("conversations")),

    source: v.union(
      v.literal("agent"),
      v.literal("human"),
      v.literal("plan_mode"),
      v.literal("file_sync"),
      v.literal("inline_extract"),
      v.literal("import"),
    ),
    source_file: v.optional(v.string()),
    plan_id: v.optional(v.id("plans")),

    project_path: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),

    // Visibility (inherited from source conversation for mined docs)
    is_private: v.optional(v.boolean()),
    team_visibility: v.optional(
      v.union(v.literal("summary"), v.literal("full"), v.literal("private")),
    ),

    embedding: v.optional(v.array(v.float64())),

    cli_edited_at: v.optional(v.number()),
    // Who made the last whole-body write outside the editor (a CLI, API or
    // agent write), named when a write from an older read is refused
    // (docs.writeDocBody).
    content_writer: v.optional(
      v.object({
        name: v.string(),
        session: v.optional(v.string()),
        at: v.number(),
      }),
    ),

    // The Overflow: loose writing kept beside the doc rather than in it
    // (stashed cuts, notes, words to use later). Plain text, edited from the
    // doc page's side panel and `cast doc overflow`.
    overflow: v.optional(v.string()),

    // Public sharing
    share_token: v.optional(v.string()),

    // Unified comment/entry timeline (symmetric with plans and tasks)
    entries: v.optional(
      v.array(
        v.object({
          type: v.union(
            v.literal("progress"),
            v.literal("decision"),
            v.literal("discovery"),
            v.literal("reference"),
            v.literal("blocker"),
            v.literal("note"),
          ),
          timestamp: v.number(),
          session_id: v.optional(v.string()),
          content: v.string(),
          author: v.optional(v.string()),
          rationale: v.optional(v.string()),
          path_or_url: v.optional(v.string()),
        }),
      ),
    ),

    created_at: v.number(),
    updated_at: v.number(),
    archived_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_updated", ["user_id", "updated_at"])
    // A doc-level write a client made under the placeholder id (a rename before the create answered).
    .index("by_client_key", ["client_key"])
    .index("by_parent_id", ["parent_id"])
    .index("by_project_id", ["project_id"])
    // A project's memory is its pinned docs (session-projects.md SP6).
    .index("by_project_pinned", ["project_id", "pinned"])
    // Sparse: docs attached to a plan, for the org scope feed (F2).
    .index("by_plan_id", ["plan_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_source_file", ["source_file"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_first_linked_conversation", ["first_linked_conversation"])
    .index("by_share_token", ["share_token"])
    .searchIndex("search_docs_v2", {
      searchField: "title",
      filterFields: ["user_id", "doc_type", "project_id"],
    }),
};

export const vaultMirrorTables = {
  // Remote mirror of a local markdown vault: one row per registered vault the
  // user turned mirroring on for (`cast vault mirror <dir> --on`). The daemon on
  // the owning device is the only writer; the browser reads. Mirroring is opt-in
  // and off by default, so a row existing here IS the user's consent. See
  // convex/vaultMirror.ts and packages/vault/src/vaultMirror.ts.
  vault_mirrors: defineTable({
    user_id: v.id("users"),
    // Which machine's disk this mirror projects. A vault id is derived from the
    // absolute root path, so two machines with ~/notes produce the SAME vault_id
    // — the device is what tells the two mirrors apart.
    device_id: v.string(),
    vault_id: v.string(),
    name: v.string(),
    root: v.string(),
    note_count: v.number(),
    last_synced_at: v.number(),
    // Reserved for the later sharing tier (directory_team_mappings). Nothing
    // reads it yet: this phase is strictly owner-only.
    is_public: v.optional(v.boolean()),
  })
    .index("by_user", ["user_id"])
    .index("by_user_vault", ["user_id", "vault_id", "device_id"]),

  // One-shot tickets for a vault note body upload (vaultMirror.cliBodyUploadUrl).
  // The daemon POSTs the body to a URL carrying the token; the upload consumes
  // the ticket and records the blob in artifact_uploads under the ticket's
  // user, which is the proof cliUpsertNotes requires before a row may hold it.
  vault_upload_tickets: defineTable({
    token: v.string(),
    user_id: v.id("users"),
    expires_at: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_expires_at", ["expires_at"]),

  // Note METADATA only. A body is never a field here: the docs table's 12-per-
  // page clamp exists because Convex materializes whole bodies into a 64MB
  // isolate heap before a handler can strip them, and a vault would hit that
  // harder. Bodies live in ctx.storage; body_storage_id points at one.
  vault_notes: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    vault_id: v.string(),
    // Denormalized so a note row renders its vault's name without a join.
    vault_name: v.string(),
    // Vault-relative, "/"-separated.
    path: v.string(),
    title: v.string(),
    mtime: v.number(),
    size: v.number(),
    // 16-hex sha256 prefix — the same digest the loopback /vault/file route
    // serves as its ETag, so local and remote agree on file identity.
    content_hash: v.string(),
    tags: v.array(v.string()),
    // Wiki-link targets as written; the reader resolves them against its own
    // file list (it needs the whole vault to do that, and it has it).
    links: v.array(v.string()),
    heading_count: v.number(),
    is_dir: v.optional(v.boolean()),
    body_storage_id: v.optional(v.id("_storage")),
    // Stamp of the full scan that last touched this row. A `complete` push
    // sweeps rows carrying an older stamp — that is how deletions the daemon
    // never observed as events still reach the mirror.
    scan_id: v.optional(v.string()),
    updated_at: v.number(),
  })
    // A row's identity is (user, vault, DEVICE, path). The device belongs in the
    // key because a vault id is derived from the absolute root path, so two
    // machines that both keep ~/notes produce the same vault_id — without the
    // device in the key their daemons would overwrite each other's rows forever.
    .index("by_user_vault_device", ["user_id", "vault_id", "device_id", "path"])
    // Reader index: one vault across every device the user mirrors it from.
    .index("by_user_vault", ["user_id", "vault_id", "path"])
    .index("by_user", ["user_id"]),
};

export const documentEditingTables = {
  doc_snapshots: defineTable({
    id: v.string(),
    version: v.number(),
    // The full ProseMirror doc serialized as JSON. Stored gzip-compressed in
    // `content_gz` (text compresses ~5-10x) so large docs stay under Convex's
    // 1 MiB per-document limit. `content` is the legacy uncompressed form —
    // still read for rows written before compression; never written anymore.
    content: v.optional(v.string()),
    content_gz: v.optional(v.bytes()),
  }).index("id_version", ["id", "version"]),

  doc_deltas: defineTable({
    id: v.string(),
    version: v.number(),
    clientId: v.union(v.string(), v.number()),
    steps: v.array(v.string()),
    // The person whose editor sent the steps, named when an agent's write is
    // refused because of them.
    user_id: v.optional(v.id("users")),
  }).index("id_version", ["id", "version"]),

  doc_presence: defineTable({
    doc_id: v.string(),
    user_id: v.id("users"),
    user_name: v.string(),
    user_color: v.string(),
    cursor_pos: v.optional(v.number()),
    anchor_pos: v.optional(v.number()),
    // Live draft text for composer co-presence (doc_id "compose:<conversationId>").
    // Lets each side watch the words the other is forming without a full OT buffer.
    // Unused by the document editor, which only sends cursor/anchor positions.
    draft_text: v.optional(v.string()),
    // Composer co-presence in a session (doc_id "compose:<id>"), written only
    // while someone else is present. user_image: the face others draw.
    // can_send: whether this person may send into the session (server
    // computed); a draft from someone who may not reads as a suggestion.
    // anchor: where they are reading in the transcript (the same anchor follow
    // mode reports). claims: drafts of others this person sent as part of a
    // joint turn, so each named author's composer clears. anchor_at: when the
    // anchor last moved (the heartbeat refreshes updated_at, not this), so a
    // reader can tell a face that is reading from one left parked.
    user_image: v.optional(v.string()),
    can_send: v.optional(v.boolean()),
    anchor: v.optional(
      v.object({ message_id: v.string(), offset: v.number() }),
    ),
    anchor_at: v.optional(v.number()),
    claims: v.optional(
      v.array(
        v.object({
          user_id: v.id("users"),
          text: v.string(),
          at: v.number(),
          how: v.optional(v.string()),
        }),
      ),
    ),
    // compose: rows only. This person's box has joined the shared draft, focused
    // or not; cursor_pos is set only while it is focused.
    in_draft: v.optional(v.boolean()),
    updated_at: v.number(),
  })
    .index("by_doc", ["doc_id"])
    .index("by_user_doc", ["user_id", "doc_id"]),
};
