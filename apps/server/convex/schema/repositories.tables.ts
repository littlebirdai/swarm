import { defineTable } from "convex/server";
import { v } from "convex/values";

export const fileTouchTables = {
  file_touches: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    file_path: v.string(),
    operation: v.union(
      v.literal("read"),
      v.literal("edit"),
      v.literal("write"),
      v.literal("delete"),
      v.literal("glob"),
      v.literal("grep"),
    ),
    line_range: v.optional(v.string()),
    message_index: v.number(),
    timestamp: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_user_file", ["user_id", "file_path"]),
};

export const repositoryHistoryTables = {
  commits: defineTable({
    conversation_id: v.optional(v.id("conversations")),
    sha: v.string(),
    message: v.string(),
    author_name: v.string(),
    author_email: v.string(),
    timestamp: v.number(),
    files_changed: v.number(),
    insertions: v.number(),
    deletions: v.number(),
    repository: v.optional(v.string()),
    pr_number: v.optional(v.number()),
    // GitHub provenance for commits that arrive by webhook or backfill (the
    // transcript path sets conversation_id instead). team_id is the access
    // fallback for a commit with no session: members of the installing team
    // may read it. branch is the ref the push landed on; task_ids are the
    // ct- ids parsed from the message and branch (lib/gitRefs).
    team_id: v.optional(v.id("teams")),
    branch: v.optional(v.string()),
    author_login: v.optional(v.string()),
    author_avatar_url: v.optional(v.string()),
    pr_id: v.optional(v.id("pull_requests")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    files: v.optional(
      v.array(
        v.object({
          filename: v.string(),
          status: v.string(),
          additions: v.number(),
          deletions: v.number(),
          changes: v.number(),
          patch: v.optional(v.string()),
        }),
      ),
    ),
    // When it reached the repository's default branch, in push order (a push's
    // commits a millisecond apart): what orders main, so a target's waiting
    // queue is the commits after its live sha (deploys.md DP12).
    main_at: v.optional(v.number()),
    // The GitHub login that pushed it onto the default branch (the push webhook's pusher, which GitHub
    // authenticates; author_login is derived from an email anyone can set). Red main wakes only its sessions.
    pushed_by: v.optional(v.string()),
  })
    .index("by_repository_main", ["repository", "main_at"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_timestamp", ["timestamp"])
    .index("by_sha", ["sha"])
    .index("by_repository", ["repository"])
    .index("by_repository_timestamp", ["repository", "timestamp"])
    .index("by_team_timestamp", ["team_id", "timestamp"])
    // Walked one row per repository to list the repositories a team's
    // activity names (repos.ts repositoriesForUser).
    .index("by_team_repository", ["team_id", "repository"]),

  // Per-edit file changes materialized at message ingest (materializeFileChanges
  // in messages.ts). Lets the diff viewer show the full session diff without
  // paginating the whole conversation to the top. change_key = the extractor's
  // stable per-edit id (toolCallId, or `${toolCallId}:${section}`) so re-synced
  // messages upsert idempotently instead of duplicating rows.
  file_changes: defineTable({
    conversation_id: v.id("conversations"),
    change_key: v.string(),
    message_id: v.id("messages"),
    tool_call_id: v.optional(v.string()),
    seq: v.number(),
    file_path: v.string(),
    // "write" replaces the whole file (old_content = the file before, when it
    // existed), "edit" is one string replacement, "delete" removes the file,
    // "commit" is a git commit the session made.
    change_type: v.union(
      v.literal("write"),
      v.literal("edit"),
      v.literal("delete"),
      v.literal("commit"),
    ),
    // The change's text lives in file_change_bodies (same conversation_id +
    // change_key), so a whale session's index stays readable under the 16 MiB
    // per-function read cap: whole-file writes carried inline pushed one
    // conversation's rows to 26 MiB. These two hold only the sizes; the fold
    // uses old_bytes === undefined as "the file did not exist before".
    old_bytes: v.optional(v.number()),
    new_bytes: v.optional(v.number()),
    // Legacy inline text, present only on rows fileChangeBodies.migrate has
    // not reached. Readers accept either place; writers fill the body table.
    old_content: v.optional(v.string()),
    new_content: v.optional(v.string()),
    commit_message: v.optional(v.string()),
    commit_hash: v.optional(v.string()),
    // The branch `git commit` reported. The diff pane's branch base is the
    // last commit that landed on the default branch.
    commit_branch: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    // "Rewind to here" reads one conversation's changes after a moment (treeSnapshots.editedPaths).
    .index("by_conversation_timestamp", ["conversation_id", "timestamp"])
    .index("by_conversation_change_key", ["conversation_id", "change_key"])
    // cast blame: resolve a git SHA to the session that committed it. Stored
    // hashes are short (parsed from `[branch abc1234]` output), so lookups
    // range-scan [sha7, fullSha] and prefix-verify.
    .index("by_commit_hash", ["commit_hash"])
    // cast blame fallback: sessions often commit via compound commands whose
    // output carries no `[branch hash]` line, so the row has a message but no
    // hash. Blame then matches commit rows by subject + timestamp proximity.
    .index("by_type_timestamp", ["change_type", "timestamp"])
    // cast blame: attribute uncommitted lines to the newest edit of the file.
    .index("by_file_path", ["file_path"]),
};

export const fileChangeBodyTables = {
  file_change_bodies: defineTable({
    conversation_id: v.id("conversations"),
    change_key: v.string(),
    old_content: v.optional(v.string()),
    new_content: v.string(),
  }).index("by_conversation_change_key", ["conversation_id", "change_key"]),
};

export const repositorySourceTables = {
  // Read-through cache of repository content fetched with the GitHub App
  // token for the source browser and history pages: branch lists, trees,
  // blobs, commit logs and blame. Keyed by (repository, kind, ref, path).
  // Rows are re-fetched when older than their kind's TTL (repos.ts) and never
  // synced to the client store; the pages read them per view.
  repo_cache: defineTable({
    team_id: v.id("teams"),
    repository: v.string(),
    // branches | tree | blob | log | blame | compare
    kind: v.string(),
    ref: v.string(),
    path: v.string(),
    // Resolved commit sha for ref (a branch name resolves to its tip).
    sha: v.optional(v.string()),
    // JSON payload for structured kinds; raw text for blobs.
    content: v.string(),
    size: v.optional(v.number()),
    truncated: v.optional(v.boolean()),
    etag: v.optional(v.string()),
    fetched_at: v.number(),
    // Set on a row a local checkout published (repos.ingestLocal,
    // answerLocalRead): the workspace key of the team it was published to.
    // The repository name on such a row is the publisher's own claim, so the
    // row is read and replaced only inside that workspace. Absent on a row
    // fetched from GitHub with an installation token, and on rows from before
    // this field, which are read only through an installation.
    local_workspace: v.optional(v.string()),
  })
    .index("by_key", ["repository", "kind", "ref", "path"])
    .index("by_team_fetched", ["team_id", "fetched_at"])
    // Pruning asks one question across every team: what has not been read in a
    // week. by_team_fetched cannot answer it without walking the teams, so the
    // sweep gets an index of its own and reads only rows it is going to delete.
    .index("by_fetched", ["fetched_at"]),

  // A team member's local checkout that publishes a repository's git metadata
  // into repo_cache through the daemon (repos.ingestLocal), which is what makes
  // a repository browsable with no GitHub App installation at all. One row per
  // person and checkout root. team_id comes from the directory mapping that
  // already shares that person's sessions from this path: sharing the sessions
  // is what shares the source. `enabled` is the person's own switch.
  repo_sources: defineTable({
    user_id: v.id("users"),
    team_id: v.id("teams"),
    repository: v.string(),
    root: v.string(),
    remote_url: v.optional(v.string()),
    device_label: v.optional(v.string()),
    default_branch: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    enabled: v.boolean(),
    last_synced_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_root", ["user_id", "root"])
    .index("by_repository", ["repository"])
    .index("by_team_id", ["team_id"]),

  // A read the repo pages asked for that only a teammate's checkout can
  // answer: no installation covers the repository and the daemon has not
  // pushed this row yet (a file, a deeper tree, an older page of history, a
  // commit's diff). The daemons publishing the repository subscribe to these
  // (repos.pendingLocalReads), answer through repos.answerLocalRead — which
  // writes the cache row and deletes the request — or leave it `failed` with
  // the reason, so the page can say why. Keyed like repo_cache: one read, one
  // row, however many pages ask.
  repo_read_requests: defineTable({
    team_id: v.id("teams"),
    repository: v.string(),
    kind: v.string(),
    ref: v.string(),
    path: v.string(),
    params: v.optional(v.any()),
    requested_by: v.id("users"),
    status: v.union(v.literal("pending"), v.literal("failed")),
    error: v.optional(v.string()),
    // Publishers whose checkout could not answer. The request fails only once
    // every publisher has declined; until then another machine may still hold
    // the ref.
    declined_by: v.optional(v.array(v.id("users"))),
    // The GitHub App installation that answers instead when no checkout can:
    // every publisher declined, or none answered within the grace window.
    fallback_installation_id: v.optional(v.number()),
    fallback_team_id: v.optional(v.id("teams")),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_key", ["repository", "kind", "ref", "path"])
    .index("by_repository", ["repository"]),
};
