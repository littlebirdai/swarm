import { defineTable } from "convex/server";
import { v } from "convex/values";

export const artifactTables = {
  // Published HTML artifacts (`cast publish` → codecast.sh/a/<slug>). The HTML
  // body lives in file storage, not the row; the unguessable slug is the only
  // access gate (same model as doc share links). See artifacts.ts.
  artifacts: defineTable({
    slug: v.string(),
    user_id: v.id("users"),
    title: v.string(),
    // Publish identity: re-publishing the same absolute path updates the same
    // artifact (stable URL). Absent for artifacts minted with --new.
    source_path: v.optional(v.string()),
    storage_id: v.id("_storage"),
    size: v.number(),
    version: v.number(),
    // sha-256 of the current content — republishing identical bytes is a no-op
    // instead of a junk history entry. Absent on rows from before history.
    content_hash: v.optional(v.string()),
    // "html" (default when absent) | "markdown" (source_storage_id holds the raw
    // md; storage_id holds the rendered reading-theme HTML) | "bundle" (assets in
    // artifact_assets, storage_id holds the entry HTML).
    kind: v.optional(v.string()),
    source_storage_id: v.optional(v.id("_storage")),
    // Provenance: the session that published this artifact.
    session_short_id: v.optional(v.string()),
    session_conversation_id: v.optional(v.id("conversations")),
    // Owner choice: keep the publishing session off the public page (bar chip
    // and ?meta=1). Absent = the session link is shown.
    hide_session: v.optional(v.boolean()),
    // Owner choice: no viewer discussion on this page. Absent = comments on.
    comments_disabled: v.optional(v.boolean()),
    // Secrets. owner_key grants in-page management (travels only in the URL
    // fragment, #o=). edit_key grants collaborative editing when edit_mode is
    // "link". Both are unguessable random strings, like the slug itself.
    owner_key: v.optional(v.string()),
    edit_key: v.optional(v.string()),
    // Who may publish new versions: absent/"owner" (api_token or owner_key),
    // "link" (edit_key holders too), "team" (owner's team members via web).
    edit_mode: v.optional(v.string()),
    // Access gates, all optional: password (sha256(password + ":" + slug)),
    // email capture wall, expiry.
    password_hash: v.optional(v.string()),
    email_gate: v.optional(v.boolean()),
    expires_at: v.optional(v.number()),
    // Team gate: the page belongs to a team whose policy marks its data as
    // regulated (regulated_data), so only that team's signed-in members may
    // open it. Set by the server whenever the page's workspace or publishing
    // device answers to such a team; never cleared while the team is regulated.
    team_gate: v.optional(v.id("teams")),
    thumb_storage_id: v.optional(v.id("_storage")),
    // Who created the CURRENT version when it came from a link/team editor
    // (absent for owner publishes). Carried into artifact_versions when the
    // next bump snapshots this version.
    last_edited_by: v.optional(v.string()),
    // Evidence (the-line.md L6): the task and station this page was produced
    // for. Set by cast publish --task/--plan, by a publish from a session
    // bound to a task, or by cast task handoff --page.
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    station: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_user", ["user_id"])
    // The gallery reads each owner's newest pages first (artifacts.listForWeb).
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_user_path", ["user_id", "source_path"])
    .index("by_task", ["task_id"])
    .index("by_plan", ["plan_id"])
    .index("by_session_conversation", ["session_conversation_id"]),

  // Superseded artifact versions: on republish the previous blob is snapshotted
  // here (instead of deleted) so past versions stay openable. Bounded — see
  // MAX_ARTIFACT_HISTORY in artifacts.ts. Invariant: every storage_id in the
  // artifact tables is referenced by exactly ONE row (rollback copies blobs).
  artifact_versions: defineTable({
    artifact_id: v.id("artifacts"),
    version: v.number(),
    title: v.string(),
    storage_id: v.id("_storage"),
    size: v.number(),
    published_at: v.number(),
    kind: v.optional(v.string()),
    source_storage_id: v.optional(v.id("_storage")),
    session_short_id: v.optional(v.string()),
    // Name of the link/team collaborator who published this version via the
    // in-browser editor; absent for owner publishes.
    edited_by: v.optional(v.string()),
  }).index("by_artifact", ["artifact_id", "version"]),

  // Files of a bundle artifact, one row per (version, path). Pruned with their
  // version. Paths are normalized relative ("img/chart.png", no leading slash).
  artifact_assets: defineTable({
    artifact_id: v.id("artifacts"),
    version: v.number(),
    path: v.string(),
    storage_id: v.id("_storage"),
    content_type: v.string(),
    size: v.number(),
  }).index("by_artifact_version", ["artifact_id", "version", "path"]),

  // Bundle files a CLI uploaded ahead of its publish (POST /cli/artifacts/upload),
  // so big files never pass through the publish action's 64 MB heap as base64.
  // A row proves who uploaded the blob; the publish that attaches it deletes the
  // row, and the sweep deletes blobs nobody attached.
  artifact_uploads: defineTable({
    user_id: v.id("users"),
    storage_id: v.id("_storage"),
    created_at: v.number(),
  })
    .index("by_storage_id", ["storage_id"])
    .index("by_created_at", ["created_at"]),

  // Viewer comments. A batch_id groups the comments one viewer submitted
  // together (they arrive in the publishing session as ONE message).
  artifact_comments: defineTable({
    artifact_id: v.id("artifacts"),
    batch_id: v.string(),
    author_name: v.string(),
    author_email: v.optional(v.string()),
    // Verified identity: set when the comment arrived with a valid identity
    // token (artifact_identities), never from viewer-supplied text. The
    // avatar is snapshotted at comment time so the public ?meta=1 shape never
    // needs a user-table join.
    author_user_id: v.optional(v.id("users")),
    author_avatar: v.optional(v.string()),
    // Reply threading: top-level comments have no parent; replies point at a
    // top-level comment (one level deep, like the session comment threads).
    parent_comment_id: v.optional(v.id("artifact_comments")),
    text: v.string(),
    // Opaque anchor JSON from the viewer page (selector/snippet/position);
    // the server never interprets it.
    anchor: v.optional(v.string()),
    // Client-minted idempotency key: a retried submit with the same
    // (artifact, client_id) returns the existing row instead of a twin.
    client_id: v.optional(v.string()),
    version: v.number(),
    status: v.string(), // "open" | "resolved"
    // Sent into the publishing session (the page's agent), and when.
    delivered: v.boolean(),
    delivered_at: v.optional(v.number()),
    // The page's current version when it was delivered: the first version
    // above it answers the comment.
    delivered_version: v.optional(v.number()),
    // Who may steer the agent, stamped at write time: "owner" (owner_key or
    // the owning account) or "teammate" (a verified teammate who can see the
    // page). Absent = an anonymous or outside viewer, whose text never reaches
    // the session.
    author_role: v.optional(v.union(v.literal("owner"), v.literal("teammate"))),
    created_at: v.number(),
  })
    .index("by_artifact", ["artifact_id", "created_at"])
    .index("by_artifact_client_id", ["artifact_id", "client_id"]),

  // Live data on a published page (cast-data.json): one row per declared
  // query, run as the publisher inside one workspace, its last answer cached
  // here and refreshed on read once it is older than refresh_ms. A republish
  // replaces the page's whole set (pageData.ts, lib/pageReaders.ts).
  page_queries: defineTable({
    artifact_id: v.id("artifacts"),
    query_id: v.string(),
    position: v.number(),
    title: v.optional(v.string()),
    reader: v.string(),
    /** The validated args as JSON: product keys need not be Convex field names. */
    args_json: v.string(),
    query_text: v.string(),
    owner_user_id: v.id("users"),
    /** The access key every read runs inside (team:<id> | user:<id>). */
    workspace: v.string(),
    refresh_ms: v.number(),
    /** {columns, rows} as JSON, capped at PAGE_DATA_LIMITS.result_bytes. */
    result_json: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    refreshed_at: v.optional(v.number()),
    /** The last refresh attempt, kept so a failing query waits its interval too. */
    attempted_at: v.optional(v.number()),
    error: v.optional(v.string()),
    /** A refresh is running until then; viewers who arrive meanwhile start none. */
    lease_until: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_artifact", ["artifact_id", "query_id"]),
};

export const artifactViewTables = {
  // The query set each published version declared, so a rollback restores the
  // queries with the page. A version without a row (an in-browser edit, a page
  // from before live data) uses the latest set at or below it. `set_json` is
  // the validated {workspace, queries} exactly as the content hash saw it, or
  // "" for a version that declared none.
  page_query_sets: defineTable({
    artifact_id: v.id("artifacts"),
    version: v.number(),
    owner_user_id: v.id("users"),
    set_json: v.string(),
    created_at: v.number(),
  }).index("by_artifact_version", ["artifact_id", "version"]),

  // View counters, isolated from the artifacts row so beacon writes never churn
  // the row that queries/pages watch.
  artifact_stats: defineTable({
    artifact_id: v.id("artifacts"),
    view_count: v.number(),
    last_viewed_at: v.number(),
  }).index("by_artifact", ["artifact_id"]),

  // Signed-in commenter identity for the sandboxed artifact pages. The pages
  // are an opaque origin (CSP sandbox) and can never read codecast.sh auth, so
  // the web app mints an unguessable token per (user, artifact) that travels
  // back to the page in the #i= fragment — same transport as the owner key.
  // Holding the token lets its bearer comment AS that user on that one
  // artifact, nothing else; it grants no read access and no other writes.
  artifact_identities: defineTable({
    token: v.string(),
    user_id: v.id("users"),
    artifact_id: v.id("artifacts"),
    created_at: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_user_artifact", ["user_id", "artifact_id"]),

  // Email-gate audit: who has seen a gated artifact, per email.
  artifact_viewers: defineTable({
    artifact_id: v.id("artifacts"),
    email: v.string(),
    first_seen: v.number(),
    last_seen: v.number(),
    view_count: v.number(),
  }).index("by_artifact_email", ["artifact_id", "email"]),
};
