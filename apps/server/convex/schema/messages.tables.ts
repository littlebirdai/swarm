import { defineTable } from "convex/server";
import { v } from "convex/values";
import { codeAnchorValidator } from "../lib/codeAnchorValidator";

export const transcriptTables = {
  // Large git-diff blobs split off the conversations hot doc. The conversations
  // row is read+patched on every message sync (addMessages) and returned by list
  // queries; keeping multi-MB diffs there inflated every read/write and worsened
  // OCC contention. These are written once at session creation (and on fork) and
  // read only on-demand by getConversationGitDiff.
  // Large per-conversation blobs that no LIST ever renders, keyed off the hot
  // doc so the inbox scan (which reads every candidate doc in full, on every
  // recompute) never pays for them. Same rationale as conversation_git_diffs.
  conversation_context: defineTable({
    conversation_id: v.id("conversations"),
    // StableContextData JSON snapshot — see conversations.stable_context
    // (legacy location) and recordStableContext.
    stable_context: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  conversation_git_diffs: defineTable({
    conversation_id: v.id("conversations"),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    // `git status` text captured at session start. Lives here, not on the
    // conversation doc, for the same reason as the diffs: the inbox scan reads
    // every candidate doc in full and never renders this.
    git_status: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  public_conversations: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    preview_text: v.string(),
    agent_type: v.string(),
    message_count: v.number(),
    created_at: v.number(),
    view_count: v.number(),
  }),

  messages: defineTable({
    conversation_id: v.id("conversations"),
    from_user_id: v.optional(v.id("users")),
    message_uuid: v.optional(v.string()),
    // Source ordering prevents an older durable retry from overwriting a newer
    // projection of the same logical message. Legacy clients omit both fields.
    source_device_id: v.optional(v.string()),
    source_revision: v.optional(v.number()),
    // Conversation-scoped server watermark at which this row last changed.
    transcript_revision: v.optional(v.number()),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool"),
    ),
    content: v.optional(v.string()),
    encrypted_content: v.optional(v.string()),
    is_encrypted: v.optional(v.boolean()),
    thinking: v.optional(v.string()),
    // A hosted message's thinking signature lives in message_thinking, and its
    // unredacted tool call arguments in message_tool_inputs (hostedReplay.ts).
    tool_calls: v.optional(
      v.array(
        v.object({
          id: v.string(),
          name: v.string(),
          input: v.string(),
        }),
      ),
    ),
    tool_results: v.optional(
      v.array(
        v.object({
          tool_use_id: v.string(),
          content: v.string(),
          is_error: v.optional(v.boolean()),
        }),
      ),
    ),
    images: v.optional(
      v.array(
        v.object({
          media_type: v.string(),
          data: v.optional(v.string()),
          storage_id: v.optional(v.id("_storage")),
          tool_use_id: v.optional(v.string()),
        }),
      ),
    ),
    // Files the agent handed to the human with SendUserFile. Separate from
    // images because these are DELIVERIES, not screenshots the agent looked at:
    // each one is a document the person is meant to open, so it carries its own
    // name, size and caption, and the client renders a card, not a picture. A
    // row with `error` and no storage_id is a delivery that could not be
    // carried (too large, gone, upload failed) — kept, so the card can say so.
    files: v.optional(
      v.array(
        v.object({
          name: v.string(),
          media_type: v.string(),
          size: v.optional(v.number()),
          storage_id: v.optional(v.id("_storage")),
          tool_use_id: v.optional(v.string()),
          caption: v.optional(v.string()),
          display: v.optional(v.string()),
          error: v.optional(v.string()),
        }),
      ),
    ),
    subtype: v.optional(v.string()),
    client_id: v.optional(v.string()),
    // Model that generated this assistant turn (from the agent transcript),
    // e.g. "claude-opus-4-8". Conversations can switch models mid-stream, so
    // this is per-message; conversations.model is only the last-known value.
    model: v.optional(v.string()),
    timestamp: v.number(),
    tokens_used: v.optional(v.number()),
    usage: v.optional(
      v.object({
        input_tokens: v.number(),
        output_tokens: v.number(),
        cache_creation_input_tokens: v.optional(v.number()),
        cache_read_input_tokens: v.optional(v.number()),
      }),
    ),
    embedding: v.optional(v.array(v.float64())),
    // True on a row the message navigator lists (isNavigableUserMessage),
    // absent otherwise. Written at every insert and patch through
    // navPromptField/navPromptPatch, so getUserMessages reads prompts off
    // by_conversation_nav_prompt instead of scanning the user-role range,
    // which is mostly tool results.
    nav_prompt: v.optional(v.literal(true)),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_timestamp", ["conversation_id", "timestamp"])
    .index("by_conversation_uuid", ["conversation_id", "message_uuid"])
    .index("by_conversation_client_id", ["conversation_id", "client_id"])
    .index("by_message_uuid", ["message_uuid"])
    .index("by_timestamp", ["timestamp"])
    .index("by_conversation_role_timestamp", [
      "conversation_id",
      "role",
      "timestamp",
    ])
    .index("by_conversation_nav_prompt", [
      "conversation_id",
      "nav_prompt",
      "timestamp",
    ])
    .searchIndex("search_content_v2", {
      searchField: "content",
      filterFields: ["conversation_id"],
    }),

  // Recent-window mirror of message text for content search (see
  // searchMirror.ts). search_content_v2 above scans its whole posting list per
  // term across every message ever written, so common tokens exceed the query
  // budget; this table holds only the trailing window, making the scan small
  // by construction. Rows are written solely by the searchMirror cron walker.
  message_search_recent: defineTable({
    message_id: v.id("messages"),
    conversation_id: v.id("conversations"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool"),
    ),
    content: v.string(),
    timestamp: v.number(),
    tool_calls_count: v.optional(v.number()),
    tool_results_count: v.optional(v.number()),
    // _creationTime of the SOURCE message — the window/GC axis. Distinct from
    // `timestamp` (client event time): imported old transcripts get fresh
    // creation times and should be searchable, not instantly GC'd.
    source_created_at: v.number(),
    // Owner/team of the conversation at mirror time, for SCOPED search
    // lookups (fetchMessageSearchPool): the global BM25 pool truncates at 512
    // rows BEFORE visibility filtering, so one user's term-heavy private
    // sessions can starve everyone else's hits out of the pool entirely.
    // Scoped lookups make the caller's own (and their teams') rows immune to
    // that flood. Stamps are snapshots — visibility is still enforced
    // post-pool against the live conversation doc, so a stale team_id costs
    // recall only, never leaks.
    user_id: v.optional(v.id("users")),
    team_id: v.optional(v.id("teams")),
  })
    .index("by_message_id", ["message_id"])
    .index("by_source_created_at", ["source_created_at"])
    // "_r2" because renaming a search index is convex's drop-and-rebuild: the
    // original "search_content" segment set was damaged beyond compaction
    // (2026-08-10 mass-patch incident — a segment blob went missing and the
    // TextCompactor crash-looped on it). Prod no longer carries the original
    // index — do NOT re-declare it (that re-creates it and forces a ~636k-doc
    // backfill).
    .searchIndex("search_content_r2", {
      searchField: "content",
      filterFields: ["conversation_id", "team_id", "user_id"],
    }),

  // Single row: the searchMirror walker's watermark. `cursor` = _creationTime
  // of the last mirrored message. Patched EVERY cron tick — nothing that a
  // subscribed query reads may live here (reactivity: reading this row would
  // re-run every open search each tick).
  search_mirror_state: defineTable({
    cursor: v.number(),
    // The fresh walk's position (searchMirror.ts): new messages are copied
    // seconds after they land, ahead of the settle walk at `cursor`.
    fresh_cursor: v.optional(v.number()),
    updated_at: v.number(),
  }),

  // Singleton: _creationTime position of the daemon_logs retention sweep
  // (advanceLogPrune). Same pattern and same reactivity warning as
  // search_mirror_state above — patched on every prune tick, so no subscribed
  // query may read it.
  log_prune_state: defineTable({
    cursor: v.number(),
    updated_at: v.number(),
  }),

  // Single row, read by fetchMessageSearchPool: is the mirror serveable? The
  // walker writes it ONLY when liveness transitions (with hysteresis), so open
  // search subscriptions stay stable across cron ticks.
  search_mirror_live: defineTable({
    live: v.boolean(),
  }),

  // Story & Summary densities. Both are chunked first-person retellings cached
  // as JSON. `story` is an array of beats (each spans several turns); `summary`
  // is a coarser array of phases built by grouping the beats. Each level tracks
  // the message_count it was built at so the client knows when to regenerate.
  // Kept out of the conversations table so list queries don't carry the markdown.
  conversation_summaries: defineTable({
    conversation_id: v.id("conversations"),
    story: v.optional(v.string()),
    summary: v.optional(v.string()),
    story_message_count: v.optional(v.number()),
    summary_message_count: v.optional(v.number()),
    // Legacy field from the first (per-conversation single-summary) design.
    // Tolerated so old rows validate; superseded by the per-level counts above.
    message_count: v.optional(v.number()),
    generated_at: v.number(),
    model: v.optional(v.string()),
  }).index("by_conversation_id", ["conversation_id"]),
};

export const messageCommentTables = {
  // History: conversation comments written before 2026-11-03. Nothing writes
  // this table; every comment, these included, is read and written through
  // its review_comments row (commentStore.ts).
  comments: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
    user_id: v.id("users"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("comments")),
    created_at: v.number(),
    github_comment_id: v.optional(v.number()),
    pr_id: v.optional(v.id("pull_requests")),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    // The commented line's text with two lines of context, to find it again
    // after the code moves (packages/comments/src/codeAnchor.ts).
    anchor_lines: v.optional(codeAnchorValidator),
    // Agent-reply comments: an opt-in "ask the agent to reply" spawns a hidden
    // fork whose answer is mirrored back into this comment. author_kind="agent"
    // renders it as the agent; agent_status tracks the reply lifecycle; the fork
    // it came from is recorded for traceability.
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    agent_status: v.optional(
      v.union(
        v.literal("thinking"),
        v.literal("streaming"),
        v.literal("done"),
        v.literal("error"),
      ),
    ),
    fork_conversation_id: v.optional(v.id("conversations")),
    // Thread resolution (GitHub-style). Stamped on EVERY comment of a thread
    // when resolved, so "open" is simply "has an unstamped comment" — a reply
    // posted after resolution reopens the thread with no root bookkeeping.
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    // Client-generated id for the optimistic store flow: the inboxStore stub
    // carries it as altKey so the synced server row supersedes the stub, and the
    // server dedups on it so a dispatch-outbox retry can't double-insert.
    client_id: v.optional(v.string()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"]),

  // Retired: no function reads or writes it. Kept until confirmed empty.
  public_comments: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("public_comments")),
    created_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),
};

export const messagePayloadTables = {
  // The before/after text of one file change, split from its file_changes row
  // (fileChangeBodies.ts). Read by change_key on demand: the web asks for the
  // few changes a fold needs, never a conversation's whole history.
  // The API's signature over a hosted assistant message's thinking (plan
  // pl-840), one row per message that has one. Resuming a turn that thought
  // before a tool call must replay the thinking signed and unchanged, so the
  // turn engine reads these; no client does, which is why they sit here and
  // not on the message row every transcript query ships. `redacted` marks
  // thinking the API encrypted, whose payload is the signature.
  message_thinking: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    signature: v.string(),
    redacted: v.optional(v.boolean()),
  }).index("by_conversation_message", ["conversation_id", "message_id"]),

  // A hosted assistant message's tool call arguments as the model wrote them,
  // for each call whose stored arguments redaction changed. Server only: the
  // turn engine replays and runs approved calls with these (hostedReplay.ts),
  // while the message row clients read keeps the redacted form.
  message_tool_inputs: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    inputs: v.array(v.object({ id: v.string(), input: v.string() })),
  }).index("by_conversation_message", ["conversation_id", "message_id"]),
};

export const conversationImageTables = {
  // Every image in a conversation, materialized at message ingest
  // (materializeConversationImages in messages.ts). The header gallery reads
  // this instead of scanning the loaded message window, so its list covers the
  // whole thread no matter how few pages are loaded. image_key = the storage id
  // or the markdown src — the same identity extractSessionImages dedupes on —
  // so a re-synced message upserts instead of duplicating a row.
  // Inline base64 (data:) images are deliberately NOT materialized: the payload
  // is the identity, and an index table is no place for it. The client window
  // extraction still surfaces those, and the merge folds them in.
  conversation_images: defineTable({
    conversation_id: v.id("conversations"),
    image_key: v.string(),
    storage_id: v.optional(v.id("_storage")),
    src: v.optional(v.string()),
    message_id: v.id("messages"),
    // Position within the message, so two images in one turn keep their order.
    seq: v.number(),
    timestamp: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_image_key", ["conversation_id", "image_key"]),
};

export const linkPreviewTables = {
  // What a web page says about itself (Open Graph, Twitter card, <title>),
  // read once and shared by every message that links it, so a link standing
  // alone on its line renders as a preview card. Keyed by the URL as
  // parseLinkPreviewUrl normalizes it. `status` "pending" while the fetch
  // runs; "failed" keeps a dead or tagless page from being refetched on
  // every view until the row ages out (linkPreviews.ts).
  link_previews: defineTable({
    url: v.string(),
    status: v.union(v.literal("pending"), v.literal("ok"), v.literal("failed")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    site_name: v.optional(v.string()),
    favicon: v.optional(v.string()),
    requested_at: v.number(),
    fetched_at: v.optional(v.number()),
  }).index("by_url", ["url"]),
};
