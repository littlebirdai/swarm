import { defineTable } from "convex/server";
import { v } from "convex/values";
import { signalPlacedValidator } from "../lib/signalPlacedValidator";

export const signalTables = {
  // One observation from the world, typed by the finder that saw it
  // (docs/architecture/the-line-end-to-end.md LE3). Written only through
  // signals.ingest, which attaches it to a cause task (LE4). workspace and
  // team_id are stamped from the same data context a task create uses.
  signals: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    short_id: v.string(),
    source: v.string(),
    kind: v.union(
      v.literal("bug"),
      v.literal("regression"),
      v.literal("prompt_miss"),
      v.literal("ux"),
      v.literal("cohesion"),
      v.literal("request"),
    ),
    fingerprint: v.string(),
    title: v.string(),
    detail_md: v.optional(v.string()),
    evidence_url: v.optional(v.string()),
    subject: v.optional(v.string()),
    goal_hint: v.optional(v.string()),
    observed_at: v.number(),
    // The earliest the behavior it reports can have happened, when that is
    // earlier than observed_at: 0 for a review of a whole history, which
    // cannot date what it found. Whether it shows a fix failing reads this
    // (findingGroups.evidenceAt).
    happened_after: v.optional(v.number()),
    created_at: v.number(),
    // The cause it reached; absent while the signal is held: no open cause
    // holds its key and nothing converted it into one (LE4).
    task_id: v.optional(v.id("tasks")),
    // The project of the cause it reached, else the one it was filed into
    // (line-profile.md LP1).
    project_id: v.optional(v.id("projects")),
    // Set when the finder filed it for a project other than its cause's: a
    // fingerprint attaches across the workspace (the-line-end-to-end.md LE4).
    filed_for_project_id: v.optional(v.id("projects")),
    // How the project it was filed for was decided (lib/signalPlacement.ts);
    // a held signal placed later opens its problem with the same standing.
    placed: v.optional(signalPlacedValidator),
    // "similar": grouping put it on the problem whose findings read the same (learning-loop.md LL9).
    // "message": a problem already held its message under another expectation (signals.ts messageCause).
    attach: v.union(
      v.literal("fingerprint"),
      v.literal("message"),
      v.literal("judge"),
      v.literal("similar"),
      v.literal("new"),
      v.literal("person"),
      v.literal("held"),
    ),
    // The moment a codecast judge read when it made this finding (mo-N,
    // learning-loop.md LL8); judge, judge_version and severity name the rest.
    moment: v.optional(v.string()),
    // The moments whose newest run of this finding's judge files it (mo-N):
    // one message shows in several moments (a contact's conversation and each
    // match of it), so a finding leaves only when none of them files it any
    // more (judgeRetire.settleRun). Absent on rows from before it was kept.
    held_by: v.optional(v.array(v.string())),
    // Set when this signal reopened a cause in watch (LE12).
    reopened: v.optional(v.boolean()),
    // The role whose line run introduced the defect this signal names (the
    // fix-loop finder, fingerprint szz:<sha>); read by orgHealth per role.
    role_id: v.optional(v.id("org_roles")),
    // A finding a product's judge made (learning-loop.md LL3): which judge,
    // which version of it, and how bad it rated what it saw.
    judge: v.optional(v.string()),
    judge_version: v.optional(v.string()),
    severity: v.optional(v.number()),
    // Issue lineage (LL3): the issue key this row's issue was merged into, so
    // the old key resolves to the survivor's problem; and the key a split
    // moved it off (its fingerprint is then the new issue's key).
    merged_into: v.optional(v.string()),
    split_from: v.optional(v.string()),
    // The problem a merge moved this finding off (signals.foldProblem), so the
    // merge can be undone exactly (signals.unfoldProblem).
    folded_from: v.optional(v.id("tasks")),
    // A judge's finding marked wrong, and what diagnosing it found
    // (learning-loop.md LL11, convex/judgeReview.ts). The finding stays where
    // it was filed; the case it became is a signal of its own (case_of).
    judge_review: v.optional(
      v.object({
        // label: a person marked the decision wrong. dissolve: a line run's
        // proof found the judge had scored a good moment as a break.
        trigger: v.union(v.literal("label"), v.literal("dissolve")),
        by: v.optional(v.id("users")),
        run_id: v.optional(v.id("workflow_runs")),
        // The person's words, and what a correct judgment of the moment does.
        note: v.optional(v.string()),
        sentence: v.optional(v.string()),
        at: v.number(),
        state: v.union(
          v.literal("waiting"),
          v.literal("diagnosing"),
          v.literal("diagnosed"),
          v.literal("failed"),
        ),
        // Why it is still waiting, in words.
        waiting_on: v.optional(v.string()),
        attempts: v.number(),
        diagnosis_run_id: v.optional(v.id("workflow_runs")),
        // The one question: was the fact the judge needed missing from what
        // it saw, or there and misread; upheld when the records show the
        // finding was right after all.
        answer: v.optional(
          v.union(
            v.literal("missing"),
            v.literal("misread"),
            v.literal("upheld"),
          ),
        ),
        fact: v.optional(v.string()),
        why: v.optional(v.string()),
        // What the case was filed against, and the case.
        against: v.optional(
          v.union(
            v.literal("judge"),
            v.literal("input"),
            v.literal("extractor"),
          ),
        ),
        case_id: v.optional(v.id("signals")),
        diagnosed_at: v.optional(v.number()),
      }),
    ),
    // Held because grouping could not compare it when it came in (the budget refused, or the embedding failed), with
    // the words grouping reads; the sweep groups it once there is room, where filing it as new opened a problem each.
    awaiting_grouping: v.optional(
      v.object({ since: v.number(), text: v.string() }),
    ),
    // On a case against a judge (LL11): the finding it was made from.
    case_of: v.optional(v.id("signals")),
    // A judge's finding withdrawn because a newer judging of its moment
    // (a later judge version, or the same moment judged again) did not find
    // it (moments.ts rejudge). It leaves its problem; task_id there is the
    // problem it was on, kept so the record can say where it came from.
    retired: v.optional(
      v.object({
        at: v.number(),
        reason: v.string(),
        task_id: v.optional(v.id("tasks")),
        judge_version: v.optional(v.string()),
      }),
    ),
    // A finding that asks a person to act (an agent's escalation, personAsk.ts) that a person said is done: it
    // leaves For you (line-journeys.md LJ6.1 `ask`). The finding stays where it was filed.
    ask_done: v.optional(v.object({ at: v.number(), by: v.id("users") })),
  })
    // Wrong findings by where their diagnosis stands (LL11), for the sweep.
    .index("by_judge_review_state", ["judge_review.state"])
    .index("by_workspace_fingerprint", ["workspace", "fingerprint"])
    // The keys merged into an issue (LL3), for an issue with no finding of its own yet.
    .index("by_workspace_merged_into", ["workspace", "merged_into"])
    .index("by_project_created", ["project_id", "created_at"])
    .index("by_task", ["task_id", "created_at"])
    // A problem's withdrawn findings (judgeRetire), so a card on it can say where its evidence went.
    .index("by_retired_task", ["retired.task_id"])
    .index("by_workspace_created", ["workspace", "created_at"])
    // The line's feed (signals.webList): a workspace's live findings, newest first. A withdrawn finding (retired) is
    // read nowhere on the line, and a judge withdraws most of what it files when it judges a moment again, so
    // reading past them spent the feed's cap on rows every reader drops.
    .index("by_workspace_live_created", ["workspace", "retired", "created_at"])
    // A line's breaks (the-line-model.md LM5): a judge files the expectation
    // id it breaks as the subject, and the expectations page counts them.
    .index("by_workspace_subject", ["workspace", "subject", "created_at"])
    // One finder's findings, newest first (cast signal ls --source): a window of the whole workspace held a few
    // hours of them once a judge filed 60 an hour (Oct 26).
    .index("by_workspace_source_created", ["workspace", "source", "created_at"])
    // Findings held because grouping could not compare them, oldest first, for the sweep (findingRegroup.groupAwaiting).
    .index("by_awaiting_grouping", ["awaiting_grouping.since"])
    .index("by_short_id", ["short_id"]),

  orchestration_events: defineTable({
    user_id: v.id("users"),
    plan_id: v.optional(v.id("plans")),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.union(
      v.literal("agent_spawned"),
      v.literal("agent_completed"),
      v.literal("agent_failed"),
      v.literal("agent_timeout"),
      v.literal("task_completed"),
      v.literal("task_blocked"),
      v.literal("task_needs_context"),
      v.literal("merge_succeeded"),
      v.literal("merge_failed"),
      v.literal("wave_started"),
      v.literal("drive_round_started"),
      v.literal("drive_round_completed"),
      v.literal("plan_completed"),
      v.literal("retro_generated"),
      v.literal("verification_spawned"),
    ),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
    created_at: v.number(),
  })
    .index("by_plan_id", ["plan_id", "created_at"])
    .index("by_plan_short_id", ["plan_short_id", "created_at"])
    .index("by_user_id", ["user_id", "created_at"]),

  progress_events: defineTable({
    user_id: v.id("users"),
    plan_id: v.optional(v.id("plans")),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.string(),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
    sequence: v.number(),
    created_at: v.number(),
  })
    .index("by_plan_short_id", ["plan_short_id", "sequence"])
    .index("by_plan_id", ["plan_id", "sequence"])
    .index("by_user_id", ["user_id", "created_at"]),
};
