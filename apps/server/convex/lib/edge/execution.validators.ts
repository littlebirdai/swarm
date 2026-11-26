import { v } from "convex/values";

export const capabilityValidator = v.union(
  v.literal("single-flight-binding"),
  v.literal("delivery-permit-v1"),
  v.literal("strict-agent-routing"),
  v.literal("runtime-inspection-v1"),
);

export const permitValidator = v.object({
  message_id: v.id("pending_messages"),
  delivery_id: v.string(),
  conversation_sequence: v.string(),
  attempt_id: v.id("delivery_attempts"),
  conversation_id: v.id("conversations"),
  execution_epoch: v.number(),
  configuration_revision: v.number(),
  owner_device_id: v.string(),
  daemon_boot_id: v.string(),
  runtime_id: v.string(),
});
