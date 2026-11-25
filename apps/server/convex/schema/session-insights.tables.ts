import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sessionPatternTables = {
  decisions: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    project_path: v.optional(v.string()),
    title: v.string(),
    rationale: v.string(),
    alternatives: v.optional(v.array(v.string())),
    session_id: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    message_index: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    // The repository the decision governs ("owner/name", getRepoKeyFromRemote)
    // and the paths in it, repo-relative files or directories ending in "/".
    // `cast decisions --touching` matches a diff against these, so a reviewer
    // finds the decisions a change could break.
    repo: v.optional(v.string()),
    files: v.optional(v.array(v.string())),
    // A later decision that reversed this one. A superseded decision binds
    // nothing; it stays for the history.
    superseded_by: v.optional(v.id("decisions")),
    // "automatic" when consolidated from a session insight (projectMemory.ts);
    // absent when a person or agent recorded it with `cast decisions add`.
    source: v.optional(v.literal("automatic")),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .searchIndex("search_decisions_v2", {
      searchField: "title",
      filterFields: ["user_id", "project_path"],
    }),

  patterns: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    name: v.string(),
    description: v.string(),
    content: v.string(),
    source_session_id: v.optional(v.string()),
    source_conversation_id: v.optional(v.id("conversations")),
    source_range: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    usage_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_name", ["user_id", "name"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .searchIndex("search_patterns_v2", {
      searchField: "name",
      filterFields: ["user_id"],
    }),
};

export const sessionInsightTables = {
  // Side answers (`/btw` in the composer, sideAnswers.ts): one person's
  // question about a conversation, answered by the cheap model over its synced
  // transcript and never sent to the agent. Private to the asker; readable only
  // while the asker can still read the conversation. `client_id` is the id the
  // composer's optimistic row carried, so the server row supersedes it.
  side_answers: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    client_id: v.string(),
    question: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("failed"),
    ),
    answer: v.optional(v.string()),
    citations: v.optional(
      v.array(v.object({ line: v.number(), message_id: v.string() })),
    ),
    unread: v.optional(v.object({ after: v.number(), before: v.number() })),
    error_code: v.optional(v.string()),
    error_message: v.optional(v.string()),
    created_at: v.number(),
    answered_at: v.optional(v.number()),
  })
    .index("by_conversation_user", ["conversation_id", "user_id", "created_at"])
    .index("by_user", ["user_id"])
    .index("by_client_id", ["client_id"]),

  session_insights: defineTable({
    conversation_id: v.id("conversations"),
    team_id: v.optional(v.id("teams")),
    actor_user_id: v.id("users"),
    source: v.union(
      v.literal("idle"),
      v.literal("commit"),
      v.literal("manual"),
      v.literal("periodic"),
    ),
    generated_at: v.number(),
    summary: v.string(),
    headline: v.optional(v.string()),
    key_changes: v.optional(v.array(v.string())),
    timeline: v.optional(
      v.array(
        v.object({
          t: v.string(),
          event: v.string(),
          type: v.string(),
          session_title: v.optional(v.string()),
        }),
      ),
    ),
    turns: v.optional(
      v.array(
        v.object({
          ask: v.string(),
          did: v.array(v.string()),
        }),
      ),
    ),
    goal: v.optional(v.string()),
    what_changed: v.optional(v.string()),
    outcome_type: v.union(
      v.literal("shipped"),
      v.literal("progress"),
      v.literal("blocked"),
      v.literal("unknown"),
    ),
    blockers: v.optional(v.array(v.string())),
    next_action: v.optional(v.string()),
    themes: v.array(v.string()),
    confidence: v.optional(v.number()),
    // Where the human redirected the agent, and the choices the session took:
    // the raw material project memory consolidates.
    corrections: v.optional(
      v.array(v.object({ said: v.string(), instead: v.string() })),
    ),
    decisions: v.optional(
      v.array(v.object({ title: v.string(), why: v.string() })),
    ),
    metadata: v.optional(
      v.object({
        commit_shas: v.optional(v.array(v.string())),
        pr_numbers: v.optional(v.array(v.number())),
        files_touched: v.optional(v.array(v.string())),
      }),
    ),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_team_generated_at", ["team_id", "generated_at"])
    .index("by_actor_generated_at", ["actor_user_id", "generated_at"]),

  // One row per conversation: the composer's suggested replies, generated
  // against a specific tail message (anchor). Storing them (rather than
  // returning from the action) makes them reactive and shared across the
  // owner's devices, and the anchor doubles as the dedupe key — same anchor,
  // no regeneration. An empty suggestions array is a valid, stored outcome:
  // "the model looked and found nothing confident", which must also not retry.
  composer_suggestions: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    anchor_message_uuid: v.string(),
    suggestions: v.array(v.string()),
    generated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  // Append-only record of what the person did with the suggestion shown for
  // one agent turn: sent it as-is, edited it first, or passed it over for
  // their own words ("dismissed" is a retired literal on old rows). It holds
  // no text of theirs: what they sent is read from the transcript after the
  // anchor (getRecentOutcomes), so deleting or redacting the session reaches
  // it. Rows belong to their conversation (conversationRows) and account
  // (accountDelete).
  suggestion_outcomes: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    anchor_message_uuid: v.string(),
    // The suggestion taken; for "ignored", the one on show when they typed.
    suggestion: v.string(),
    outcome: v.union(
      v.literal("sent"),
      v.literal("edited"),
      v.literal("ignored"),
      v.literal("dismissed"),
    ),
    // What was offered for the turn. Absent on rows recorded before Nov 2026,
    // which never reported "ignored" and so stay out of the take rate.
    shown: v.optional(v.array(v.string())),
    // How many trailing characters of the sent message the person typed (a
    // count, not the words): what the composer folded in ahead of them, such
    // as quotes and proposal answers, is not theirs.
    typed_length: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_user_created", ["user_id", "created_at"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_created", ["created_at"]),

  // Per-user mined composer-input corpus: how this user actually talks to
  // their agents. `phrases` are recurring multi-word fragments mined across
  // inputs (each counted once per message); `frequent` is repeated whole
  // multi-word inputs; `recent` preserves the newest inputs in order for
  // style evidence. Refreshed lazily by the suggestions action past its TTL.
  suggestion_profiles: defineTable({
    user_id: v.id("users"),
    frequent: v.array(v.object({ text: v.string(), count: v.number() })),
    phrases: v.optional(
      v.array(v.object({ text: v.string(), count: v.number() })),
    ),
    // Generalized habits mined by LLM: what the user recurrently asks for,
    // abstracted from topic ("demands e2e verification before accepting
    // work"), with one real quote as voice evidence. The suggester APPLIES
    // these to the current conversation instead of replaying old messages.
    patterns: v.optional(
      v.array(
        v.object({
          pattern: v.string(),
          example: v.string(),
          count: v.number(),
        }),
      ),
    ),
    // Reusable prompts mined by LLM: full-text directives the user resends
    // across sessions near-verbatim ("you are a world class product
    // engineer… do another 10 rounds"). Unlike pattern examples these are
    // MEANT to be replayed, adapted to the current conversation.
    prompts: v.optional(
      v.array(
        v.object({
          text: v.string(),
          count: v.number(),
        }),
      ),
    ),
    recent: v.array(v.string()),
    generated_at: v.number(),
  }).index("by_user_id", ["user_id"]),
};

export const projectMemoryTables = {
  // An explicit decision an agent hands to its human: one question, real
  // options, and enough context to choose without opening the session. Written
  // by `cast decide`; consumed by the web decision queue. The web answers
  // client-side through the normal message send pipeline; a server-side answer
  // (`cast decide answer`, a role under a grant, a stack auto default) delivers
  // through finalizeAnswer in sessionDecisions.ts.
  //
  // W2 (docs/architecture/decisions-as-documents.md D1): a decision is a
  // document with rich options, routed through the org as a race, bound to a
  // task and station, grouped into stacks.
  // Corrections and decisions consolidated per project from session insights,
  // in plain code (no inference). `workspace` is ACCESS, `team_id` is ROUTING
  // (see CLAUDE.md "Workspace access vs routing"); reads are one equality on
  // by_workspace_project. A row is promoted once seen in 2+ sessions or 3+ times.
  project_memory: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    user_id: v.id("users"),
    project_path: v.string(),
    kind: v.union(v.literal("correction"), v.literal("decision")),
    text: v.string(),
    detail: v.optional(v.string()),
    count: v.number(),
    first_seen: v.number(),
    last_seen: v.number(),
    conversation_ids: v.array(v.id("conversations")),
    promoted: v.boolean(),
  }).index("by_workspace_project", ["workspace", "project_path"]),
};
