import { defineTable } from "convex/server";
import { v } from "convex/values";
import { externalEventDataValidator } from "../ingestSchema";

export const externalEventTables = {
  // External activity as first class events: one row per commit, push, PR
  // change, review, check result, merge, merge-state change, code comment,
  // or issue change (GitHub issues, Linear). Written only by
  // externalEvents.record (deduped by dedupe_key). Every event names the
  // codecast objects it belongs to so it can be rendered inline in the
  // transcript, the team feed and the task, plan and project timelines by
  // one component. Access follows the PR/commit rule: team membership, or
  // access to the linked conversation.
  external_events: defineTable({
    // Required on git and issue rows. Absent only on an ingestion row from a
    // personal workspace source, which has no team (external-data.md X1).
    team_id: v.optional(v.id("teams")),
    // github | linear | codecast
    source: v.string(),
    // owner/name for git events; absent for issue trackers without a repo.
    repository: v.optional(v.string()),
    // Git kinds: commit | push | pr_opened | pr_synchronize | pr_review
    // | pr_review_comment | pr_check | pr_merged | pr_closed | pr_reopened
    // | pr_behind | pr_conflict | pr_ready | pr_review_requested
    // | pr_ready_for_review | pr_draft | pr_edited | code_comment
    // Ship kinds (Changes, spec 7.3): release (a version tag push) | deploy
    // (cast ship mark); meta carries surface, version and tag.
    // Issue kinds (issue sync): issue_opened | issue_assigned | issue_closed
    // | issue_reopened | issue_commented | issue_status | issue_edited
    kind: v.string(),
    actor_login: v.optional(v.string()),
    actor_avatar_url: v.optional(v.string()),
    actor_user_id: v.optional(v.id("users")),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    sha: v.optional(v.string()),
    branch: v.optional(v.string()),
    pr_id: v.optional(v.id("pull_requests")),
    pr_number: v.optional(v.number()),
    commit_id: v.optional(v.id("commits")),
    comment_id: v.optional(v.id("review_comments")),
    // The external issue this event is about (issue sync).
    issue: v.optional(
      v.object({
        provider: v.string(),
        key: v.string(),
        url: v.optional(v.string()),
        title: v.optional(v.string()),
      }),
    ),
    conversation_id: v.optional(v.id("conversations")),
    // task_id is the first linked task (indexed); task_ids is the full set.
    task_id: v.optional(v.id("tasks")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    plan_ids: v.optional(v.array(v.id("plans"))),
    project_ids: v.optional(v.array(v.id("projects"))),
    meta: v.optional(
      v.object({
        status: v.optional(v.string()),
        conclusion: v.optional(v.string()),
        check_name: v.optional(v.string()),
        review_state: v.optional(v.string()),
        file_path: v.optional(v.string()),
        line_number: v.optional(v.number()),
        additions: v.optional(v.number()),
        deletions: v.optional(v.number()),
        files_changed: v.optional(v.number()),
        commit_count: v.optional(v.number()),
        behind_by: v.optional(v.number()),
        mergeable_state: v.optional(v.string()),
        base_ref: v.optional(v.string()),
        head_ref: v.optional(v.string()),
        pr_state: v.optional(v.string()),
        shepherd_state: v.optional(v.string()),
        surface: v.optional(v.string()),
        version: v.optional(v.string()),
        tag: v.optional(v.string()),
        // The deploy object a deploy marker recorded or finished (deploys.short_id).
        deploy: v.optional(v.string()),
      }),
    ),
    // Ingestion rows (external-data.md X3): a group transition or a deploy a
    // source reported. `workspace` is their access key (equality, like
    // signals); git and issue rows keep the team rule and leave these unset.
    workspace: v.optional(v.string()),
    source_id: v.optional(v.id("event_sources")),
    group_id: v.optional(v.id("event_groups")),
    data: v.optional(externalEventDataValidator),
    dedupe_key: v.string(),
    created_at: v.number(),
  })
    .index("by_team_created", ["team_id", "created_at"])
    // listForTeam and the Changes scans read source_id = undefined here, so a
    // noisy product never pushes git activity out of the team feed.
    .index("by_team_source_created", ["team_id", "source_id", "created_at"])
    .index("by_source_created", ["source_id", "created_at"])
    .index("by_workspace_created", ["workspace", "created_at"])
    .index("by_repository_created", ["repository", "created_at"])
    .index("by_pr_created", ["pr_id", "created_at"])
    .index("by_conversation_created", ["conversation_id", "created_at"])
    .index("by_task_created", ["task_id", "created_at"])
    .index("by_dedupe_key", ["dedupe_key"]),
};
