import { agentTaskRevisionValidator } from "../lib/agentTaskRevisionValidator";
import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  eventFilterValidator,
  pendingEventValidator,
} from "../lib/eventFilterValidator";

export const scheduleTables = {
  agent_tasks: defineTable({
    user_id: v.id("users"),
    // Human-quotable handle ("tr-42"), same counter-allocated shape as tasks
    // (ct-) and plans (pl-). Optional only for rows created before triggers had
    // one; `backfillShortIds` fills those, and every new row gets one at insert.
    // This is what agents quote in prose and what the web renders as a pill —
    // never the 32-char Convex id.
    short_id: v.optional(v.string()),
    title: v.string(),
    prompt: v.string(),
    context_summary: v.optional(v.string()),
    originating_conversation_id: v.optional(v.id("conversations")),
    // The originating conversation is a hosted assistant conversation (plan
    // pl-840), so the server dispatcher fires this routine on every
    // deployment. Stamped by insertTask and patchTask from the home; a
    // conversation never changes between hosted and local.
    hosted_home: v.optional(v.boolean()),
    target_conversation_id: v.optional(v.id("conversations")),
    // Conversation that CREATED this trigger — pure attribution, no routing
    // meaning. originating_conversation_id does double duty (its presence makes
    // runs inject into that session), so a --spawn trigger must leave it empty;
    // this field keeps the parent link anyway, so spawn triggers and their runs
    // still trace back to the session that armed them.
    created_by_conversation_id: v.optional(v.id("conversations")),
    // The creator's raw session uuid, kept when created_by_conversation_id
    // could not be resolved at insert (a trigger armed in the first seconds of
    // a session, before its conversation row synced). Resolved to a
    // conversation at read time by withResolvedRunConversations, exactly like
    // last_run_session_uuid, so the parent link never depends on sync order.
    created_by_session_uuid: v.optional(v.string()),
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    // Picker key for the model a SPAWNED run launches on (`opus`, `sonnet`,
    // or a codex model id) — resolved to the client's launch flag by the
    // daemon, same table as `cast spawn --model`. Absent = the agent's saved
    // default. Inline runs ignore it: they inject into a session that already
    // has a model.
    model: v.optional(v.string()),
    // `cast trigger add --as <name>`: the agent definition a SPAWNED run
    // launches as (resolved by the scheduler at run time).
    agent_definition: v.optional(v.string()),
    // Device that created the task (CLI `cast trigger add`). When set, only
    // that device's scheduler may claim it. Absent on web-created/legacy tasks,
    // which fall back to checkout-existence eligibility.
    created_device_id: v.optional(v.string()),

    schedule_type: v.union(
      v.literal("once"),
      v.literal("recurring"),
      v.literal("event"),
    ),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    // A recurring trigger's cadence slot, held only while run_at is off the
    // cadence (a manual run, a retry, a limit park: agentTasks.offCadence), so
    // the arming after the run returns to the cadence. Absent otherwise:
    // run_at is then the slot.
    cadence_slot_at: v.optional(v.number()),
    // A hosted routine said as a time of day (assistant/routines.ts
    // hostedWallCadence): the minutes past local midnight in `zone` and the
    // weekdays (0 is Sunday) it runs on. When set, each run is found on that
    // clock (@platform/assistant nextCadenceRun) and interval_ms is only the
    // nominal spacing the plan check reads. Absent for interval triggers.
    cadence: v.optional(
      v.object({
        zone: v.string(),
        minutes: v.number(),
        weekdays: v.array(v.number()),
      }),
    ),
    event_filter: v.optional(eventFilterValidator),
    // Events fired at this trigger since its last claim, newest last and
    // capped at PENDING_EVENTS_CAP (external-data.md X4). Two firings before a
    // claim are one run that knows about both; the claim clears them.
    pending_events: v.optional(v.array(pendingEventValidator)),

    mode: v.union(v.literal("propose"), v.literal("apply")),
    max_runtime_ms: v.optional(v.number()),
    // `cast trigger add --precheck "<shell command>"`: a gate the daemon runs
    // in project_path before a scheduled or recurring run. Exit 0 runs the
    // trigger; anything else records a skipped run and spends no session.
    // Event triggers ignore it — the webhook already IS the evidence.
    precheck: v.optional(v.string()),
    // How the precheck is read (packages/triggers/src/triggerPrecheck TriggerPrecheckMode):
    // absent is by exit code; `changes` wakes when its stdout changed since the
    // last firing; `state` reads a {wake, state, message} verdict it prints.
    precheck_mode: v.optional(
      v.union(v.literal("changes"), v.literal("state")),
    ),
    // What the next firing's precheck compares against: a `changes` gate's
    // stdout fingerprint, a `state` gate's state as JSON. Written by the daemon
    // after each firing (skipTaskRun, passTaskPrecheck); cleared when the gate
    // itself changes.
    precheck_state: v.optional(v.string()),
    // What the precheck reported when it woke the current run, for the run's
    // frame. Set by passTaskPrecheck, cleared at every claim.
    precheck_message: v.optional(v.string()),
    requested_run_source: v.optional(v.literal("manual")),
    // A focus a person gave the next run (org-staffing.md S24: "Plan the
    // goal tree" from the Head of People's thread): a key of
    // ORG_REVIEW_FOCUSES, carried into the run's frame and cleared when the
    // run completes. One trigger, one run path; the focus only narrows it.
    requested_run_focus: v.optional(v.string()),
    // A role's own part of its check (org-staffing.md S38): what it chose to
    // look at first, carried into the frame after the routine's prompt, and
    // why and when it last changed its cadence, gate or focus (`cast role
    // tune`). The prompt stays the product's; this is capped and the role's.
    role_focus: v.optional(v.string()),
    tune_why: v.optional(v.string()),
    tuned_at: v.optional(v.number()),
    last_run_source: v.optional(v.string()),
    // `cast trigger add --spawn --wake`: a clean report of a once run wakes
    // the session that armed it (runOwnerWakeOf) instead of only posting
    // there. Failures, deaths and --needs-attention wake it regardless.
    wake_creator: v.optional(v.boolean()),
    // The org role whose routine this is (org-staffing.md S25). A role's
    // session already knows how it works from its opening message, so its
    // routine carries no generic trigger lifecycle text.
    role_id: v.optional(v.id("org_roles")),
    // The role whose pause paused this trigger; its resume brings back only these (org-staffing.md S25).
    paused_by_role_id: v.optional(v.id("org_roles")),
    // The project this trigger feeds (project sources): pausing the project
    // pauses it, and unless project_spawn each run is a turn in the project's
    // main session, resolved at the firing (projectSources.fireProjectTrigger),
    // so it never stores originating_conversation_id.
    project_id: v.optional(v.id("projects")),
    // `--spawn` on a project trigger: runs start fresh sessions as any spawn trigger does.
    project_spawn: v.optional(v.boolean()),
    // The project whose pause paused this trigger; its resume brings back only these.
    paused_by_project_id: v.optional(v.id("projects")),
    // The key a web add painted its stub under; this row supersedes it (agentTasks collection altKey).
    client_key: v.optional(v.string()),

    status: v.union(
      v.literal("scheduled"),
      v.literal("running"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("failed"),
      // A retired role's triggers: cancelled, not completed, so nothing re-arms them.
      v.literal("cancelled"),
    ),
    lease_holder: v.optional(v.string()),
    lease_expires_at: v.optional(v.number()),
    retry_count: v.number(),
    max_retries: v.optional(v.number()),

    last_run_at: v.optional(v.number()),
    last_run_summary: v.optional(v.string()),
    // True when the last run ended in failTaskRun. Drives the panel's outcome
    // color and gates run auto-fold: a failed previous run must stay visible in
    // the inbox (escalation), only a clean run folds when the next one starts.
    last_run_failed: v.optional(v.boolean()),
    // A recurring trigger's firings in a row that failed after all their
    // retries (agentTasks.retriesSpentFields): it goes on at its next slot
    // until FAILED_SLOTS_TO_STOP, then ends failed. A clean run, a precheck
    // skip or a re-arm clears it.
    failed_slots: v.optional(v.number()),
    // Agent's explicit escalation from `cast trigger complete --needs-attention`:
    // the run neither auto-folds nor collapses under the schedule's standing row —
    // it stays a real inbox card until the user triages it.
    last_run_needs_attention: v.optional(v.boolean()),
    last_run_conversation_id: v.optional(v.id("conversations")),
    // Claude session UUID of the last spawned run. The daemon assigns it up front
    // via `claude --session-id`; webList resolves it to a conversation at read time
    // (by_session_id), so spawned runs are linkable even if the run's conversation
    // hadn't synced yet at completion. Absent for --context-current runs, which
    // record last_run_conversation_id directly.
    last_run_session_uuid: v.optional(v.string()),
    // A run parked at a usage limit keeps its session: the next firing
    // resumes it (`claude --resume`) instead of starting a fresh one, so one
    // firing stays one conversation and the agent continues where it stopped.
    // Set by agentTasks.parkRunAtLimit, consumed by the claim.
    parked_run_session_uuid: v.optional(v.string()),
    // Denormalized newest precheck skip, same role as last_run_* above: the
    // trigger rows and `cast trigger log` read one row, not the skip history.
    last_precheck_skip_at: v.optional(v.number()),
    /** When the firing now holding the lease was claimed: a lapsed lease is judged only by a run started after it. */
    firing_claimed_at: v.optional(v.number()),
    last_precheck_skip_reason: v.optional(v.string()),
    run_count: v.number(),
    created_at: v.number(),
    // Haiku-generated presentation fields (agentTasks.generateDisplaySummary).
    // Most titles are just prompt.slice(0, 60) — unreadable in rows — so the
    // model distills a short name and a one-sentence gist of what each run
    // does. Regenerated when the prompt changes; display_title yields to an
    // explicit human title.
    display_title: v.optional(v.string()),
    display_summary: v.optional(v.string()),
    // display_summary is written to the person (a hosted routine's summary
    // from schedule_routine, or the summarizer's person prompt), not the
    // developer gist of an agent's instruction. Hosted surfaces show only
    // such a summary (web triggerTasks.ts routineSummaryForPerson).
    summary_for_person: v.optional(v.boolean()),
    // Set when this schedule was canceled as a side effect of killing the
    // session it injects into (cancelTasksBoundToConversation) — distinguishes
    // that from a natural completion, so restoring the session can re-arm
    // exactly the schedules its kill took down. Cleared on reactivation.
    canceled_on_kill_at: v.optional(v.number()),
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
  })
    .index("by_share_token", ["share_token"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_run_at", ["user_id", "run_at"])
    .index("by_status_run_at", ["status", "run_at"])
    // The hosted routines a deployment with no cloud wake host still fires.
    .index("by_hosted_status_run_at", ["hosted_home", "status", "run_at"])
    // A firing reads only the triggers armed on its name (matchTaskTriggers).
    .index("by_status_event_type", ["status", "event_filter.event_type"])
    // A chat line asks only for the triggers watching its channel (lib/triggerMatch).
    .index("by_channel_status", ["event_filter.channel_id", "status"])
    // A page-state write asks only for the triggers watching its page (lib/triggerMatch).
    .index("by_page_status", ["event_filter.page_id", "status"])
    .index("by_short_id", ["short_id"])
    // Anchor lookups for conversation-scoped visibility (webListForConversation):
    // a trigger armed from a session is findable from that session even when a
    // different account (a remote daemon's bot login) owns the trigger row.
    .index("by_created_by_conversation", ["created_by_conversation_id"])
    .index("by_originating_conversation", ["originating_conversation_id"])
    .index("by_project", ["project_id"]),

  // Version history + audit log for trigger edits. One row per edit — both
  // `cast trigger update` and the web edit dialog write through
  // agentTasks.applyTaskUpdate, so neither surface can skip the log. Each row
  // snapshots ALL editable fields as they were BEFORE the edit, making every
  // row a complete prior version (no diff-walking to reconstruct one), and
  // names who changed what from where. The current version is the agent_tasks
  // row itself; `revision` is 1-based and monotonic per task.
  agent_task_revisions: defineTable({
    task_id: v.id("agent_tasks"),
    revision: v.number(),
    // Audit: who made the edit, from which surface.
    actor_user_id: v.id("users"),
    source: v.union(v.literal("cli"), v.literal("web")),
    // Field names the edit actually changed — the log line, without diffing.
    changed_fields: v.array(v.string()),
    // Complete pre-edit snapshot of the editable surface.
    before: agentTaskRevisionValidator,
    created_at: v.number(),
  }).index("by_task", ["task_id", "revision"]),

  // One row per run a precheck refused. A skipped run spawns no agent, so it
  // has no conversation — and conversations are what webListRuns projects a
  // run history from. Without a row of its own a skip would be invisible, and
  // "the trigger fired and did nothing" is exactly what the user needs to see.
  agent_task_precheck_skips: defineTable({
    task_id: v.id("agent_tasks"),
    user_id: v.id("users"),
    command: v.string(),
    // Absent when the command timed out or never started.
    exit_code: v.optional(v.number()),
    timed_out: v.boolean(),
    duration_ms: v.number(),
    // Tail of stdout+stderr, capped by TRIGGER_PRECHECK_OUTPUT_CHARS.
    output: v.optional(v.string()),
    reason: v.string(),
    source: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_task", ["task_id", "created_at"]),
};
