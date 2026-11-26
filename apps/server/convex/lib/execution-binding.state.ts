import { requireNoDeviceMove } from "./edge/device-move.state";
import type { Id } from "../_generated/dataModel";
import {
  fail,
  type TargetInput,
  validateTargetInput,
  strictConversationAgent,
  storedIsolation,
  normalizedCapabilities,
  wireIsolation,
  capabilitiesEqual,
} from "./execution-binding.validators";
import {
  orderedNonterminalMessages,
  isTerminalDeliveryState,
} from "./executionQueue";

export type DbCtx = { db: any };

export async function executionHead(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  mode?: "work",
): Promise<any | null> {
  const rows = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .collect();
  if (rows.length > 1)
    fail(
      "EXECUTION_PROTOCOL_INVARIANT",
      "conversation has multiple execution heads",
    );
  if (mode === "work") requireNoDeviceMove(rows[0] ?? null);
  return rows[0] ?? null;
}

export async function executionBinding(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  epoch: number,
): Promise<any | null> {
  const rows = await ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q: any) =>
      q.eq("conversation_id", conversationId).eq("epoch", epoch),
    )
    .collect();
  if (rows.length > 1) {
    fail(
      "EXECUTION_PROTOCOL_INVARIANT",
      `conversation has multiple bindings for epoch ${epoch}`,
    );
  }
  return rows[0] ?? null;
}

export async function requireOwnedConversation(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<any> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation)
    fail("CONVERSATION_NOT_FOUND", "conversation does not exist");
  if (String(conversation.user_id) !== String(userId)) {
    fail(
      "EXECUTION_NOT_OWNER",
      "only the account that runs the conversation may control execution",
    );
  }
  return conversation;
}

export async function insertRequestedBinding(
  ctx: DbCtx,
  conversation: any,
  epoch: number,
  input: TargetInput,
  now: number,
): Promise<Id<"execution_bindings">> {
  validateTargetInput(input);
  if (
    strictConversationAgent(conversation.agent_type) !== input.requestedAgent
  ) {
    fail(
      "EXECUTION_TARGET_MISMATCH",
      "execution target must match the conversation's authoritative strict agent family",
    );
  }
  const existing = await executionBinding(ctx, conversation._id, epoch);
  if (existing)
    fail("EXECUTION_EPOCH_ALREADY_EXISTS", `epoch ${epoch} already exists`);

  return await ctx.db.insert("execution_bindings", {
    conversation_id: conversation._id,
    epoch,
    owner_user_id: conversation.user_id,
    owner_device_id: input.ownerDeviceId,
    daemon_boot_id: input.daemonBootId,
    requested_agent: input.requestedAgent,
    transport: input.transport,
    project_path: input.projectPath,
    isolation: storedIsolation(input.isolation),
    configuration_revision: input.configurationRevision,
    model: input.model,
    effort: input.effort,
    protocol_version: input.protocolVersion,
    required_capabilities: normalizedCapabilities(input.requiredCapabilities),
    state: "requested" as const,
    created_at: now,
    updated_at: now,
  });
}

export function bindingTargetMatches(
  binding: any,
  input: TargetInput,
): boolean {
  return (
    binding.requested_agent === input.requestedAgent &&
    binding.transport === input.transport &&
    binding.project_path === input.projectPath &&
    JSON.stringify(wireIsolation(binding.isolation) ?? null) ===
      JSON.stringify(input.isolation ?? null) &&
    binding.configuration_revision === input.configurationRevision &&
    binding.model === input.model &&
    binding.effort === input.effort &&
    binding.owner_device_id === input.ownerDeviceId &&
    binding.daemon_boot_id === input.daemonBootId &&
    binding.protocol_version === input.protocolVersion &&
    capabilitiesEqual(
      binding.required_capabilities ?? [],
      input.requiredCapabilities,
    )
  );
}

export async function fencedMessages(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
): Promise<any[]> {
  const messages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .collect();
  return messages.filter(
    (message: any) => message.delivery_protocol_version !== undefined,
  );
}

export async function advanceNonterminalHead(
  ctx: DbCtx,
  head: any,
  now: number,
): Promise<number> {
  const messages = await fencedMessages(ctx, head.conversation_id);
  const first = orderedNonterminalMessages(messages, head)[0];
  const next = first?.conversation_sequence ?? head.next_conversation_sequence;
  await ctx.db.patch(head._id, {
    next_nonterminal_sequence: next,
    updated_at: now,
  });
  return next;
}

export async function clearPendingFlagIfQuiet(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
): Promise<void> {
  const messages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .collect();
  const hasNonterminal = messages.some((message: any) => {
    if (message.delivery_protocol_version !== undefined) {
      return !isTerminalDeliveryState(message.delivery_status);
    }
    return !["delivered", "cancelled"].includes(message.status);
  });
  if (!hasNonterminal) {
    await ctx.db.patch(conversationId, { has_pending_messages: false });
  }
}

export function bindingEvidenceWire(binding: any): any {
  if (
    !binding.operation_id ||
    !binding.actual_agent ||
    !binding.runtime_id ||
    !binding.handle ||
    binding.applied_configuration_revision === undefined ||
    !binding.capabilities
  ) {
    fail(
      "READY_BINDING_INCOMPLETE",
      "ready binding is missing required evidence",
    );
  }
  if (binding.requested_agent !== binding.actual_agent) {
    fail(
      "REQUESTED_ACTUAL_AGENT_MISMATCH",
      "binding evidence changed agent family",
    );
  }
  return {
    conversationId: String(binding.conversation_id),
    epoch: binding.epoch,
    requestedAgent: binding.requested_agent,
    actualAgent: binding.actual_agent,
    transport: binding.transport,
    handle: binding.handle,
    ownerDeviceId: binding.owner_device_id,
    daemonBootId: binding.daemon_boot_id,
    runtimeId: binding.runtime_id,
    operationId: binding.operation_id,
    appliedConfigurationRevision: binding.applied_configuration_revision,
    protocolVersion: binding.protocol_version,
    capabilities: binding.capabilities,
  };
}

export function readyBindingWire(binding: any): any {
  if (binding.state !== "ready") {
    fail("READY_BINDING_INCOMPLETE", "binding is not ready");
  }
  return bindingEvidenceWire(binding);
}

export function executionRequestWire(binding: any): any {
  return {
    target: {
      conversationId: String(binding.conversation_id),
      epoch: binding.epoch,
      requestedAgent: binding.requested_agent,
      transport: binding.transport,
      projectPath: binding.project_path,
      isolation: wireIsolation(binding.isolation),
    },
    configuration: {
      revision: binding.configuration_revision,
      model: binding.model,
      effort: binding.effort,
    },
    ownerDeviceId: binding.owner_device_id,
    daemonBootId: binding.daemon_boot_id,
    requiredCapabilities: binding.required_capabilities,
    protocolVersion: binding.protocol_version,
    trigger: "recovery" as const,
  };
}
