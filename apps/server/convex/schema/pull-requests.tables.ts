import { defineTable } from "convex/server";
import { v } from "convex/values";
import { changeGuideStepValidator } from "../lib/changeGuideValidator";
import { proseAnchorValidator } from "../lib/proseAnchorValidator";
import { codeAnchorValidator } from "../lib/codeAnchorValidator";

export const pullRequestTables = {
  pull_requests: defineTable({
    team_id: v.id("teams"),
    github_pr_id: v.number(),
    repository: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.union(v.literal("open"), v.literal("closed"), v.literal("merged")),
    author_github_username: v.string(),
    head_ref: v.optional(v.string()),
    base_ref: v.optional(v.string()),
    linked_session_ids: v.array(v.id("conversations")),
    pr_comment_posted: v.optional(v.boolean()),
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
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    changed_files: v.optional(v.number()),
    commits_count: v.optional(v.number()),
    files_synced_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
    closed_at: v.optional(v.number()),
    // The commit the merge put on the base branch (a squash, a merge commit, or the last rebased commit): what a
    // deploy must hold for the change to be live (deployReach.ts).
    merge_commit_sha: v.optional(v.string()),
    // Live state mirrored from GitHub by the webhook processors and the merge
    // state refresh (githubWebhooks / prShepherd). Every field is optional so
    // rows that predate it stay valid.
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    author_avatar_url: v.optional(v.string()),
    // GitHub's mergeable / mergeable_state ("clean", "behind", "dirty",
    // "blocked", "unstable", "unknown", "draft"). behind_by is the compare
    // API's count of base commits the head lacks.
    mergeable: v.optional(v.union(v.boolean(), v.null())),
    mergeable_state: v.optional(v.string()),
    // GitHub's auto-merge request on the pull request, null when none is set.
    // Written from pull_request webhook payloads (processPRMetaEvent).
    auto_merge: v.optional(
      v.union(
        v.null(),
        v.object({
          merge_method: v.optional(v.string()),
          enabled_by: v.optional(v.string()),
        }),
      ),
    ),
    behind_by: v.optional(v.number()),
    merge_state_checked_at: v.optional(v.number()),
    // "approved" | "changes_requested" | "review_required" | "none"
    review_decision: v.optional(v.string()),
    requested_reviewers: v.optional(v.array(v.string())),
    // GitHub's own metadata on the pull request, kept as GitHub sends it.
    labels: v.optional(
      v.array(v.object({ name: v.string(), color: v.optional(v.string()) })),
    ),
    assignees: v.optional(v.array(v.string())),
    // The commits on the head branch, oldest first, read when the files are.
    commits: v.optional(
      v.array(
        v.object({
          sha: v.string(),
          message: v.string(),
          author_login: v.optional(v.string()),
          author_name: v.optional(v.string()),
          author_avatar_url: v.optional(v.string()),
          committed_at: v.optional(v.number()),
          url: v.optional(v.string()),
        }),
      ),
    ),
    unresolved_review_count: v.optional(v.number()),
    // One entry per check run or commit status context on head_sha, keyed by
    // name plus the suite's triggering event when known (a job that runs on
    // both push and pull_request is two entries, as on GitHub). checks_state
    // folds them: "none" | "pending" | "success" | "failure".
    checks: v.optional(
      v.array(
        v.object({
          name: v.string(),
          status: v.string(),
          conclusion: v.optional(v.string()),
          url: v.optional(v.string()),
          updated_at: v.number(),
          external_id: v.optional(v.string()),
          suite_id: v.optional(v.string()),
          event: v.optional(v.string()),
          app: v.optional(v.string()),
        }),
      ),
    ),
    checks_state: v.optional(v.string()),
    // Reasons that piled up since the last wake was DELIVERED. Several events
    // often land while the shepherd is mid-run, and the newest is rarely the
    // most urgent, so they are kept until the prompt is built and the headline
    // is chosen by severity. Cleared once the wake is handed over.
    shepherd_pending_reasons: v.optional(v.array(v.string())),
    // ct- ids parsed from title, body and head_ref.
    task_ids: v.optional(v.array(v.id("tasks"))),
    // Tasks with a wait still waiting on this PR (task-graph.md TG2), so a
    // state or checks move settles only them. Added by taskWaits.writeWaits,
    // pruned by taskWaits.settlePr.
    waiting_task_ids: v.optional(v.array(v.id("tasks"))),
    // Shepherd: the session that owns this PR until it merges. One standing
    // agent_tasks row (shepherd_task_id) is woken with a prompt built from the
    // fields above. shepherd_state is the folded status the inbox card shows:
    // "review_pending" | "changes_requested" | "ci_pending" | "ci_red" |
    // "behind" | "conflicts" | "approved" | "ready" | "merged" | "closed".
    shepherd_conversation_id: v.optional(v.id("conversations")),
    shepherd_enabled: v.optional(v.boolean()),
    shepherd_task_id: v.optional(v.id("agent_tasks")),
    shepherd_state: v.optional(v.string()),
    shepherd_state_at: v.optional(v.number()),
    shepherd_last_wake_at: v.optional(v.number()),
    shepherd_last_wake_reason: v.optional(v.string()),
    shepherd_wake_count: v.optional(v.number()),
  })
    .index("by_team_id", ["team_id"])
    .index("by_github_pr_id", ["github_pr_id"])
    .index("by_repository", ["repository"])
    .index("by_repository_number", ["repository", "number"])
    // Open PRs of one repository: check and push webhooks look a head sha or a
    // base branch up among these, never among every PR the repository ever had.
    .index("by_repository_state", ["repository", "state"])
    .index("by_repository_head", ["repository", "head_sha"])
    .index("by_shepherd_conversation", ["shepherd_conversation_id"])
    // A team's pull requests touched in a trailing window (page data readers).
    .index("by_team_updated", ["team_id", "updated_at"])
    // Walked one row per repository (repos.ts repositoriesForUser).
    .index("by_team_repository", ["team_id", "repository"]),

  // A change guide a model wrote for a pull request whose author wrote none
  // (prGuides.ts, the PR page's Guide tab). One row per write, the newest
  // read; head_sha is the commit it describes, so a later push marks it stale.
  // Readable by whoever can read the pull request. Kept off the pull request
  // row, which every PR view subscribes to.
  pr_guides: defineTable({
    pr_id: v.id("pull_requests"),
    team_id: v.id("teams"),
    head_sha: v.optional(v.string()),
    status: v.union(
      v.literal("writing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    summary: v.optional(v.string()),
    steps: v.optional(v.array(changeGuideStepValidator)),
    error: v.optional(v.string()),
    model: v.string(),
    prompt_version: v.string(),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_usd: v.optional(v.number()),
    requested_by: v.id("users"),
    created_at: v.number(),
    finished_at: v.optional(v.number()),
  })
    .index("by_pr_created", ["pr_id", "created_at"])
    .index("by_team_created", ["team_id", "created_at"]),

  // linked_session_ids as an index (lib/prSessions.ts): written only there,
  // read to find the pull requests a session links. `tier` is how strong the
  // link is: "observed" (the session sat on the branch) or "committed" (its own
  // commit is on the pull request). Absent reads as observed.
  pull_request_sessions: defineTable({
    pull_request_id: v.id("pull_requests"),
    conversation_id: v.id("conversations"),
    tier: v.optional(v.union(v.literal("observed"), v.literal("committed"))),
    // The pull request's number and team, stamped by syncPullRequestSessions
    // so a reader that lists a session's pull requests skips the heavy row.
    pr_number: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
  })
    .index("by_pull_request", ["pull_request_id"])
    .index("by_conversation", ["conversation_id"]),

  reviews: defineTable({
    pull_request_id: v.id("pull_requests"),
    // Optional since reviews now also arrive by webhook from reviewers who
    // have no codecast account; those carry author_github_username instead.
    reviewer_user_id: v.optional(v.id("users")),
    author_github_username: v.optional(v.string()),
    // GitHub's author_association for a webhook review (OWNER, MEMBER,
    // COLLABORATOR, CONTRIBUTOR, NONE, ...): what standing the author has on
    // the repository, which the shepherd's wake names beside the review body.
    author_association: v.optional(v.string()),
    github_review_id: v.optional(v.number()),
    commit_sha: v.optional(v.string()),
    html_url: v.optional(v.string()),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("commented"),
      // Withdrawn on GitHub: kept in the history, counted by nothing.
      v.literal("dismissed"),
    ),
    body: v.optional(v.string()),
    submitted_at: v.number(),
    // Set when the pull request's owning session was handed this review as a
    // message (reviews.deliverSubmittedReview). The webhook's own wake for the
    // same review stands down when it finds this.
    session_delivered_at: v.optional(v.number()),
  })
    .index("by_pull_request", ["pull_request_id"])
    .index("by_reviewer", ["reviewer_user_id"])
    .index("by_github_review_id", ["github_review_id"]),

  // Code comments: a comment anchored to a file (and optionally a line range)
  // in a repository. Historically PR review comments only; now also comments
  // left on the source browser and on commit pages, with or without a PR.
  // A comment is a codecast object: it records the session, task, plan or doc
  // it was made from, and is mirrored to GitHub (github_comment_id) when the
  // file sits in an open PR.
  // The working tree of a checkout at the end of a turn, as a git commit the
  // daemon took on the machine that ran the session (cli/src/treeSnapshot.ts).
  // The transcript records only the edits an agent made through its tools; the
  // snapshot records the tree itself, so an edit made by a shell command, a
  // formatter or a person is in the history too. One snapshot describes one
  // checkout, and every session that shares that checkout gets a row naming
  // the same sha (checkout_key says which). Objects live in the session's own
  // git repository and travel on the hidden wip ref; this table is the index
  // that joins a sha to a conversation and a turn.
  tree_snapshots: defineTable({
    conversation_id: v.id("conversations"),
    sha: v.string(),
    tree_sha: v.string(),
    /** HEAD when the snapshot was taken (the commit's first parent). */
    base_sha: v.string(),
    /** The previous snapshot in the chain (the second parent), when chained. */
    prev_sha: v.optional(v.string()),
    branch: v.optional(v.string()),
    depth: v.number(),
    /** Paths that differ from prev (or from HEAD for a chain's first), capped at 200 by the daemon; the count is exact. */
    changed_paths: v.array(v.string()),
    changed_count: v.number(),
    /** The tree differs from HEAD's. */
    dirty: v.boolean(),
    /** Hash of the checkout's root path, the same hash project paths use, so sessions sharing a checkout are visible as such. */
    checkout_key: v.string(),
    device_id: v.optional(v.string()),
    /** Why the snapshot was taken: a lead turn ended, or the periodic sweep ran. */
    source: v.union(v.literal("turn"), v.literal("sweep"), v.literal("prompt")),
    taken_at: v.number(),
    /** The Stop hook's turn_completed_at for a turn snapshot, in ms. */
    turn_completed_at: v.optional(v.number()),
    /** How long the snapshot took on the daemon, ms: the cost the design promises to keep small. */
    took_ms: v.optional(v.number()),
    /** Other sessions the daemon recorded this same snapshot for: the checkout was shared, so the changes are theirs too. */
    shared_sessions: v.optional(v.number()),
  })
    .index("by_conversation_taken", ["conversation_id", "taken_at"])
    .index("by_conversation_sha", ["conversation_id", "sha"]),

  review_comments: defineTable({
    review_id: v.optional(v.id("reviews")),
    pull_request_id: v.optional(v.id("pull_requests")),
    repository: v.optional(v.string()),
    // Commit sha or branch the comment was made against.
    ref: v.optional(v.string()),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    line_end: v.optional(v.number()),
    // The commented lines' text with two lines of context, so a reader finds
    // the passage again after the code moves (packages/comments/src/codeAnchor.ts).
    anchor_lines: v.optional(codeAnchorValidator),
    // "LEFT" (old side of a diff) | "RIGHT". Absent = the file as it is at ref.
    side: v.optional(v.string()),
    parent_id: v.optional(v.id("review_comments")),
    conversation_id: v.optional(v.id("conversations")),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    doc_id: v.optional(v.id("docs")),
    author_kind: v.optional(
      v.union(v.literal("user"), v.literal("agent"), v.literal("github")),
    ),
    author_avatar_url: v.optional(v.string()),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    client_id: v.optional(v.string()),
    github_review_id: v.optional(v.number()),
    html_url: v.optional(v.string()),
    content: v.string(),
    resolved: v.boolean(),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    github_comment_id: v.optional(v.number()),
    // The FIRST comment of the thread this one replies to (GitHub's
    // comment.in_reply_to_id). A review thread is a conversation, and whether it
    // is still outstanding depends on who spoke last in it, not on the comment
    // that opened it. Absent means this comment opened its own thread.
    github_in_reply_to_id: v.optional(v.number()),
    // The GraphQL node id of the review thread this comment sits in. Resolving
    // a thread is a GraphQL mutation on that id, so it is cached here the first
    // time it is learned, from the thread webhook or from a lookup.
    github_thread_id: v.optional(v.string()),
    // A note in a review the author has not submitted yet. Visible to nobody
    // else, mirrored nowhere, until the review goes out as one GitHub review
    // or to a session as one message.
    pending_review: v.optional(v.boolean()),
    codecast_origin: v.optional(v.boolean()),
    author_github_username: v.optional(v.string()),
    // GitHub's author_association for a comment that arrived by webhook; see reviews.
    author_association: v.optional(v.string()),
    author_user_id: v.optional(v.id("users")),
    // ── Review notes written from a worktree (`cast review`, ct-49560) ──
    // A note is a comment first, so it lives here and the web diff view picks
    // it up from listForFile like any other. These four fields are what a
    // batch needs on top of that.
    // ACCESS, not routing: a note written in a directory mapped to a team is
    // the team's, one written anywhere else is its author's alone. Set only on
    // notes; a GitHub-mirrored comment carries none and keeps its old rule.
    workspace: v.optional(v.string()),
    // The worktree the batch belongs to. Two worktrees of one repository hold
    // separate batches, because they hold separate diffs.
    git_root: v.optional(v.string()),
    // A stamp of the diff the note was written against. The CLI recomputes it
    // and flags a note whose file has moved on, so a stale note never reaches
    // an agent pretending to be current.
    diff_identity: v.optional(v.string()),
    // When the note was handed to a session. Editing it clears this: a changed
    // note has not been sent.
    sent_at: v.optional(v.number()),
    // Where it was handed and in which message (the pending message's
    // client_id, which the delivered user message keeps), so the agent's
    // reply can be matched to it.
    sent_to_conversation_id: v.optional(v.id("conversations")),
    sent_client_id: v.optional(v.string()),
    // The agent reply that answers this note (lib/reviewAnswered): it quoted
    // the note, named its file and line, or answered a batch of this one note.
    answered_message_id: v.optional(v.id("messages")),
    answered_at: v.optional(v.number()),
    // ── Composer quotes (quoteDrafts.ts) ──
    // A quote on a block of an assistant message, waiting in its author's
    // composer to ride their next message. `client_id` is the batch item's id,
    // `content` its note, `conversation_id` the conversation it quotes. Its
    // author's alone, before and after sending; the send stamps `sent_*` and
    // lib/reviewAnswered stamps `answered_*` like any sent note. Every other
    // reader of this table skips these rows (isQuoteRow). Origin "comment"
    // marks a conversation comment (below).
    origin: v.optional(v.union(v.literal("quote"), v.literal("comment"))),
    message_id: v.optional(v.id("messages")),
    block_index: v.optional(v.number()),
    // The quoted text and where it sat (packages/comments/src/proseAnchor.ts).
    prose_anchor: v.optional(proseAnchorValidator),
    verdict: v.optional(v.union(v.literal("approve"), v.literal("cut"))),
    // ── Findings as promises (fix loop) ──
    // A line reviewer's finding, or a person's note, that was fixed, deferred
    // or rejected. A deferred finding is a promise: it needs an owner (a user
    // or a role) and a due date, refused otherwise at write time, and the
    // overdue sweep (reviewNotes.sweepOverduePromises) files one signal for it
    // under fingerprint promise:<id>, stamped in promise_signaled_at so it
    // never fires twice.
    disposition: v.optional(
      v.union(v.literal("fixed"), v.literal("deferred"), v.literal("rejected")),
    ),
    severity: v.optional(v.string()),
    owner_user_id: v.optional(v.id("users")),
    owner_role_id: v.optional(v.id("org_roles")),
    due_at: v.optional(v.number()),
    promise_task_id: v.optional(v.id("tasks")),
    promise_signaled_at: v.optional(v.number()),
    // ── Conversation comments (commentStore.ts, lib/conversationCommentRows) ──
    // Conversation comments live here: rows with origin "comment", and the
    // twins of `comments` rows written before the write path moved
    // (source_comment_id, the id such a comment still goes by). A comment's
    // pull request and GitHub id sit in their own fields, so no pull request
    // or GitHub reader of this table can reach one; every other reader skips
    // them (isConversationComment).
    source_comment_id: v.optional(v.id("comments")),
    source_pr_id: v.optional(v.id("pull_requests")),
    source_github_comment_id: v.optional(v.number()),
    agent_status: v.optional(
      v.union(
        v.literal("thinking"),
        v.literal("streaming"),
        v.literal("done"),
        v.literal("error"),
      ),
    ),
    fork_conversation_id: v.optional(v.id("conversations")),
    // ── A decision's team thread (decisionThread.ts) ──
    // A comment on a session decision, anchored by decision_id ALONE: never
    // conversation_id (conversation readers would take it in), never a twin,
    // a quote or a pending note. An agent row is a session's answer, written
    // as a placeholder (agent_status "thinking") when someone asks it;
    // `decision_session_id` names that session, and `decision_waiting` holds
    // while its reply can still land or grow. A pass or an escalation writes
    // an entry with `decision_event` and whom it went to.
    decision_id: v.optional(v.id("session_decisions")),
    decision_session_id: v.optional(v.id("conversations")),
    decision_waiting: v.optional(v.boolean()),
    decision_event: v.optional(
      v.union(v.literal("passed"), v.literal("escalated")),
    ),
    decision_event_to: v.optional(
      v.object({
        kind: v.union(v.literal("user"), v.literal("role")),
        ids: v.array(v.string()),
      }),
    ),
  })
    .index("by_decision", ["decision_id", "created_at"])
    .index("by_decision_waiting", ["decision_session_id", "decision_waiting"])
    .index("by_source_comment", ["source_comment_id"])
    .index("by_disposition_due", ["disposition", "due_at"])
    .index("by_owner_role", ["owner_role_id", "resolved"])
    .index("by_review", ["review_id"])
    .index("by_author_git_root", ["author_user_id", "git_root"])
    .index("by_pull_request", ["pull_request_id"])
    .index("by_github_comment_id", ["github_comment_id"])
    .index("by_repository_file", ["repository", "file_path"])
    .index("by_sent_conversation_answered", [
      "sent_to_conversation_id",
      "answered_at",
    ])
    .index("by_conversation", ["conversation_id"])
    .index("by_parent", ["parent_id"])
    .index("by_author_client_id", ["author_user_id", "client_id"]),
};

export const githubEventTables = {
  github_webhook_events: defineTable({
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
    processed: v.boolean(),
    created_at: v.number(),
    // Set on CI deliveries (check_run, check_suite, workflow_run): the
    // repository whose drain folds them (githubWebhooks.drainCiEvents).
    ci_repository: v.optional(v.string()),
    // Legacy: the stale-drain stamp before drain_markers. No longer written.
    ci_redrain_at: v.optional(v.number()),
  })
    .index("by_delivery_id", ["delivery_id"])
    .index("by_processed", ["processed"])
    .index("by_ci_pending", ["ci_repository", "processed"]),

  // Whether a drain is on its way for a key (lib/drainMarker.ts): a sync
  // outbox scope ("outbox:<scope>") or a repository's CI queue ("ci:<repo>").
  drain_markers: defineTable({
    key: v.string(),
    scheduled: v.boolean(),
    scheduled_at: v.number(),
  }).index("by_key", ["key"]),

  // Which event triggered a GitHub Actions check suite. A check_run names its
  // suite but not the event; the workflow_run delivery for the same suite does.
  github_check_suites: defineTable({
    repository: v.string(),
    suite_id: v.string(),
    event: v.string(),
    workflow_run_id: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_repository_suite", ["repository", "suite_id"]),

  github_app_installations: defineTable({
    // The codecast workspace that owns this credential (exactly one set): a
    // team, whose members act through it inside the team, or a person, who
    // acts through it in every workspace they work in.
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")),
    installation_id: v.number(),
    account_login: v.string(),
    account_type: v.union(v.literal("User"), v.literal("Organization")),
    account_id: v.number(),
    repository_selection: v.union(v.literal("all"), v.literal("selected")),
    repositories: v.optional(
      v.array(
        v.object({
          id: v.number(),
          name: v.string(),
          full_name: v.string(),
        }),
      ),
    ),
    suspended_at: v.optional(v.number()),
    installed_by_user_id: v.optional(v.id("users")),
    // Health stamps read by the integrations page. issue-sync.md S1.5.
    last_webhook_at: v.optional(v.number()),
    last_sync_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_team_id", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_installation_id", ["installation_id"])
    .index("by_account_login", ["account_login"]),

  // An install the server agreed to before GitHub was ever asked: who clicked
  // Install, at which scope, and for how long the answer stays valid. The
  // install URL carries only the nonce (hashed here, so the row is not itself
  // a bearer token), and the callback reads the principal back from this row
  // rather than from the request it was handed.
  github_app_install_intents: defineTable({
    nonce_hash: v.string(),
    user_id: v.id("users"),
    scope: v.union(v.literal("team"), v.literal("personal")),
    team_id: v.optional(v.id("teams")),
    created_at: v.number(),
    expires_at: v.number(),
    // Set the moment a callback spends it. A second callback carrying the same
    // nonce is a replay and binds nothing.
    consumed_at: v.optional(v.number()),
  }).index("by_nonce_hash", ["nonce_hash"]),

  github_installation_tokens: defineTable({
    installation_id: v.number(),
    // Absent on the installation-wide token the server's own work uses. Set to
    // `owner/name` on a token minted for one repository, which is what a cloud
    // host's git credential gets: same installation, narrower authority, so
    // the two are cached as separate rows and never answer for each other.
    repository: v.optional(v.string()),
    token: v.string(),
    expires_at: v.number(),
    // What GitHub said this token may do, as it was minted (`contents: write`
    // is push access). Cached beside the token so a caller can refuse a push
    // the App cannot perform without minting a second one. Absent on rows
    // cached before this was recorded, which reads as "unknown", never "no".
    permissions: v.optional(v.record(v.string(), v.string())),
    created_at: v.number(),
  })
    .index("by_installation_id", ["installation_id"])
    .index("by_installation_repo", ["installation_id", "repository"]),
};
