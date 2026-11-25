import { defineTable } from "convex/server";
import { v } from "convex/values";
import { changeGuideValidator } from "../lib/changeGuideValidator";
import { TASK_EFFORTS, TASK_PRIORITIES } from "@codecast/tasks/statuses";
import { taskWaitValidator } from "../lib/taskWaitValidator";
import { LINE_CATEGORIES } from "@codecast/goals/goalsBrief";
import { signalPlacedValidator } from "../lib/signalPlacedValidator";
import {
  predictedValidator,
  realisedValidator,
} from "../lib/predictionValidators";
import {
  taskExternalValidator,
  taskCommentExternalValidator,
} from "../issueSyncSchema";
import { taskStatusCategoryValidator } from "./task-status.tables";

export const taskTables = {
  tasks: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS, independent of team_id (which stays routing): "team:<id>" or
    // "user:<id>" — see lib/access.ts workspaceKey. Written at create,
    // recomputed only when a linked conversation's visibility changes.
    workspace: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),
    parent_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    // Client-minted idempotency key for optimistic creates: webCreate returns
    // the existing row for a repeat key, so a retried/replayed create (timeout
    // after commit, lost ack) never inserts a second task.
    client_key: v.optional(v.string()),
    short_id: v.string(),

    title: v.string(),
    // Generated 1-2 word NAME ("Auth redirect"), filled by the short-title
    // cron (titleGeneration.fillShortTitles) for rows that lack one; cleared
    // when the title changes so it regenerates. Reference pills show it on
    // repeat mentions in prose.
    short_title: v.optional(v.string()),
    description: v.optional(v.string()),
    task_type: v.union(
      v.literal("feature"),
      v.literal("bug"),
      v.literal("task"),
      v.literal("chore"),
    ),
    // The status CATEGORY — one of the six canonical values every index,
    // filter and close predicate keys on. A team's custom statuses refine it
    // via status_id below; this field never holds a custom value.
    status: taskStatusCategoryValidator,
    // Id of a team-defined status within the category (teams.task_statuses).
    // Absent = the category's default. Resolution falls back to the category
    // default when the id no longer exists, so deleting a status needs no
    // task migration.
    status_id: v.optional(v.string()),
    priority: v.union(...TASK_PRIORITIES.map((p) => v.literal(p))),

    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),

    // Manual list rank (fractional; unranked rows fall back to created_at,
    // which shares the ms scale so midpoint inserts stay consistent).
    sort_order: v.optional(v.number()),
    // Short id of the canonical task this one duplicates; set when a human
    // marks a duplicate (which also drops this task).
    duplicate_of: v.optional(v.string()),

    model: v.optional(v.string()),
    verify_with: v.optional(v.string()),
    max_visits: v.optional(v.number()),
    retry_target: v.optional(v.string()),
    thread_id: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    condition: v.optional(v.string()),

    // Dependencies
    blocked_by: v.optional(v.array(v.string())),
    blocks: v.optional(v.array(v.string())),
    // The task graph (docs/architecture/task-graph.md). Waits are blockers on
    // something that is not a task (TG2); every write goes through
    // taskWaits.writeWaits, which keeps waiting_since set exactly while one
    // is waiting. Events find their tasks through the target's back
    // reference (waiting_task_ids on the PR or decision), never a scan.
    waits: v.optional(v.array(taskWaitValidator)),
    waiting_since: v.optional(v.number()),
    // Links that do not block (TG5), all task short ids. related is mirrored
    // on both rows like blocks.
    found_during: v.optional(v.string()),
    superseded_by: v.optional(v.string()),
    related: v.optional(v.array(v.string())),
    // Execution hint read before spawning (TG8).
    effort: v.optional(v.union(...TASK_EFFORTS.map((e) => v.literal(e)))),
    // Bookkeeping kept out of default views, feed and notifications (TG9).
    ephemeral: v.optional(v.boolean()),

    // Session linkage
    conversation_ids: v.optional(v.array(v.id("conversations"))),
    // conversation_ids[0], indexed (lib/accessKeys.ts firstLinkedConversationStamp).
    first_linked_conversation: v.optional(v.id("conversations")),
    created_from_conversation: v.optional(v.id("conversations")),
    created_from_insight: v.optional(v.id("session_insights")),
    // The call this task was pulled from (a transcripts row). Set by `cast
    // task create --from-call`, `cast task update --call`, or the call page;
    // the call page lists its tasks through by_from_call.
    from_call: v.optional(v.id("transcripts")),
    last_session_summary: v.optional(v.string()),
    attempt_count: v.optional(v.number()),
    last_attempted_at: v.optional(v.number()),
    retry_count: v.optional(v.number()),
    max_retries: v.optional(v.number()),

    // Origin tracking. "agent" is the catch-all for a task an agent filed from
    // inside its own session; "meeting" is the narrower provenance for a task
    // an agent transcribed out of a human meeting, so the two can be told
    // apart in the UI (a meeting task represents something people agreed to do,
    // an agent task is usually machine bookkeeping). "template" and "fork" are
    // written by plans.instantiateTemplate / plans.fork — they were missing here,
    // so every insert on those two paths failed this validator at runtime.
    source: v.union(
      v.literal("human"),
      v.literal("agent"),
      v.literal("meeting"),
      v.literal("insight"),
      v.literal("import"),
      v.literal("plan_mode"),
      v.literal("todo_sync"),
      v.literal("template"),
      v.literal("fork"),
      v.literal("route"),
      // A cause the signal door opened (the-line-end-to-end.md LE4).
      v.literal("signal"),
    ),
    confidence: v.optional(v.number()),
    promoted: v.optional(v.boolean()),
    triage_status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("suggested"),
        v.literal("dismissed"),
      ),
    ),

    // Visibility (inherited from source conversation for mined tasks)
    is_private: v.optional(v.boolean()),
    team_visibility: v.optional(
      v.union(v.literal("summary"), v.literal("full"), v.literal("private")),
    ),

    // Drive state (iterative polish)
    drive: v.optional(
      v.object({
        current_round: v.number(),
        total_rounds: v.number(),
        rounds: v.array(
          v.object({
            round: v.number(),
            findings: v.array(v.string()),
            fixed: v.array(v.string()),
            deferred: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),

    // Structured execution (superpowers-style orchestration)
    steps: v.optional(
      v.array(
        v.object({
          title: v.string(),
          done: v.optional(v.boolean()),
          verification: v.optional(v.string()),
        }),
      ),
    ),
    acceptance_criteria: v.optional(v.array(v.string())),
    execution_status: v.optional(
      v.union(
        v.literal("done"),
        v.literal("done_with_concerns"),
        v.literal("blocked"),
        v.literal("needs_context"),
      ),
    ),
    execution_concerns: v.optional(v.string()),
    verification_evidence: v.optional(v.string()),
    files_changed: v.optional(v.array(v.string())),
    // The author's walkthrough of the change, written at handoff (ct-57527).
    change_guide: v.optional(changeGuideValidator),
    // The review station's verdict (docs/architecture/the-line.md L3).
    // Written by tasks.update alongside the status move; the independence
    // rule reads it when a role's session tries to close the task.
    review_verdict: v.optional(
      v.object({
        verdict: v.union(
          v.literal("approve"),
          v.literal("changes"),
          v.literal("reject"),
        ),
        by_conversation_id: v.optional(v.id("conversations")),
        at: v.number(),
        note: v.optional(v.string()),
      }),
    ),
    estimated_minutes: v.optional(v.number()),
    actual_minutes: v.optional(v.number()),
    started_at: v.optional(v.number()),
    agent_session_id: v.optional(v.string()),
    wave_number: v.optional(v.number()),
    priority_weight: v.optional(v.number()),
    last_heartbeat: v.optional(v.number()),
    progress_pct: v.optional(v.number()),

    // Workflow binding
    workflow_run_id: v.optional(v.id("workflow_runs")),
    workflow_node_id: v.optional(v.string()),

    project_path: v.optional(v.string()),

    created_at: v.number(),
    // Stamped by every task_comments insert (insertTaskComment): the one field
    // that tells a replica "a joined comment changed" — the sync log carries
    // task rows only, so this is the refetch trigger for cached comments.
    last_comment_at: v.optional(v.number()),
    updated_at: v.number(),
    closed_at: v.optional(v.number()),
    // The newest commit that names this task and landed on its repository's
    // default branch (a push webhook, lib/taskLanded): a fix merged by hand or
    // committed straight to main, which no run of the line recorded.
    landed: v.optional(
      v.object({
        sha: v.string(),
        at: v.number(),
        url: v.string(),
        repository: v.string(),
        branch: v.string(),
      }),
    ),
    // Provider twin: a Linear issue or a GitHub issue backing this task.
    // Server authored only. docs/architecture/issue-sync.md S1.1.
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
    external: v.optional(taskExternalValidator),

    // The line, end to end (docs/architecture/the-line-end-to-end.md).
    // A cause is a task signals attach to (LE4): how many, when, and the
    // fingerprints that reach it. Written by signals.ts only.
    cause: v.optional(
      v.object({
        signal_count: v.number(),
        first_seen: v.number(),
        last_seen: v.number(),
        fingerprints: v.array(v.string()),
        // Bring findings (learning-loop.md LL3): the product's issue this
        // problem is. One key, one problem; a second key arrives only through
        // a merge, and is listed in merged_keys.
        issue_key: v.optional(v.string()),
        merged_keys: v.optional(v.array(v.string())),
        // Set on a problem folded into another by a merge (also dropped, with
        // duplicate_of naming the survivor).
        merged_into: v.optional(v.id("tasks")),
        // The issue key this one was split off from.
        split_from: v.optional(v.string()),
        // Set when a line closed it without a change (`cast line dissolve`):
        // when, and the reason a person reads; for a problem already fixed, when
        // the fix went live. Findings from before the fix (else the close) still
        // join it (findingGroups.absorbsFinding); one from after the fix reopens
        // it (findingGroups.recursAfterFix).
        // coaching: no code or prompt to change; the person on Union's side who
        // missed it is coached, by the role named here (or its name when no role).
        // `quiet`: closed by its live flow's bar for waiting with no new finding (liveFlowQuiet.ts); fixed_at is then the close.
        dissolved: v.optional(
          v.object({
            at: v.number(),
            note: v.string(),
            fixed_at: v.optional(v.number()),
            quiet: v.optional(v.boolean()),
            coaching: v.optional(
              v.object({
                owner: v.string(),
                role_id: v.optional(v.id("org_roles")),
              }),
            ),
          }),
        ),
        // When findings last joined it after it opened (a move, a merge, or a
        // finding attached to it): a trial problem regrouped since its last run
        // is due a new one (lineTrial.dispatch).
        joined_at: v.optional(v.number()),
        // How many findings it held when the ground step wrote its note
        // (lineGround.regroundWhenRegrouped): the note quotes what it read.
        grounded_count: v.optional(v.number()),
        // How its project was decided (lib/signalPlacement.ts, the-line-model.md
        // LM1): settled by the expectation its first signal breaks, the filer or
        // a single-purpose source; a default or nothing, which the ground step
        // replaces with its own placement ("ground"). Absent on problems opened
        // before it was kept, and on ones a person made.
        placed: v.optional(signalPlacedValidator),
        // The title and the findings on the problem when it was written
        // (lineRetitle.ts): once none of them is left, the problem is renamed
        // from the findings on it now.
        titled: v.optional(
          v.object({ title: v.string(), from: v.array(v.string()) }),
        ),
        // The problem's name in a list (lineRetitle.ts): one clause under 80
        // characters, no ids, written for `for`, the title it names. A title
        // short enough to list needs none; a new title is named again.
        named: v.optional(v.object({ name: v.string(), for: v.string() })),
        // The value of fixing it and the family of its cause (problemScores.ts,
        // learning-loop.md LL15): written by the scoring pass, read by the
        // line's ranking and the Problems view. `version` is the prompt's
        // SCORE_VERSION; the cluster is dropped when a new score is written.
        scored: v.optional(
          v.object({
            score: v.number(),
            harm: v.number(),
            reach: v.number(),
            fixability: v.number(),
            reason: v.string(),
            root_cause: v.string(),
            cluster_key: v.optional(v.string()),
            cluster_name: v.optional(v.string()),
            at: v.number(),
            version: v.string(),
          }),
        ),
      }),
    ),
    // The ground node's fields (LE5): the goal the cause threatens ("none"
    // parks it), what kind of change it needs, how much review it needs, and
    // whether it can be worked as it stands.
    goal_ref: v.optional(v.string()),
    // Derived from LINE_CATEGORIES, the ground prompt's own list, so the
    // stored field, the ground validator and the prompt cannot disagree.
    // `line` is a change to the project's line itself (line-map.md LX6).
    category: v.optional(v.union(...LINE_CATEGORIES.map((c) => v.literal(c)))),
    risk: v.optional(
      v.union(v.literal("low"), v.literal("review"), v.literal("plan")),
    ),
    readiness: v.optional(
      v.union(
        v.literal("ready"),
        v.literal("needs_context"),
        v.literal("not_actionable"),
      ),
    ),
    readiness_note: v.optional(v.string()),
    // The watch after ship (LE12): a signal on one of the cause's
    // fingerprints before this time reopens it, when what it saw happened
    // after watch_from, the moment the fix went live (signals.ts watchReopens).
    watch_from: v.optional(v.number()),
    watch_until: v.optional(v.number()),
    // When a watch ended quiet and closed the cause as resolved (LE12).
    // Cleared by a reopen.
    resolved_at: v.optional(v.number()),
    // The change card's published page (LE10).
    card_slug: v.optional(v.string()),
    // The effect on a goal metric this change is expected to have, and what
    // the metric did after ship (packages/goals/src/predictedEffect.ts). A goal
    // reads its predictions from here, by the goal each one serves
    // (by_workspace_prediction).
    predicted: v.optional(predictedValidator),
    realised: v.optional(realisedValidator),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_project_id", ["project_id"])
    .index("by_project_status", ["project_id", "status"])
    // A project's tasks in one status, newest touched first: `cast task ls
    // --project` stops at its limit instead of reading the project (10k
    // unfinished rows under one project timed the list out, 2026-11-10).
    .index("by_project_status_updated", ["project_id", "status", "updated_at"])
    // The same read over one triage state, so a list without mined rows
    // does not walk past thousands of suggested problems to find real work.
    .index("by_project_triage_status_updated", [
      "project_id",
      "triage_status",
      "status",
      "updated_at",
    ])
    // A project's real work without its untriaged rows (org resolveScope): a
    // review files thousands of suggested problems under one project.
    .index("by_project_triage", ["project_id", "triage_status"])
    // Sparse: tasks filed under a plan. Powers the org scope feed (docs/
    // architecture/scopes-and-feed.md F2) reading a plan's tasks directly.
    .index("by_plan_id", ["plan_id"])
    .index("by_parent_id", ["parent_id"])
    .index("by_share_token", ["share_token"])
    .index("by_short_id", ["short_id"])
    // Sparse: only tasks with a wait still waiting (TG2).
    .index("by_waiting_since", ["waiting_since"])
    // Sparse: what was found while working on a task (TG5).
    .index("by_found_during", ["found_during"])
    .index("by_short_title", ["short_title"])
    // Sparse in practice: only causes in watch (LE12) carry watch_until;
    // signals.sweepWatches reads the ended ones.
    .index("by_watch_until", ["watch_until"])
    .index("by_prediction_due", ["predicted.due_at"])
    .index("by_workspace_prediction", ["workspace", "predicted.goal"])
    // Sparse in effect: a problem whose fix landed on its default branch (tasks.landed). The deploy stage reads a
    // workspace's landed fixes here beside the line runs' merges (deploys.md DP2).
    .index("by_workspace_landed", ["workspace", "landed.at"])
    .index("by_client_key", ["user_id", "client_key"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_team_updated", ["team_id", "updated_at"])
    .index("by_workspace", ["workspace"])
    // A workspace's tasks touched in a trailing window (page data readers).
    .index("by_workspace_updated", ["workspace", "updated_at"])
    // Ordered by updated_at within a status: a live query tab reads the most
    // recently touched open tasks, not the newest created.
    .index("by_workspace_status", ["workspace", "status", "updated_at"])
    // LE6: the open causes in a whole workspace role's boundary.
    .index("by_workspace_source_status", ["workspace", "source", "status"])
    // LE5: the open causes no one has grounded yet (readiness unset), which
    // lineGround.sweep grounds before admission can rank them.
    .index("by_source_status_readiness", ["source", "status", "readiness"])
    // The line sweep's candidate reads (orgLine.linePool): open, ready causes of
    // one scope project, or of one workspace for a whole workspace role, oldest
    // first, so a pass reads only the window it ranks, however long the backlog.
    .index("by_project_source_status_readiness", [
      "project_id",
      "source",
      "status",
      "readiness",
    ])
    .index("by_workspace_source_status_readiness", [
      "workspace",
      "source",
      "status",
      "readiness",
    ])
    // A live flow's queue (liveFlows.ts): a workspace's open, ready causes by
    // their scored value, so the queue reads its head without the backlog.
    .index("by_workspace_source_status_readiness_score", [
      "workspace",
      "source",
      "status",
      "readiness",
      "cause.scored.score",
    ])
    .index("by_created_from_conversation", ["created_from_conversation"])
    .index("by_first_linked_conversation", ["first_linked_conversation"])
    .index("by_from_call", ["from_call"])
    .index("by_assignee_status", ["assignee", "status"])
    .index("by_assignee_updated", ["assignee", "updated_at"])
    // The provider twin lookup: every inbound issue event resolves its task
    // through this one index. issue-sync.md S1.1.
    .index("by_external", ["external.provider", "external.id"])
    // `cast task ls -q` searches one workspace's titles here (tasks.listTasksCore):
    // filtering a whole open set in memory ran out of memory on a large team.
    .searchIndex("search_tasks_v2", {
      searchField: "title",
      filterFields: ["user_id", "project_id", "status", "workspace"],
    }),
};

export const taskCommentTables = {
  task_comments: defineTable({
    task_id: v.id("tasks"),
    author: v.string(),
    // The writer when a person wrote it. Absent on agent and system rows, so
    // the Threads unread rule counts them as someone else's.
    author_user_id: v.optional(v.id("users")),
    text: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    comment_type: v.union(
      v.literal("progress"),
      v.literal("blocker"),
      v.literal("review"),
      v.literal("note"),
    ),
    image_storage_ids: v.optional(v.array(v.string())),
    // Provider twin of this comment (Linear comment / GitHub issue comment).
    // Set when pulled from the provider or once a pushed comment gets its id
    // back. docs/architecture/issue-sync.md S1.2, S4.
    external: v.optional(taskCommentExternalValidator),
    // A person's comment reached the session that owns the task while it was
    // working (tasks.ts deliverCommentToOwner): the thread says so under it.
    delivered_to_conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
  })
    .index("by_task_id", ["task_id"])
    .index("by_task_created", ["task_id", "created_at"])
    .index("by_external", ["external.provider", "external.id"]),
};

export const taskHistoryTables = {
  task_history: defineTable({
    task_id: v.id("tasks"),
    user_id: v.optional(v.id("users")),
    actor_type: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("system"),
    ),
    action: v.string(),
    field: v.optional(v.string()),
    old_value: v.optional(v.string()),
    new_value: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
  }).index("by_task_id", ["task_id"]),
};
