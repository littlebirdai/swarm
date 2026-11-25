import { defineTable } from "convex/server";
import { v } from "convex/values";
import { chatRoundValidator } from "../lib/chatRoundValidator";
import { externalAuthorValidator } from "../lib/externalAuthor";
import { chatAttachmentValidator } from "../lib/chatAttachment";

export const chatTables = {
  // ── Team chat ───────────────────────────────────────────────────────────────
  // A Slack-shaped chat inside codecast: channels, private channels, DMs, flat
  // threads, mentions, reactions, read state. Five tables, all routed to ONE
  // team.
  //
  // Scope notes:
  //  - A public channel (kind absent) is visible to every member of its team.
  //    Private channels and DMs gate on `chat_channel_members` rows on top of
  //    the team check — `canAccessChannel` (chatAccess.ts) is the one gate for all
  //    three kinds, and every read and write goes through it.
  //  - Nothing here denormalizes a counter onto a shared row. `last_message_at`
  //    and `message_count` on the channel would make EVERY member a writer of the
  //    same document on every send — the hot-document pattern that has cost this
  //    database three incidents, and that terminal_frames is explicitly allowed to
  //    skip only because it "has exactly one writer". The channel rail instead
  //    reads one row per channel off `by_channel_created` descending, which gives
  //    the sort key and the preview text together.
  //  - Thread rollups ("3 replies", participant faces) are derived the same way,
  //    from `by_thread_created`, so a reply never re-versions the fattest row in
  //    the table and a tombstoned reply cannot leave a stale count behind.
  //
  // The three PATCHED tables — channels, messages, reads — carry `updated_at`
  // and EVERY patch must bump it. The web store's sync layer keeps the previous
  // object identity when no *scalar* field changed
  // (syncProtocol.scalarFieldsEqual deliberately skips arrays and objects), so a
  // patch that only touches `mentions` or `attachments` would be silently
  // dropped on the way to the UI. chat.ts funnels all writes through `patchChat`
  // so this cannot be forgotten, and its signature admits exactly those three
  // table ids. `chat_reactions` is insert-or-delete only and carries no
  // `updated_at`: there is no patch to bump.

  chat_channels: defineTable({
    // ROUTING only — which team's chat surface this room appears in. Access is
    // decided by `kind` + membership, never by this field (the locked contract:
    // team_id routes, a separate access answer gates).
    team_id: v.id("teams"),
    // Slug, lowercase, unique per team on a best-effort basis only. Routing is by
    // _id — two concurrent creates can both pass the uniqueness read, so a name
    // must never be the thing that resolves to a channel row.
    // For a DM the name is "" — identity is the member set, and the client
    // renders the other side's names instead.
    name: v.string(),
    // Absent = "public" (every pre-membership channel). "private" and "dm" are
    // readable/writable only by their chat_channel_members rows. A DM is a
    // private room whose member set IS its identity: no name, no rename, no
    // invite affordance beyond group-DM creation.
    // "agents" is a public room whose expected posters are roles and sessions
    // (docs/architecture/agent-channels.md C1): same access as "public", the
    // people in it default to notify level "mentions", agents are capped per
    // day (chat_agent_quota).
    // "community" is the public face of the product: readable by anyone,
    // signed in or not, and writable by every signed-in codecast user, member
    // of the routing team or not. Only the one team flagged `community` may
    // hold one (createChannel), and only its admins may open, rename or
    // archive one — every other member of the public is a poster, never a
    // manager. Listed by `by_kind_name` because the audience has no team.
    kind: v.optional(
      v.union(
        v.literal("public"),
        v.literal("private"),
        v.literal("dm"),
        v.literal("agents"),
        v.literal("community"),
      ),
    ),
    // ACCESS, workspaceKey-shaped: "team:<id>" for public, "restricted:<own id>"
    // for private/dm, "public" for community. Stamped so the workspace
    // redesign's predicate can adopt chat without a migration; chat's own gate
    // is canAccessChannel.
    workspace: v.optional(v.string()),
    // Sorted member ids joined with ":" — the openDm idempotency key, so opening
    // the same conversation twice finds the same room. Set only when kind="dm".
    dm_key: v.optional(v.string()),
    topic: v.optional(v.string()),
    // The channel a new team member lands in. Team admins only.
    is_default: v.optional(v.boolean()),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
    // null, not field-removal, when restored: a client's delta sync cannot see
    // an ABSENT field (absence means "no information" in an overlay), so a
    // restore that deletes the field leaves every client archived forever.
    archived_at: v.optional(v.union(v.number(), v.null())),
    // Optimistic-create altKey: the store writes a `chatstub-…` row carrying this
    // and the server row supersedes it when it syncs back.
    client_id: v.optional(v.string()),
  })
    // Prefix-matches serve "every channel in this team", so no separate by_team.
    .index("by_team_name", ["team_id", "name"])
    .index("by_client_id", ["client_id"])
    .index("by_dm_key", ["dm_key"])
    // The community rail: every channel the public can read, with no team to
    // key on. Nothing else queries by kind.
    .index("by_kind_name", ["kind", "name"]),

  // Who is inside a private channel or DM — the session_owners shape: one row
  // per (channel, member), provenance on the row, membership checked on
  // by_channel_user. Public channels have NO rows here; their audience is the
  // team, and writing rows for them would create a second membership model that
  // could disagree with the first.
  chat_channel_members: defineTable({
    channel_id: v.id("chat_channels"),
    user_id: v.id("users"),
    added_by: v.id("users"),
    added_at: v.number(),
  })
    // "Which private rooms am I in" — the rail merge for private/dm channels.
    .index("by_user", ["user_id"])
    // Roster of one room (member list, DM name derivation, notification fan-out).
    .index("by_channel", ["channel_id"])
    // The membership check and the add/remove dedupe.
    .index("by_channel_user", ["channel_id", "user_id"]),

  // The roles and sessions inside a room (agent-channels.md C5), on any kind
  // but a DM. Membership is delivery: every line a PERSON posts reaches each
  // member as one pending line; agents' lines reach members only through
  // mentions, so two members cannot wake each other in a loop. Exactly one of
  // role_id / conversation_id is set. `short_id` is the role's or-N or the
  // session's short id, copied at add time so the rail can name the member
  // without reading the churning conversation row.
  chat_channel_agents: defineTable({
    channel_id: v.id("chat_channels"),
    role_id: v.optional(v.id("org_roles")),
    conversation_id: v.optional(v.id("conversations")),
    short_id: v.string(),
    added_by: v.id("users"),
    added_at: v.number(),
  })
    .index("by_channel", ["channel_id"])
    .index("by_role", ["role_id"])
    .index("by_conversation", ["conversation_id"]),

  // The DMs (or one thread of a DM) a session, or a role for its standing
  // session and hands, was brought into by chat: a person's mention, a
  // relayed reply, a hand-off.
  // What lets a session read a DM with its person's token (chatAccess
  // sessionChatScope); written only for kind "dm" rooms.
  chat_session_rooms: defineTable({
    channel_id: v.id("chat_channels"),
    conversation_id: v.optional(v.id("conversations")),
    role_id: v.optional(v.id("org_roles")),
    // Set when the grant is one thread's (a reply relayed into the session
    // that started it); absent for the whole room (a person's @mention, a
    // hand-off).
    thread_root_id: v.optional(v.id("chat_messages")),
    via: v.union(
      v.literal("wake"),
      v.literal("mention"),
      v.literal("relay"),
      v.literal("backfill"),
    ),
    created_at: v.number(),
  })
    .index("by_conversation_channel", [
      "conversation_id",
      "channel_id",
      "thread_root_id",
    ])
    .index("by_role_channel", ["role_id", "channel_id", "thread_root_id"])
    .index("by_channel", ["channel_id"]),

  chat_messages: defineTable({
    // Denormalized from the channel so scope checks and the search index don't
    // need a second read. Derived on insert, never a mutation argument.
    team_id: v.id("teams"),
    channel_id: v.id("chat_channels"),
    // Threads are FLAT, like Slack's: a reply points at the ROOT message and a
    // root leaves this absent. Never set it to the row's own id — the thread view
    // reads the root by id and the replies by index, and a self-reference would
    // put the root in both halves.
    thread_root_id: v.optional(v.id("chat_messages")),
    // Slack's "also send to #channel": a thread reply that ALSO shows in the
    // channel timeline. Only meaningful with thread_root_id set — the channel
    // list includes replies carrying this flag, and nothing else changes: the
    // row still lives in its thread, still counts in the rollup.
    broadcast: v.optional(v.boolean()),
    // The author. For an anchor's reply this is the anchor's `bot_user_id`.
    user_id: v.id("users"),
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    content: v.string(),
    // Resolved SERVER-side by parsing `content` against the team roster. Never a
    // caller argument: a client-supplied id array is a notification cannon.
    // Three shapes in one array (@codecast/chat ChatMentionRef): a bare
    // user id is a person (every row written before roles and sessions could be
    // named is this shape alone), an object is a role (`@<handle>`, org_roles),
    // a session (`@<7-char short id>`, conversations), or a person who exists
    // only in the mirrored Slack workspace (`@<Slack handle>`, slack_users):
    // paged in Slack by the line's mirror, named here by the snapshot.
    mentions: v.optional(
      v.array(
        v.union(
          v.id("users"),
          v.object({
            kind: v.literal("role"),
            role_id: v.id("org_roles"),
            short_id: v.string(),
            handle: v.string(),
          }),
          v.object({
            kind: v.literal("session"),
            conversation_id: v.id("conversations"),
            short_id: v.string(),
          }),
          v.object({
            kind: v.literal("slack"),
            user: v.string(),
            handle: v.string(),
            name: v.string(),
          }),
        ),
      ),
    ),
    // A role or session this line named was NOT woken: the sender or the target
    // was over its hourly mention cap (agent-channels.md C2). The mention still
    // renders as a pill and the line stays in the thread; nothing redelivers it.
    mention_folded: v.optional(v.boolean()),
    // "here" notifies the members who are actually present (user_presence).
    // `@channel` is deliberately absent in v1 — on a team small enough to share
    // one codecast workspace it is the same blast radius with worse manners.
    mention_scope: v.optional(v.literal("here")),
    attachments: v.optional(v.array(chatAttachmentValidator)),
    // Push-to-talk. Present only on a walkie burst, which is an ordinary chat
    // message written in three steps: created "live" while the sender holds the
    // key, transcript streaming into `content`, then finalized with the audio.
    // The audio is a NORMAL attachment above (mime audio/webm) — a voice message
    // is a message with a recording, not a second kind of row, so playback,
    // search, permalinks and threads need nothing new. See
    // @codecast/chat isLiveVoiceRow: a live row renders but has not
    // notified, so it counts for nothing until it is done.
    voice: v.optional(
      v.object({
        status: v.union(
          v.literal("live"),
          v.literal("done"),
          v.literal("canceled"),
        ),
        duration_ms: v.optional(v.number()),
        // The call room the burst was spoken into, so a teammate who sees it can
        // join the conversation. A join still runs through authorizeRoom, so this
        // string grants nothing on its own.
        room_key: v.optional(v.string()),
        // The words are being recovered from the recording right now. Set when a
        // burst lands carrying audio and no transcript — the live recognizer was
        // down, or heard nothing — and cleared by the action that transcribes it.
        // The bubble reads it to say "getting the words" instead of showing a
        // finished voice note that looks like it was said in silence.
        transcribing: v.optional(v.boolean()),
      }),
    ),
    // A huddle digest: the row a finished huddle leaves in the room it was held
    // in (transcripts.setSummary → chat.postCallDigest). `content` holds the
    // summary markdown so every client paints it from the row; this names the
    // transcript so the web can unfold the whole speaker-attributed transcript
    // inline. Written by the server only, as the scribe, once per transcript.
    call: v.optional(
      v.object({
        transcript_id: v.id("transcripts"),
      }),
    ),
    // Optimistic altKey AND the server's send-dedupe key: a retried send with the
    // same client_id returns the existing row instead of inserting a twin (and,
    // critically, does not wake the anchor a second time).
    client_id: v.optional(v.string()),
    // "agent" = this line was typed by a codecast session running as its human
    // host, not by the human. The author is still that human (`user_id`), so it
    // is not `author_kind` — that word is reserved for the anchor's own replies.
    // It exists so the anchor wake path can refuse to run a billed turn on
    // somebody's laptop because a machine asked for one. Self-declared by the
    // CLI, so it is an honest downgrade rather than a boundary: a caller who
    // omits it is treated exactly as a human, which is what it already was.
    origin: v.optional(v.literal("agent")),
    // Which session typed it, when `origin` is "agent" — so the line renders as
    // that session (agent logo + session title) instead of wearing the human's
    // face for words a machine wrote. Title/agent_type are a send-time snapshot,
    // taken server-side only when the sender OWNS the session (a caller-supplied
    // id must not leak someone else's private title into a channel). A viewer
    // who can see the session live shows its current title instead; the
    // snapshot is the fallback for everyone else.
    origin_session_id: v.optional(v.string()),
    origin_session_title: v.optional(v.string()),
    origin_agent_type: v.optional(v.string()),
    // The session the sender had open when they wrote the line (the chat
    // beside a conversation), so the room reads which thread it is about.
    // Kept only when the sender can read that session; readers resolve it
    // through their own access, so it names nothing they could not open.
    context_session_id: v.optional(v.id("conversations")),
    created_at: v.number(),
    updated_at: v.number(),
    edited_at: v.optional(v.number()),
    // Tombstone rather than a delete, so replies keep their root and a thread
    // count stays honest.
    deleted_at: v.optional(v.number()),
    // Anchor reply lifecycle. thinking/streaming/done/error are the visible
    // states the comment thread already uses. "listening" is a SILENT
    // placeholder: a reply in a thread the anchor follows woke it without
    // addressing it, and the anchor decides whether to speak; "passed" is its
    // decision to stay quiet. Neither renders anywhere and neither counts as a
    // reply — see @codecast/chat isSilentAgentRow. A session handed a
    // chat line gets a "thinking" row of its own (chatSessionReplies), closed
    // as a "passed" tombstone when it answers elsewhere or not at all.
    agent_status: v.optional(
      v.union(
        v.literal("thinking"),
        v.literal("streaming"),
        v.literal("done"),
        v.literal("error"),
        v.literal("listening"),
        v.literal("passed"),
      ),
    ),
    // Which anchor owns this placeholder. `chat.replyAsAnchor` requires the row to
    // name an anchor, the row's author to BE that anchor's bot identity, and the
    // caller to be authorized for that anchor — otherwise any api_token holder
    // could overwrite any message and author content under the bot's face.
    agent_anchor_id: v.optional(v.id("anchors")),
    // When the wake's deadline will declare the answer missing. Lets the client
    // show an honest countdown on the thinking row instead of a bare shimmer.
    agent_deadline_at: v.optional(v.number()),
    // Thread-level switch for the anchor, set on the thread ROOT only. Absent
    // means the default: the anchor answers a plain reply in a thread it is
    // already part of, so asking a follow-up does not mean re-typing its name.
    // `false` is a member saying stop — nothing but an explicit @mention wakes it
    // in that thread again (and that mention flips this back to true).
    anchor_follow: v.optional(v.boolean()),
    // A room's agent members taking turns on this thread (chatRounds.ts), set
    // on the thread ROOT only. One member holds the floor at a time and is
    // handed the whole thread so far; the next is woken when it answers,
    // passes (its turn ends without a reply here), or is skipped.
    round: v.optional(chatRoundValidator),
    fork_conversation_id: v.optional(v.id("conversations")),
    // The session a person handed this thread to (chatHandoff.ts), set on the
    // thread ROOT only. Replies route to it ahead of origin_session_id, and the
    // thread shows it live. A later hand replaces it.
    bound_session_id: v.optional(v.string()),
    // Slack provenance (slackSync). "inbound": the line was written in Slack and
    // mirrored here; `client_id` is then the derived `slack:<workspace>:<channel>:<ts>`
    // key, so the existing by_channel_client_id index is the lookup for the edit,
    // delete and reaction events that follow. "outbound": a codecast line the
    // bridge posted into Slack; `ts` is stamped after the post and is what stops
    // the echo (the event Slack sends for our own post is dropped by bot identity,
    // and a replay maps to a row we already hold).
    external: v.optional(
      v.object({
        provider: v.literal("slack"),
        direction: v.union(v.literal("inbound"), v.literal("outbound")),
        workspace: v.string(),
        channel: v.string(),
        ts: v.string(),
        thread_ts: v.optional(v.string()),
        user: v.optional(v.string()),
        permalink: v.optional(v.string()),
        synced_at: v.number(),
      }),
    ),
    // Who really wrote an inbound Slack line, when the author could not be matched
    // to a codecast account and `user_id` is the workspace's bridge identity. A
    // snapshot at sync time: the UI shows this name and face, never the bridge's.
    external_author: v.optional(externalAuthorValidator),
    // The author kept this line out of the channel's Slack mirror (composer
    // toggle). Absent means "follow the link's rules".
    sync_local_only: v.optional(v.boolean()),
  })
    .index("by_channel_created", ["channel_id", "created_at"])
    // A sender's newest lines across the team: chat search's "from:@person"
    // with no words.
    .index("by_team_user_created", ["team_id", "user_id", "created_at"])
    .index("by_thread_created", ["thread_root_id", "created_at"])
    .index("by_channel_client_id", ["channel_id", "client_id"])
    // A session's open "thinking" rows (chatSessionReplies): found when its
    // reply lands or its turn ends, without scanning the channel.
    .index("by_origin_session_status", ["origin_session_id", "agent_status"])
    // The open round whose floor a session holds: found when its turn ends.
    .index("by_round_floor_session", ["round.floor_session_id"])
    // A Slack event about a line WE posted (a reply under it, a reaction, an
    // edit) names our stamped ts, not the derived inbound client id, so the
    // outbound stamp needs its own lookup (slackSync.findMirroredRow).
    .index("by_channel_external_ts", ["channel_id", "external.ts"])
    // Team-scoped full-text search backs `chat.searchMessages`. A chat nobody can
    // search is a write-only log. The team filter keeps one team's results out of
    // another's; the caller's membership is still checked before the query runs.
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["team_id", "channel_id"],
    }),

  // Windowed counters behind the agent noise rules (agent-channels.md C2/C3):
  // how many lines a role or session posted in a channel today, how many thread
  // roots it started, how many mention wakes a sender caused or a target took
  // this hour. `key` names what is counted ("post:<channel>:<poster>",
  // "root:<channel>:<poster>", "mention_from:<user>", "mention_from:<user>:<session>"
  // for a mention reply charged to the replying session, "mention_to:<target>")
  // and `bucket` is the window it counts in (a UTC day "2026-09-12", an hour
  // "2026-09-12T14", or in a DM the person's latest line "since:<created_at>"). One row per (key, bucket); old buckets are simply never
  // read again. Separate from `rate_limits`, whose window is one minute.
  chat_agent_quota: defineTable({
    key: v.string(),
    bucket: v.string(),
    count: v.number(),
    updated_at: v.number(),
  }).index("by_key_bucket", ["key", "bucket"]),

  // Reactions are their own rows, NOT an array on the message.
  //
  // An inline array cannot survive the optimistic store: a pending field override
  // clears only when the echoed value is `===` the pending one, and Convex resends
  // arrays as fresh references, so the local value would mask the server's
  // forever. Worse, the patch collector reads the field name from the path and the
  // value from the patch, so a nested toggle would record the INNER array under
  // the outer field name and corrupt the row's shape locally.
  //
  // One row per (message, user, emoji) makes a toggle an insert or a delete, which
  // the pending machinery reconciles on presence, not on identity. It also takes
  // reactions off the message document entirely, so a popular message is not a
  // contended row.
  chat_reactions: defineTable({
    message_id: v.id("chat_messages"),
    // Denormalized so a reaction can be scoped/pruned with the channel without
    // re-reading its message.
    channel_id: v.id("chat_channels"),
    user_id: v.id("users"),
    emoji: v.string(),
    created_at: v.number(),
    // A reaction mirrored from Slack: the Slack person who made it. With no
    // codecast match, `user_id` is the workspace bridge and `external_author`
    // names the person, so two unmatched people are two reactions, not one.
    slack_user: v.optional(v.string()),
    external_author: v.optional(externalAuthorValidator),
  })
    .index("by_message", ["message_id"])
    // The toggle's own lookup: exactly one row may exist per (message, user,
    // emoji), and the server splices the CALLER's id in or out — a client can
    // never write another user's reaction.
    .index("by_message_user_emoji", ["message_id", "user_id", "emoji"])
    .index("by_channel", ["channel_id"]),

  // Per (user, channel): where they have read to, and how loudly the channel may
  // interrupt them. One writer per row — the owner — so no contention, and every
  // mutation derives the user from the authenticated caller rather than an
  // argument (a `user_id` argument would let anyone clear someone else's badge or
  // silently mute them).
  //
  // A missing row is meaningful: it means the member has never opened the channel,
  // which reads as notify level "mentions". The row appears the first time they
  // read or post, and that is also the signal the toast layer uses for "a channel
  // I am actually in".
  chat_reads: defineTable({
    user_id: v.id("users"),
    channel_id: v.id("chat_channels"),
    team_id: v.id("teams"),
    last_read_at: v.number(),
    last_read_message_id: v.optional(v.id("chat_messages")),
    notify_level: v.union(
      v.literal("all"),
      v.literal("mentions"),
      v.literal("none"),
    ),
    // Thread roots in this channel whose replies this member silenced
    // (@codecast/chat threadMute). Mentions still notify.
    muted_threads: v.optional(v.array(v.string())),
    joined_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    // Prefix-matches serve "all of my read state", so no separate by_user. There
    // is deliberately no by_channel index: a query over everyone's read state in a
    // channel is a read-receipt surface nobody asked for.
    .index("by_user_channel", ["user_id", "channel_id"]),

  // One row per (user, thread) across every threaded system: chat threads,
  // session comment threads, task comment streams and published page
  // discussions. Unread is one comparison: last_activity_at > last_read_at.
  // team_id is the entity's routing team; undefined is the personal inbox
  // (personal is a value, not a missing pointer). Bots never get a row.
  thread_reads: defineTable({
    user_id: v.id("users"),
    kind: v.union(
      v.literal("chat"),
      v.literal("comment"),
      v.literal("task"),
      v.literal("page"),
      v.literal("code"),
      v.literal("decision"),
    ),
    // chat: root chat_messages id. comment: `${conversation_id}:${anchorKey}`
    // where anchorKey is `msg:<message_id>` | `file:<path>:<line>` | `global`
    // (commentAnchorKey in @codecast/comments). task: task id.
    // page: artifact id (one card per page discussion). code:
    // `${repository}@${ref}#${anchorKey}` (codeThreadRootKey), one thread of
    // review_comments on a commit, a pull request head or a line of either.
    // decision: `decision:<session_decisions id>`, one thread per decision.
    root_key: v.string(),
    team_id: v.optional(v.id("teams")),
    last_activity_at: v.number(),
    last_read_at: v.number(),
    updated_at: v.number(),
    // Typed refs for access checks, payload loads and cleanup.
    channel_id: v.optional(v.id("chat_channels")),
    conversation_id: v.optional(v.id("conversations")),
    task_id: v.optional(v.id("tasks")),
    artifact_id: v.optional(v.id("artifacts")),
    // Comment anchor (comment kind only).
    message_id: v.optional(v.id("messages")),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    // Code comment anchor (code kind only).
    repository: v.optional(v.string()),
    ref: v.optional(v.string()),
    pull_request_id: v.optional(v.id("pull_requests")),
    // Decision kind only.
    decision_id: v.optional(v.id("session_decisions")),
  })
    .index("by_user_team_activity", ["user_id", "team_id", "last_activity_at"])
    .index("by_user_kind_root", ["user_id", "kind", "root_key"])
    .index("by_kind_root", ["kind", "root_key"])
    .index("by_channel", ["channel_id"]),
};

export const chatTypingTables = {
  chat_typing: defineTable({
    channel_id: v.id("chat_channels"),
    user_id: v.id("users"),
    // "" = the channel's main composer; a thread root id scopes the signal to
    // that thread's panel.
    thread_key: v.string(),
    updated_at: v.number(),
  })
    .index("by_channel_user", ["channel_id", "user_id"])
    .index("by_channel_updated", ["channel_id", "updated_at"]),
};
