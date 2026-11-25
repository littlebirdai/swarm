import { v } from "convex/values";
import { eventFilterValidator } from "./eventFilterValidator";

export const agentTaskRevisionValidator = v.object({
  title: v.string(),
  prompt: v.string(),
  status: v.optional(v.string()),
  schedule_type: v.union(
    v.literal("once"),
    v.literal("recurring"),
    v.literal("event"),
  ),
  run_at: v.optional(v.number()),
  interval_ms: v.optional(v.number()),
  event_filter: v.optional(eventFilterValidator),
  mode: v.union(v.literal("propose"), v.literal("apply")),
  agent_type: v.optional(v.string()),
  model: v.optional(v.string()),
  agent_definition: v.optional(v.string()),
  project_path: v.optional(v.string()),
  max_runtime_ms: v.optional(v.number()),
  precheck: v.optional(v.string()),
  precheck_mode: v.optional(v.union(v.literal("changes"), v.literal("state"))),
  role_focus: v.optional(v.string()),
  tune_why: v.optional(v.string()),
  originating_conversation_id: v.optional(v.id("conversations")),
  target_conversation_id: v.optional(v.id("conversations")),
  created_by_conversation_id: v.optional(v.id("conversations")),
  wake_creator: v.optional(v.boolean()),
});
