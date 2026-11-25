import { defineTable } from "convex/server";
import { v } from "convex/values";
import { messagingPolicyValidator } from "../lib/messagingPolicyValidator";

// The entity kinds that can participate in entity-conversation links.
const linkableEntityTypeValidator = v.union(
  v.literal("task"),
  v.literal("plan"),
);

export const planTables = {
  // Entity-to-conversation association. Messages stay in the existing
  // conversations/messages substrate; this row only records that a conversation
  // relates to a Task/Plan and how. Existing direct task/plan conversation
  // fields remain part of their existing execution surfaces; new associations
  // also write here (see dispatch.linkConversationToObject).
  //
  // A row whose conversation / task / plan side is hard-deleted lingers:
  // reads re-check access and omit danglers (no leak) and unlink can clear
  // them, so a GC hook on those deleters is deliberately deferred.
  entity_conversations: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    entity_type: linkableEntityTypeValidator,
    entity_id: v.string(),
    conversation_id: v.id("conversations"),
    relationship: v.union(
      v.literal("discussion"),
      v.literal("work"),
      v.literal("investigation"),
      v.literal("evidence"),
    ),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_conversation", ["conversation_id"]),

  plans: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),
    project_path: v.optional(v.string()),
    short_id: v.string(),
    title: v.string(),
    // Generated 1-2 word NAME ("Auth redirect"), filled by the short-title
    // cron (titleGeneration.fillShortTitles) for rows that lack one; cleared
    // when the title changes so it regenerates. Reference pills show it on
    // repeat mentions in prose.
    short_title: v.optional(v.string()),
    description: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("done"),
      v.literal("abandoned"),
    ),
    source: v.union(
      v.literal("human"),
      v.literal("agent"),
      v.literal("insight"),
      v.literal("promoted"),
      v.literal("plan_mode"),
      v.literal("imported"),
    ),
    owner_id: v.optional(v.id("users")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    progress: v.optional(
      v.object({
        total: v.number(),
        done: v.number(),
        in_progress: v.number(),
        open: v.number(),
      }),
    ),
    progress_log: v.optional(
      v.array(
        v.object({
          timestamp: v.number(),
          entry: v.string(),
          session_id: v.optional(v.string()),
        }),
      ),
    ),
    decision_log: v.optional(
      v.array(
        v.object({
          timestamp: v.number(),
          decision: v.string(),
          rationale: v.optional(v.string()),
          session_id: v.optional(v.string()),
        }),
      ),
    ),
    discoveries: v.optional(
      v.array(
        v.object({
          timestamp: v.number(),
          finding: v.string(),
          session_id: v.optional(v.string()),
        }),
      ),
    ),
    context_pointers: v.optional(
      v.array(
        v.object({
          label: v.string(),
          path_or_url: v.string(),
        }),
      ),
    ),
    // Unified comment/entry timeline (replaces progress_log, decision_log, discoveries, context_pointers for new writes)
    entries: v.optional(
      v.array(
        v.object({
          type: v.union(
            v.literal("progress"),
            v.literal("decision"),
            v.literal("discovery"),
            v.literal("reference"),
            v.literal("blocker"),
            v.literal("note"),
            // The shared log's entries (cast plan comment --type fail|interface);
            // a fact is stored as "discovery".
            v.literal("fail"),
            v.literal("interface"),
          ),
          timestamp: v.number(),
          session_id: v.optional(v.string()),
          content: v.string(),
          author: v.optional(v.string()),
          rationale: v.optional(v.string()),
          path_or_url: v.optional(v.string()),
          // The writer's checkout when it wrote: short HEAD, "+dirty" with uncommitted changes.
          commit: v.optional(v.string()),
        }),
      ),
    ),
    session_ids: v.optional(v.array(v.id("conversations"))),
    current_session_id: v.optional(v.id("conversations")),
    created_from_conversation_id: v.optional(v.id("conversations")),
    created_from_insight_id: v.optional(v.id("session_insights")),
    doc_id: v.optional(v.id("docs")),
    plan_version: v.optional(v.number()),
    drive_state: v.optional(
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
    model_stylesheet: v.optional(v.string()),
    fidelity: v.optional(
      v.union(
        v.literal("full"),
        v.literal("compact"),
        v.literal("summary_high"),
        v.literal("summary_medium"),
        v.literal("summary_low"),
        v.literal("truncate"),
      ),
    ),
    retro: v.optional(
      v.object({
        smoothness: v.string(),
        headline: v.string(),
        learnings: v.array(v.any()),
        friction_points: v.array(v.any()),
        open_items: v.array(v.any()),
        generated_at: v.number(),
      }),
    ),
    join_policy: v.optional(
      v.union(
        v.literal("wait_all"),
        v.literal("first_success"),
        v.literal("k_of_n"),
        v.literal("quorum"),
      ),
    ),
    join_k: v.optional(v.number()),
    // How the plan's agents share findings; absent = "lead" (lib/messagingPolicyValidator).
    messaging_policy: v.optional(messagingPolicyValidator),
    orchestration_metadata: v.optional(
      v.object({
        wave_count: v.optional(v.number()),
        last_wave_at: v.optional(v.number()),
        agent_count: v.optional(v.number()),
        last_orchestrated_at: v.optional(v.number()),
      }),
    ),
    escalation_log: v.optional(
      v.array(
        v.object({
          task_id: v.optional(v.string()),
          reason: v.string(),
          created_at: v.number(),
          resolved: v.optional(v.boolean()),
        }),
      ),
    ),

    // Workflow binding
    workflow_id: v.optional(v.id("workflows")),
    workflow_run_id: v.optional(v.id("workflow_runs")),

    // Public sharing
    share_token: v.optional(v.string()),

    // ── Charter (docs/architecture/org-staffing.md S7); `goal` above is the
    // program's goal, these complete it.
    success_metrics: v.optional(v.array(v.string())),
    priority: v.optional(
      v.union(
        v.literal("p0"),
        v.literal("p1"),
        v.literal("p2"),
        v.literal("p3"),
      ),
    ),
    owner_role_id: v.optional(v.id("org_roles")),
    non_goals: v.optional(v.array(v.string())),

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
    .index("by_short_title", ["short_title"])
    .index("by_share_token", ["share_token"])
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_workspace", ["workspace"])
    .index("by_created_from_conversation_id", ["created_from_conversation_id"])
    .index("by_project_id", ["project_id"])
    .index("by_doc_id", ["doc_id"]),

  // How far each session has read its plan's shared log (plans with
  // messaging_policy "shared-log"): planLog.unread delivers each fact, fail and
  // interface entry once per session, then moves read_at past it.
  plan_log_reads: defineTable({
    conversation_id: v.id("conversations"),
    plan_id: v.id("plans"),
    read_at: v.number(),
  }).index("by_conversation_plan", ["conversation_id", "plan_id"]),
};

export const planTemplateTables = {
  plan_templates: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    description: v.optional(v.string()),
    goal_template: v.optional(v.string()),
    task_templates: v.array(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        task_type: v.optional(v.string()),
        priority: v.optional(v.string()),
        blocked_by_indices: v.optional(v.array(v.number())),
        estimated_minutes: v.optional(v.number()),
      }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"]),
};
