import {
  type DbCtx,
  requireOwnedConversation,
  executionHead,
  executionBinding,
  readyBindingWire,
} from "./execution-binding.state";
import type { Id } from "../_generated/dataModel";
import {
  requireNonEmpty,
  type RuntimeCapability,
  requireSafePositive,
  requireProtocolVersion,
  requireProtocolCapabilities,
  capabilitiesEqual,
  fail,
  type AgentClientId,
  type RuntimeTransport,
  normalizedCapabilities,
} from "./execution-binding.validators";
import {
  requeueDeliveryBeforeEffect,
  blockDeliveryAsAmbiguous,
} from "./delivery-slot.state";
import { clearEventTurn } from "./edge/runEvents";

export async function registeredDaemonBoot(
  ctx: DbCtx,
  userId: Id<"users">,
  ownerDeviceId: string,
): Promise<any | null> {
  return await (ctx.db as any)
    .query("execution_daemon_boots")
    .withIndex("by_user_device", (q: any) =>
      q.eq("user_id", userId).eq("owner_device_id", ownerDeviceId),
    )
    .first();
}

/**
 * Record the device's current fenced-execution daemon boot. The daemon is a
 * per-device singleton, so the registered boot is the only boot allowed to
 * adopt bindings stranded by its predecessors; every other boot id (including
 * a dead boot's late-arriving claim) stays fenced out.
 */
export async function registerExecutionDaemonBootInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: { ownerDeviceId: string; daemonBootId: string; now: number },
): Promise<{ registered: true }> {
  requireNonEmpty(args.ownerDeviceId, "ownerDeviceId");
  requireNonEmpty(args.daemonBootId, "daemonBootId");
  const existing = await registeredDaemonBoot(ctx, userId, args.ownerDeviceId);
  if (existing) {
    if (existing.daemon_boot_id !== args.daemonBootId) {
      await ctx.db.patch(existing._id, {
        daemon_boot_id: args.daemonBootId,
        registered_at: args.now,
      });
    }
    return { registered: true };
  }
  await ctx.db.insert("execution_daemon_boots" as any, {
    user_id: userId,
    owner_device_id: args.ownerDeviceId,
    daemon_boot_id: args.daemonBootId,
    registered_at: args.now,
  });
  return { registered: true };
}

export async function claimExecutionStartInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    ownerDeviceId: string;
    daemonBootId: string;
    configurationRevision: number;
    protocolVersion: number;
    requiredCapabilities: RuntimeCapability[];
    proposedOperationId: string;
    now: number;
  },
): Promise<any> {
  requireSafePositive(args.epoch, "epoch");
  requireSafePositive(args.configurationRevision, "configurationRevision");
  requireProtocolVersion(args.protocolVersion);
  requireProtocolCapabilities(args.requiredCapabilities);
  requireNonEmpty(args.ownerDeviceId, "ownerDeviceId");
  requireNonEmpty(args.daemonBootId, "daemonBootId");
  requireNonEmpty(args.proposedOperationId, "proposedOperationId");
  const conversation = await requireOwnedConversation(
    ctx,
    args.conversationId,
    userId,
  );
  const head = await executionHead(ctx, args.conversationId, "work");
  if (
    !head ||
    head.protocol_state !== "fenced" ||
    conversation.execution_protocol_state !== "fenced"
  ) {
    return {
      state: "rejected" as const,
      failure: {
        code: "EXECUTION_NOT_FENCED",
        message: "conversation is not fenced",
      },
    };
  }
  if (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch) {
    return {
      state: "rejected" as const,
      failure: {
        code: "EXECUTION_EPOCH_FENCE_MISMATCH",
        message: "epoch is neither current nor pending",
      },
    };
  }
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (!binding) {
    return {
      state: "rejected" as const,
      failure: {
        code: "EXECUTION_BINDING_MISSING",
        message: "binding does not exist",
      },
    };
  }
  if (
    conversation.owner_device_id !== args.ownerDeviceId ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.configuration_revision !== args.configurationRevision ||
    binding.protocol_version !== args.protocolVersion ||
    !capabilitiesEqual(
      binding.required_capabilities ?? [],
      args.requiredCapabilities,
    )
  ) {
    return {
      state: "rejected" as const,
      failure: {
        code: "EXECUTION_BINDING_FENCE_MISMATCH",
        message:
          "owner device, configuration, protocol, or capabilities differ",
      },
    };
  }
  // A boot mismatch from the binding's own owner device is a daemon restart,
  // not a foreign claimant: the daemon is a per-device singleton, so the
  // device's REGISTERED current boot presenting a new boot id is durable proof
  // the boot that owned this binding is terminated. Transferring the binding
  // to that boot (never skipping it) is what lets the coordinator's
  // journal-driven inspect/adopt/quarantine recovery run; without it every
  // daemon restart permanently orphaned its fenced conversations. Only the
  // registered boot may transfer — a dead boot's late-arriving claim, or a
  // boot that never registered, stays fenced out.
  const previousDaemonBootId = binding.daemon_boot_id;
  const bootTransfer = previousDaemonBootId !== args.daemonBootId;
  const activeAttemptId =
    binding.state === "ready" &&
    head.current_epoch === args.epoch &&
    (bootTransfer ||
      head.active_delivery_state === "delivery-started" ||
      head.active_delivery_state === "ambiguous")
      ? head.active_delivery_attempt_id
      : undefined;
  const activeAttempt = activeAttemptId && (await ctx.db.get(activeAttemptId));
  const repairDelivery =
    activeAttempt && activeAttempt.daemon_boot_id !== args.daemonBootId;
  if (bootTransfer || repairDelivery) {
    const registration = await registeredDaemonBoot(
      ctx,
      userId,
      args.ownerDeviceId,
    );
    if (registration?.daemon_boot_id !== args.daemonBootId) {
      return {
        state: "rejected" as const,
        failure: {
          code: "EXECUTION_BINDING_FENCE_MISMATCH",
          message:
            "daemon boot differs and is not the device's registered current boot",
        },
      };
    }
  }
  const recovery = bootTransfer
    ? {
        state: "recovering" as const,
        previousDaemonBootId,
        previousBootTerminated: true as const,
      }
    : { state: "fresh" as const };
  if (binding.state === "ready") {
    if (activeAttemptId && (bootTransfer || repairDelivery)) {
      const attempt = activeAttempt;
      const message = attempt && (await ctx.db.get(attempt.message_id));
      if (
        !attempt ||
        !message ||
        attempt.conversation_id !== args.conversationId ||
        attempt.owner_user_id !== userId ||
        attempt.owner_device_id !== binding.owner_device_id ||
        attempt.execution_epoch !== binding.epoch ||
        attempt.configuration_revision !== binding.configuration_revision ||
        attempt.runtime_id !== binding.runtime_id ||
        attempt.conversation_sequence !== head.next_nonterminal_sequence ||
        attempt.state !== head.active_delivery_state ||
        message.active_delivery_attempt_id !== attempt._id ||
        message.conversation_id !== attempt.conversation_id ||
        message.delivery_id !== attempt.delivery_id ||
        message.client_id !== attempt.delivery_id ||
        message.conversation_sequence !== attempt.conversation_sequence ||
        message.execution_epoch !== attempt.execution_epoch ||
        message.delivery_status !== attempt.state
      ) {
        fail(
          "DELIVERY_SLOT_INVARIANT",
          "active permit does not match the ready binding and queue head",
        );
      }
      if (attempt.state === "claimed") {
        await requeueDeliveryBeforeEffect(ctx, head._id, message, attempt._id, {
          failure_code: "CLAIM_RELEASED_BEFORE_EFFECT",
          failure_message: "daemon boot changed before delivery started",
          completed_at: args.now,
        });
      } else if (attempt.state === "delivery-started") {
        await blockDeliveryAsAmbiguous(
          ctx,
          head._id,
          message._id,
          attempt._id,
          args.now,
          {
            daemon_boot_id: args.daemonBootId,
            failure_code: "DELIVERY_BOOT_CHANGED",
            failure_message: "daemon boot changed after delivery started",
          },
        );
      } else {
        await ctx.db.patch(attempt._id, {
          daemon_boot_id: args.daemonBootId,
        });
      }
    }
    if (bootTransfer) {
      await clearEventTurn(ctx, binding, args.now, true);
      await ctx.db.patch(binding._id, {
        daemon_boot_id: args.daemonBootId,
        updated_at: args.now,
      });
      return {
        state: "ready" as const,
        binding: readyBindingWire({
          ...binding,
          daemon_boot_id: args.daemonBootId,
        }),
      };
    }
    return { state: "ready" as const, binding: readyBindingWire(binding) };
  }
  if (binding.state === "starting") {
    if (binding.operation_id === args.proposedOperationId) {
      if (bootTransfer) {
        // The durable operation continues under the new boot. Requiring the
        // exact operation id means the caller holds the prior boot's journal —
        // the evidence its recovery path needs to inspect, adopt, or
        // quarantine whatever the interrupted start left behind.
        await ctx.db.patch(binding._id, {
          daemon_boot_id: args.daemonBootId,
          updated_at: args.now,
        });
      }
      return {
        state: "claimed" as const,
        operationId: binding.operation_id,
        recovery,
      };
    }
    return {
      state: "busy" as const,
      operationId: binding.operation_id,
      failure: {
        code: "START_ALREADY_CLAIMED",
        message: "another start operation owns this epoch",
      },
    };
  }
  const retryingBeforeEffect =
    binding.state === "start-failed-before-effect" &&
    binding.failure_retryable === true;
  if (binding.state !== "requested" && !retryingBeforeEffect) {
    return {
      state: "busy" as const,
      operationId: binding.operation_id,
      failure: {
        code:
          binding.state === "start-ambiguous"
            ? "START_AMBIGUOUS"
            : "START_NOT_RETRYABLE",
        message: `binding state ${binding.state} does not authorize startup`,
      },
    };
  }
  if (
    retryingBeforeEffect &&
    binding.operation_id !== args.proposedOperationId
  ) {
    return {
      state: "rejected" as const,
      failure: {
        code: "START_RETRY_OPERATION_MISMATCH",
        message:
          "a proven pre-effect retry must reuse the exact durable operation id",
      },
    };
  }

  await ctx.db.patch(binding._id, {
    state: "starting" as const,
    operation_id: args.proposedOperationId,
    daemon_boot_id: args.daemonBootId,
    failure_code: undefined,
    failure_message: undefined,
    failure_retryable: undefined,
    suspected_runtime_id: undefined,
    updated_at: args.now,
  });
  return {
    state: "claimed" as const,
    operationId: args.proposedOperationId,
    recovery,
  };
}

export async function publishReadyBindingInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    requestedAgent: AgentClientId;
    actualAgent: AgentClientId;
    transport: RuntimeTransport;
    handle: string;
    ownerDeviceId: string;
    daemonBootId: string;
    runtimeId: string;
    operationId: string;
    appliedConfigurationRevision: number;
    protocolVersion: number;
    capabilities: RuntimeCapability[];
    now: number;
  },
): Promise<{ accepted: boolean; binding?: any; reason?: string }> {
  await requireOwnedConversation(ctx, args.conversationId, userId);
  requireSafePositive(args.epoch, "epoch");
  requireSafePositive(
    args.appliedConfigurationRevision,
    "appliedConfigurationRevision",
  );
  requireProtocolVersion(args.protocolVersion);
  requireProtocolCapabilities(args.capabilities);
  for (const [field, value] of [
    ["handle", args.handle],
    ["ownerDeviceId", args.ownerDeviceId],
    ["daemonBootId", args.daemonBootId],
    ["runtimeId", args.runtimeId],
    ["operationId", args.operationId],
  ] as const)
    requireNonEmpty(value, field);
  if (args.requestedAgent !== args.actualAgent) {
    fail(
      "REQUESTED_ACTUAL_AGENT_MISMATCH",
      "actual agent must equal requested agent exactly",
    );
  }
  const head = await executionHead(ctx, args.conversationId, "work");
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (
    !head ||
    !binding ||
    (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)
  ) {
    return { accepted: false, reason: "stale-epoch" };
  }
  if (binding.state === "ready") {
    const exact =
      binding.requested_agent === args.requestedAgent &&
      binding.actual_agent === args.actualAgent &&
      binding.transport === args.transport &&
      binding.handle === args.handle &&
      binding.owner_device_id === args.ownerDeviceId &&
      binding.daemon_boot_id === args.daemonBootId &&
      binding.runtime_id === args.runtimeId &&
      binding.operation_id === args.operationId &&
      binding.applied_configuration_revision ===
        args.appliedConfigurationRevision &&
      binding.protocol_version === args.protocolVersion &&
      capabilitiesEqual(binding.capabilities ?? [], args.capabilities);
    return exact
      ? { accepted: true, binding: readyBindingWire(binding) }
      : { accepted: false, reason: "ready-binding-conflict" };
  }
  if (binding.state !== "starting")
    return { accepted: false, reason: `state-${binding.state}` };
  if (
    binding.requested_agent !== args.requestedAgent ||
    binding.transport !== args.transport ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId ||
    binding.operation_id !== args.operationId ||
    binding.configuration_revision !== args.appliedConfigurationRevision ||
    binding.protocol_version !== args.protocolVersion ||
    !capabilitiesEqual(binding.required_capabilities ?? [], args.capabilities)
  ) {
    return { accepted: false, reason: "compare-and-set-lost" };
  }

  await ctx.db.patch(binding._id, {
    state: "ready" as const,
    actual_agent: args.actualAgent,
    runtime_id: args.runtimeId,
    handle: args.handle,
    applied_configuration_revision: args.appliedConfigurationRevision,
    capabilities: normalizedCapabilities(args.capabilities),
    updated_at: args.now,
  });
  return {
    accepted: true,
    binding: readyBindingWire({
      ...binding,
      state: "ready",
      actual_agent: args.actualAgent,
      runtime_id: args.runtimeId,
      handle: args.handle,
      applied_configuration_revision: args.appliedConfigurationRevision,
      capabilities: normalizedCapabilities(args.capabilities),
    }),
  };
}

export async function publishStartOutcomeInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    ownerDeviceId: string;
    daemonBootId: string;
    configurationRevision: number;
    operationId: string;
    failureCode: string;
    failureMessage: string;
    failureRetryable?: boolean;
    suspectedRuntimeId?: string;
    outcome: "start-failed-before-effect" | "start-ambiguous";
    now: number;
  },
): Promise<{ accepted: boolean }> {
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId, "work");
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (
    !head ||
    !binding ||
    (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)
  ) {
    return { accepted: false };
  }
  if (
    binding.state === args.outcome &&
    binding.owner_device_id === args.ownerDeviceId &&
    binding.daemon_boot_id === args.daemonBootId &&
    binding.configuration_revision === args.configurationRevision &&
    binding.operation_id === args.operationId &&
    binding.failure_code === args.failureCode &&
    binding.failure_message === args.failureMessage &&
    binding.failure_retryable === args.failureRetryable &&
    binding.suspected_runtime_id === args.suspectedRuntimeId
  ) {
    return { accepted: true };
  }
  if (
    binding.state !== "starting" ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId ||
    binding.configuration_revision !== args.configurationRevision ||
    binding.operation_id !== args.operationId
  ) {
    return { accepted: false };
  }
  await ctx.db.patch(binding._id, {
    state: args.outcome,
    failure_code: args.failureCode,
    failure_message: args.failureMessage,
    failure_retryable: args.failureRetryable,
    suspected_runtime_id: args.suspectedRuntimeId,
    updated_at: args.now,
  });
  return { accepted: true };
}

export async function disposePreReadyBindingInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    expectedState:
      | "requested"
      | "starting"
      | "start-failed-before-effect"
      | "start-ambiguous";
    configurationRevision: number;
    ownerDeviceId: string;
    daemonBootId: string;
    operationId?: string;
    inspection: "proven-no-effect" | "runtime-quarantined" | "unknown";
    suspectedRuntimeId?: string;
    evidence: string;
    now: number;
  },
): Promise<{ state: "stopped" | "quarantined" | "start-ambiguous" }> {
  requireNonEmpty(args.evidence, "evidence");
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId, "work");
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (
    !head ||
    !binding ||
    (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)
  ) {
    fail(
      "EXECUTION_EPOCH_FENCE_MISMATCH",
      "epoch is no longer current or pending",
    );
  }
  if (
    binding.configuration_revision !== args.configurationRevision ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId
  ) {
    fail("EXECUTION_BINDING_FENCE_MISMATCH", "pre-ready binding fence changed");
  }
  const operationMatches =
    (binding.operation_id ?? undefined) === args.operationId;
  if (
    operationMatches &&
    binding.disposition_evidence === args.evidence &&
    args.inspection === "proven-no-effect" &&
    binding.state === "stopped" &&
    binding.pre_ready_disposition === "no-runtime-proven"
  ) {
    return { state: "stopped" };
  }
  if (
    operationMatches &&
    binding.disposition_evidence === args.evidence &&
    args.inspection === "runtime-quarantined" &&
    binding.state === "quarantined" &&
    binding.pre_ready_disposition === "runtime-quarantined" &&
    binding.suspected_runtime_id === args.suspectedRuntimeId
  ) {
    return { state: "quarantined" };
  }
  if (
    operationMatches &&
    binding.disposition_evidence === args.evidence &&
    args.inspection === "unknown" &&
    binding.state === "start-ambiguous" &&
    binding.suspected_runtime_id === args.suspectedRuntimeId
  ) {
    return { state: "start-ambiguous" };
  }
  if (binding.state !== args.expectedState) {
    fail("EXECUTION_BINDING_FENCE_MISMATCH", "pre-ready binding state changed");
  }
  if (binding.state === "requested") {
    if (args.operationId !== undefined || binding.operation_id !== undefined) {
      fail(
        "EXECUTION_OPERATION_FENCE_MISMATCH",
        "requested binding must not have a start operation",
      );
    }
    if (args.inspection !== "proven-no-effect") {
      fail(
        "PRE_READY_INSPECTION_REQUIRED",
        "an unclaimed request has no runtime to quarantine",
      );
    }
  } else {
    requireNonEmpty(args.operationId ?? "", "operationId");
    if (binding.operation_id !== args.operationId) {
      fail("EXECUTION_OPERATION_FENCE_MISMATCH", "startup operation changed");
    }
  }

  if (args.inspection === "unknown") {
    // A claimed startup can cross the external-create boundary. Uncertainty is
    // durable ambiguity, never a synonym for missing/no-effect.
    if (binding.state === "requested") {
      fail(
        "PRE_READY_INSPECTION_REQUIRED",
        "requested state is already proof no start was claimed",
      );
    }
    await ctx.db.patch(binding._id, {
      state: "start-ambiguous" as const,
      failure_code: "START_INSPECTION_UNKNOWN",
      failure_message:
        "runtime inspection could not prove absence or quarantine",
      suspected_runtime_id: args.suspectedRuntimeId,
      disposition_evidence: args.evidence,
      updated_at: args.now,
    });
    return { state: "start-ambiguous" };
  }

  if (args.inspection === "runtime-quarantined") {
    requireNonEmpty(args.suspectedRuntimeId ?? "", "suspectedRuntimeId");
    await ctx.db.patch(binding._id, {
      state: "quarantined" as const,
      pre_ready_disposition: "runtime-quarantined" as const,
      suspected_runtime_id: args.suspectedRuntimeId,
      disposition_evidence: args.evidence,
      stopped_reason: "pre-ready runtime quarantined",
      updated_at: args.now,
    });
    return { state: "quarantined" };
  }

  await ctx.db.patch(binding._id, {
    state: "stopped" as const,
    pre_ready_disposition: "no-runtime-proven" as const,
    disposition_evidence: args.evidence,
    stopped_reason: "inspection proved startup had no external effect",
    updated_at: args.now,
  });
  return { state: "stopped" };
}
