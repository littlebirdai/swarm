import { defineTable } from "convex/server";
import { v } from "convex/values";
import { followViewValidator } from "../lib/followView";

export const sessionSharingTables = {
  claims: defineTable({
    conversation_id: v.id("conversations"),
    kind: v.union(v.literal("steer"), v.literal("terminal")),
    pane_instance: v.optional(v.number()),
    holder: v.optional(v.id("users")),
    token: v.number(),
    lease_until: v.number(),
    request_id: v.optional(v.string()),
    request_holder: v.optional(v.id("users")),
  })
    .index("by_conversation_kind", ["conversation_id", "kind"])
    .index("by_holder", ["holder"])
    .index("by_request_holder", ["request_holder"]),

  share_redemptions: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    token: v.string(),
    created_at: v.number(),
  }).index("by_conversation_user", ["conversation_id", "user_id"]),

  // One teammate the session's owner let read it by @mentioning them in a
  // comment (Alex, 2026-11-14: "the mention shares it"). Read access only, the
  // tier a share-link viewer gets; it holds while the grantee is still on the
  // session's team (privacy.ts hasMentionReadGrant).
  conversation_read_grants: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    granted_by: v.id("users"),
    source: v.literal("mention"),
    comment_id: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_conversation_user", ["conversation_id", "user_id"]),

  collab_grants: defineTable({
    conversation_id: v.id("conversations"),
    grantee_user_id: v.id("users"),
    // The conversation owner whose session is acted on — the one who must approve.
    owner_user_id: v.id("users"),
    status: v.union(
      v.literal("requested"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("revoked"),
    ),
    // Snapshot of the requester so the approve/deny card renders without a join.
    grantee_name: v.optional(v.string()),
    grantee_image: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_conversation_grantee", ["conversation_id", "grantee_user_id"]),

  // An anonymous viewer of a session's share link who gave a name to suggest
  // messages (guestSuggestions.ts). They prove it with the secret their
  // browser was handed; only its hash is stored. A guest is bound to the
  // share token they joined on, so turning the link off or rotating it
  // shuts them out.
  session_guests: defineTable({
    conversation_id: v.id("conversations"),
    name: v.string(),
    secret_hash: v.string(),
    share_token_hash: v.string(),
    created_at: v.number(),
  }).index("by_conversation_created", ["conversation_id", "created_at"]),

  // One message a guest, or a teammate while the owner is in the session
  // (teamSuggestions.ts), proposed for a session. Nothing reaches the session
  // until its owner sends it.
  guest_suggestions: defineTable({
    conversation_id: v.id("conversations"),
    // Set for a guest; a teammate's row has author_user_id instead.
    guest_id: v.optional(v.id("session_guests")),
    author_user_id: v.optional(v.id("users")),
    // Snapshot of the author's name so the owner's card renders without a join.
    guest_name: v.string(),
    // Absent: a message. "answer": a reply to the agent's open question
    // (tool_use_id names it; body is the answer as the card would send it).
    // "permission": approve or deny one pending permission.
    kind: v.optional(v.union(v.literal("answer"), v.literal("permission"))),
    tool_use_id: v.optional(v.string()),
    permission_id: v.optional(v.id("pending_permissions")),
    decision: v.optional(v.union(v.literal("approved"), v.literal("denied"))),
    // The proposing client's key for its optimistic copy (store altKey).
    client_key: v.optional(v.string()),
    // A teammate's "Queue for later" that waited as a suggestion: sent, it
    // still waits for the end of the agent's turn.
    queued: v.optional(v.boolean()),
    owner_user_id: v.id("users"),
    body: v.string(),
    // closed: what a proposal answered (a question, a prompt) ended some
    // other way, or its author can no longer send here.
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("dismissed"),
      v.literal("withdrawn"),
      v.literal("closed"),
    ),
    // What the owner actually sent, when they edited it first.
    sent_body: v.optional(v.string()),
    created_at: v.number(),
    decided_at: v.optional(v.number()),
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_guest", ["guest_id"])
    .index("by_author_conversation", ["author_user_id", "conversation_id"]),
};

export const messageShareTables = {
  message_shares: defineTable({
    share_token: v.string(),
    message_id: v.id("messages"),
    user_id: v.id("users"),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    message_ids: v.optional(v.array(v.id("messages"))),
    note: v.optional(v.string()),
    // When set, the shared page links to the full conversation via its public
    // share_token (minted at share time if the sharer owns the conversation).
    include_conversation_link: v.optional(v.boolean()),
    created_at: v.number(),
  }).index("by_share_token", ["share_token"]),
};

export const sessionFrameTables = {
  terminal_watch_shares: defineTable({
    conversation_id: v.id("conversations"),
    team_id: v.id("teams"),
    owner_id: v.id("users"),
    device: v.id("devices"),
    session: v.id("managed_sessions"),
    session_id: v.string(),
    target: v.string(),
    agent_started_at: v.optional(v.number()),
    pane_instance: v.optional(v.string()),
  }).index("by_conversation", ["conversation_id"]),

  terminal_watch_screens: defineTable({
    share: v.id("terminal_watch_shares"),
    stream_id: v.string(),
    requested_at: v.number(),
    expires_at: v.number(),
    seen_at: v.optional(v.number()),
    frame: v.optional(v.string()),
  })
    .index("by_share", ["share"])
    .index("by_expiry", ["expires_at"]),

  terminal_watch_viewers: defineTable({
    share: v.id("terminal_watch_shares"),
    user_id: v.id("users"),
    expires_at: v.number(),
    revoked: v.boolean(),
  })
    .index("by_share_user", ["share", "user_id"])
    .index("by_expiry", ["revoked", "expires_at"]),

  // Live screen of one tmux pane on one machine — the transport that lets the
  // terminal split watch a pane the browser cannot reach on loopback (an agent
  // running on your Mac mini while you sit at a laptop). See
  // convex/terminalStream.ts for the lease protocol and why this is snapshots
  // rather than a byte stream.
  //
  // One row per (user, device, pane), reused forever: the daemon overwrites
  // `frame` in place while a viewer holds the lease, and nothing writes at all
  // once the lease lapses or the screen stops changing. A row is therefore hot
  // only while a human is looking at it, and has exactly one writer, so the
  // usual hot-document contention doesn't apply.
  terminal_frames: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    // tmux target (a managed session name, e.g. "cc-abc123").
    target: v.string(),
    // Current screen as tmux printed it (`capture-pane -p -e`): text plus SGR
    // escapes, no scrollback. Absent until the first capture lands.
    frame: v.optional(v.string()),
    // Pane geometry, so the viewer can size its xterm to the real pane instead
    // of reflowing someone else's columns.
    cols: v.optional(v.number()),
    rows: v.optional(v.number()),
    // Where tmux has the cursor. capture-pane returns text only, so without
    // this the viewer's cursor parks at the end of the last line instead of in
    // the agent's input box.
    cursor_x: v.optional(v.number()),
    cursor_y: v.optional(v.number()),
    // Bumped on every pushed frame. The viewer repaints on change; an idle
    // pane pushes nothing, so this is also how "still connected" is told apart
    // from "nothing new" (that's `streamer_seen_at`).
    seq: v.number(),
    // Why the stream stopped producing (pane gone, tmux missing). Cleared by
    // the next good frame.
    error: v.optional(v.string()),
    // Viewer lease. The daemon keeps capturing while now < watch_until and
    // stops on its own the moment it lapses — a closed tab, a killed browser
    // and a lost network all converge on "stop" with no teardown message.
    watch_until: v.number(),
    // Last time the daemon pushed anything for this pane (frame or heartbeat).
    // The viewer shows "connecting" until this moves.
    streamer_seen_at: v.optional(v.number()),
    // Last time a stream_pane command was queued for the device. A viewer
    // renews its lease every few seconds; without this stamp a machine that is
    // asleep or offline would collect one command row per renewal forever.
    requested_at: v.optional(v.number()),
    // While this is in the future a viewer has the pane FOCUSED, so the daemon
    // polls fast enough that the first keystroke of a sentence isn't swallowed
    // by the idle heartbeat. Only pushed forward, never cleared on blur: two
    // tabs on one pane must not switch each other's keyboard off.
    interactive_until: v.optional(v.number()),
    // Keystrokes waiting to reach the pane, as lowercase hex. The viewer
    // appends; the next frame push carries them back and clears this in the
    // same transaction, which is what makes delivery exactly-once. Small and
    // short-lived by construction — the daemon drains it a few times a second
    // while typing, and sendPaneInput refuses to let it grow past a few KB.
    pending_input: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_user_device_target", ["user_id", "device_id", "target"]),

  // The clipboard offer for one relayed pane: the newest tmux paste buffer the
  // daemon saw appear while the viewer typed, redacted (paneStream.ts
  // clipboardWatch). Its own table, keyed like terminal_frames, so a frame
  // patch (several a second while typing) neither rewrites the text nor
  // re-runs the viewer's clipboard query. Read back only inside
  // PANE_CLIPBOARD_TTL_MS; pruneStaleFrames deletes what outlives it.
  terminal_clipboards: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    target: v.string(),
    text: v.string(),
    at: v.number(),
  }).index("by_user_device_target", ["user_id", "device_id", "target"]),

  // Live picture of the browser tab one session drives on one machine: the
  // relay that lets a viewer on ANOTHER machine watch it (the loopback watch
  // socket only reaches the machine the viewer sits at). Same lease protocol
  // as terminal_frames; see convex/browserStream.ts.
  //
  // One row per (user, device, session key), reused: the daemon overwrites the
  // frame in place while a lease is live and writes nothing once it lapses.
  browser_frames: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    // The session uuid when known, else its tmux session name.
    key: v.string(),
    // Newest JPEG the tab painted, base64, with its pixel size.
    frame: v.optional(v.string()),
    frame_w: v.optional(v.number()),
    frame_h: v.optional(v.number()),
    // Bumped on every stored frame; the viewer repaints on change.
    seq: v.number(),
    // The tab being streamed. Set when the daemon attaches (the socket's
    // `ready`) and kept current as the session moves between tabs.
    tab_id: v.optional(v.string()),
    tab_title: v.optional(v.string()),
    tab_url: v.optional(v.string()),
    // The daemon can dispatch the viewer's input into this tab.
    control: v.optional(v.boolean()),
    // The agent's recent actions (WatchAction frames, JSON array), newest
    // last, for the cursor overlay. The viewer applies those it has not seen.
    actions: v.optional(v.string()),
    // How the last stream ended (BrowserRelayEnd, JSON). Cleared when a new
    // stream is requested, so a viewer never reads a previous stream's end.
    end: v.optional(v.string()),
    watch_until: v.number(),
    // While in the future a viewer is driving: the daemon pushes fast so their
    // input is collected promptly.
    interactive_until: v.optional(v.number()),
    streamer_seen_at: v.optional(v.number()),
    requested_at: v.optional(v.number()),
    // Viewer input events (WatchInput, JSON array) waiting for the next push.
    pending_input: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_user_device_key", ["user_id", "device_id", "key"]),
};

export const viewFollowTables = {
  // Who is typing where, right now. ONE row per (channel, user) — a person
  // types in one box at a time, so the row's thread_key just moves with them,
  // and the table stays bounded at members × channels rather than growing a
  // row per thread ever touched. Rows are refreshed while typing and deleted
  // on send/blur; readers treat anything older than a few seconds as gone, so
  // a leaked row (tab closed mid-word) misleads for one TTL and never again.
  // Deliberately NOT in the store/sync pipeline: this is presence, not state —
  // nothing persists it, and the only reader is the open channel's surface.
  // Follow mode (Figma style). A follower's lease on a leader: upserted to
  // start, renewed every few seconds while following, dead after
  // FOLLOW_LEASE_MS (follow.ts). No row means nobody follows, which is what
  // gates the leader's view writes below.
  view_follows: defineTable({
    follower_id: v.id("users"),
    leader_id: v.id("users"),
    updated_at: v.number(),
    // The leader stopped sharing with this follower: renewals are refused
    // until the follower starts a follow again on purpose.
    dropped_at: v.optional(v.number()),
  })
    .index("by_leader", ["leader_id", "updated_at"])
    .index("by_follower", ["follower_id"]),
  // Where a leader is right now, written only while someone follows them,
  // about four times a second at most. Readers get it only while their own
  // lease is live, and never a conversation they could not open themselves.
  view_states: defineTable({
    user_id: v.id("users"),
    path: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    anchor: v.optional(
      v.object({ message_id: v.string(), offset: v.number() }),
    ),
    // Inside the page: open panel, diff file and line, a scroll region's offset.
    view: v.optional(followViewValidator),
    updated_at: v.number(),
  }).index("by_user", ["user_id"]),
};
