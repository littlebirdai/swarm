import { defineTable } from "convex/server";
import { v } from "convex/values";
import { AGENT_STATUSES } from "@codecast/sessions/agentStatus";
import { openTaskValidator } from "../lib/openTasksValidator";
import { roleIconValidator } from "../lib/roleIconValidator";

// Derived from the single source of truth in the workspace libraries so the
// schema, validators, the CLI daemon, and the browser store can never drift.
// Each accepts exactly the same set as the old hand-written unions.
const agentStatusFieldValidator = v.union(
  ...AGENT_STATUSES.map((s) => v.literal(s)),
);

export const managedSessionTables = {
  managed_sessions: defineTable({
    session_id: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    user_id: v.id("users"),
    pid: v.number(),
    tmux_session: v.optional(v.string()),
    // "sdk" while the session runs in an Agent SDK host (no pane); absent on
    // the tmux path. Written by the daemon's registration, cleared by a
    // registration that names a pane.
    backend: v.optional(v.literal("sdk")),
    started_at: v.number(),
    last_heartbeat: v.number(),
    agent_status: v.optional(agentStatusFieldValidator),
    agent_status_updated_at: v.optional(v.number()),
    agent_status_write_at: v.optional(v.number()),
    // The current agent_status settled the row on a SESSION BOUNDARY — a
    // resume, a clear, or a manual /compact landing the pane at an idle prompt
    // — rather than on a turn ending. Written by the hook path only, and
    // cleared by every status write that does not carry it, so it never
    // outlives the settle it describes. Every completion-reactive consumer
    // (the needs-input push, the settle classifier, unread) ignores such a
    // settle.
    agent_status_boundary: v.optional(v.boolean()),
    // When the lead turn behind the current status ended. A session the
    // harness keeps alive for background work settles as "waiting" and its
    // status then stops moving, so this stamp — not the status — is the
    // per-turn identity a completion consumer dedupes on.
    turn_completed_at: v.optional(v.number()),
    // When the daemon parked this session's pane to stay under the fleet cap.
    // Cleared when the session resumes. Separate from agent_status_updated_at
    // so a later status write does not lose when the park started.
    hibernated_at: v.optional(v.number()),
    // The row carries a hosted assistant conversation's status (plan pl-840):
    // no process or daemon stands behind it. Its heartbeat proves a running
    // turn, never a live daemon, so the user-wide daemon liveness skips it, and
    // the stale-row reaper leaves it alone (a status parked on an approval
    // writes no heartbeat while it waits).
    hosted: v.optional(v.boolean()),
    permission_mode: v.optional(
      v.union(
        v.literal("default"),
        v.literal("plan"),
        v.literal("acceptEdits"),
        v.literal("bypassPermissions"),
        v.literal("dontAsk"),
        v.literal("auto"),
      ),
    ),
    current_cpu: v.optional(v.number()),
    current_memory: v.optional(v.number()),
    current_pid_count: v.optional(v.number()),
    // Real PID of the agent's process tree root (distinct from the daemon's PID
    // historically stored in `pid`). Set by the resource collector.
    agent_pid: v.optional(v.number()),
    // When that agent process started (ps etime, resolved to wall clock by the
    // resource collector). The session id survives a restart but this does not,
    // so it names the process GENERATION: the web fences background watches
    // armed by an earlier one, which died with it and are never notified.
    agent_started_at: v.optional(v.number()),
    // The background work the harness still holds for this session, as the
    // daemon last verified it (packages/sessions/src/openTasks). Reported with every
    // settle verdict and refreshed by the heartbeat reconcile while the session
    // is parked; `open_tasks_at` is when. Drives the inbox's "↳ Background …"
    // row without the conversation's messages, and vouches for a "waiting"
    // status past the quiet-time decay.
    open_tasks: v.optional(v.array(openTaskValidator)),
    open_tasks_at: v.optional(v.number()),
    // Accumulated time the session has been idle while the machine was AWAKE
    // (sleep gaps excluded). Reset to 0 whenever the session shows activity.
    awake_idle_ms: v.optional(v.number()),
    // When the daemon last reported live metrics for this session. Freshness
    // here is the liveness signal: a live process tree is what produces a report.
    last_metrics_at: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"])
    .index("by_user_heartbeat", ["user_id", "last_heartbeat"])
    .index("by_user_status", ["user_id", "agent_status"])
    // addMessages asks whether its session is idle or blocked here: while the
    // session works the range is empty, so heartbeats never conflict with it.
    .index("by_conversation_status", ["conversation_id", "agent_status"])
    .index("by_conversation_heartbeat", ["conversation_id", "last_heartbeat"])
    .index("by_heartbeat", ["last_heartbeat"]),

  // Use the managed document id because the daemon can rename or reuse its session id.
  session_heartbeats: defineTable({
    managed_session_id: v.id("managed_sessions"),
    user_id: v.id("users"),
    heartbeat_at: v.number(),
  })
    .index("by_managed_session", ["managed_session_id"])
    .index("by_user_heartbeat", ["user_id", "heartbeat_at"])
    .index("by_heartbeat", ["heartbeat_at"]),

  session_metrics: defineTable({
    session_id: v.string(),
    user_id: v.id("users"),
    cpu: v.number(),
    memory: v.number(),
    pid_count: v.number(),
    collected_at: v.number(),
  })
    .index("by_session_collected", ["session_id", "collected_at"])
    .index("by_user_collected", ["user_id", "collected_at"]),
};

export const sessionStartTables = {
  // One small row per conversation for counting sessions over a window
  // (lib/sessionStarts.ts keeps it in step with every conversation write).
  // visible_team_id is the team that can see the session under the
  // visibility rule, absent when only its owner can: access, never routing.
  session_starts: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    visible_team_id: v.optional(v.id("teams")),
    agent_type: v.string(),
    started_at: v.number(),
    subagent: v.boolean(),
    // What a list naming the session shows of it (notifications.list): fields
    // that change at a person's pace, so a reader of this row is not re-run by
    // every streamed message the way a reader of the conversation is (ct-92571).
    card: v.optional(
      v.object({
        title: v.optional(v.string()),
        project_path: v.optional(v.string()),
        character_avatar: v.optional(v.string()),
        character_name: v.optional(v.string()),
        drawn_icon: v.optional(roleIconValidator),
        org_role_id: v.optional(v.id("org_roles")),
        standing_role_id: v.optional(v.id("org_roles")),
      }),
    ),
    // What the daemon's pending-message query needs to decide delivery (the
    // owning device and whether delivery is blocked), so that subscription
    // reads this row and not the conversation. Absent until
    // pageData.backfillSessionStarts refreshes pre-existing rows.
    daemon_delivery: v.optional(
      v.object({
        owner_device_id: v.optional(v.string()),
        blocked: v.boolean(),
      }),
    ),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_visible_team_started", ["visible_team_id", "started_at"])
    .index("by_user_started", ["user_id", "started_at"]),
};
