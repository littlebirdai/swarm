import { defineTable } from "convex/server";
import { v } from "convex/values";

export const edgePromptAnswer = v.union(
  v.null(),
  v.string(),
  v.object({ behavior: v.union(v.literal("allow"), v.literal("deny")) }),
  v.object({ option_id: v.string() }),
  v.object({
    answers: v.record(v.string(), v.object({ answers: v.array(v.string()) })),
  }),
);

export const edgePromptAnswerTables = {
  edge_prompt_answers: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    actor_user_id: v.string(),
    device_id: v.string(),
    boot: v.string(),
    run: v.number(),
    lease_id: v.id("run_leases"),
    turn_id: v.string(),
    prompt_id: v.string(),
    answer: edgePromptAnswer,
    finished_at: v.optional(v.number()),
  })
    .index("by_conversation_prompt", [
      "conversation_id",
      "run",
      "lease_id",
      "turn_id",
      "prompt_id",
      "actor_user_id",
    ])
    .index("by_device_boot_pending", [
      "owner_user_id",
      "device_id",
      "boot",
      "finished_at",
    ])
    .index("by_owner", ["owner_user_id"]),
};
