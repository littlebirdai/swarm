import { agentSupportsExecutionTransport } from "@codecast/agent-clients/agentClients";
import { v } from "convex/values";
import { capabilityValidator } from "./edge/execution.validators";
import type { PermitFence } from "./delivery-slot.state";

export const EXECUTION_PROTOCOL_VERSION = 1 as const;

export const EXECUTION_PROTOCOL_CAPABILITIES = [
  "single-flight-binding",
  "delivery-permit-v1",
  "strict-agent-routing",
  "runtime-inspection-v1",
] as const;

export type AgentClientId =
  | "claude"
  | "codex"
  | "cursor"
  | "gemini"
  | "opencode"
  | "pi"
  | "grok"
  | "muse"
  | "antigravity";

export type RuntimeTransport = "tmux" | "app-server" | "external";

export type RuntimeCapability =
  (typeof EXECUTION_PROTOCOL_CAPABILITIES)[number];

export type SuccessorPolicy = "drain-current" | "cancel-unstarted";

type SuccessorIntentKind = "restart" | "reconfigure";

export type TargetInput = {
  requestedAgent: AgentClientId;
  transport: RuntimeTransport;
  projectPath: string;
  isolation?: {
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    isolated?: boolean;
    worktreeName?: string;
  };
  configurationRevision: number;
  model?: string;
  effort?: string;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: RuntimeCapability[];
  protocolVersion: number;
};

export type SuccessorIntentRequest = {
  intentId: string;
  expectedCurrentEpoch: number;
  kind: SuccessorIntentKind;
  policy: SuccessorPolicy;
  /** Stable product option keys. `default` means clear the launch override. */
  model?: string;
  effort?: string;
};

export class ExecutionAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ExecutionAuthorityError";
  }
}

export function fail(code: string, message: string): never {
  throw new ExecutionAuthorityError(code, message);
}

export function requireNonEmpty(value: string, field: string): void {
  if (!value.trim())
    fail("INVALID_EXECUTION_ARGUMENT", `${field} must be non-empty`);
}

export function requireSafePositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      "INVALID_EXECUTION_ARGUMENT",
      `${field} must be a positive safe integer`,
    );
  }
}

export function requireProtocolVersion(version: number): void {
  if (version !== EXECUTION_PROTOCOL_VERSION) {
    fail(
      "EXECUTION_PROTOCOL_VERSION_MISMATCH",
      `expected protocol ${EXECUTION_PROTOCOL_VERSION}, received ${version}`,
    );
  }
}

export function normalizedCapabilities(
  capabilities: readonly string[],
): string[] {
  return [...new Set(capabilities)].sort();
}

export function capabilitiesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = normalizedCapabilities(left);
  const b = normalizedCapabilities(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function requireProtocolCapabilities(
  capabilities: readonly string[],
): void {
  const normalized = normalizedCapabilities(capabilities);
  if (
    normalized.length !== EXECUTION_PROTOCOL_CAPABILITIES.length ||
    !EXECUTION_PROTOCOL_CAPABILITIES.every((capability) =>
      normalized.includes(capability),
    )
  ) {
    fail(
      "EXECUTION_CAPABILITY_MISMATCH",
      `protocol v1 requires exactly ${EXECUTION_PROTOCOL_CAPABILITIES.join(", ")}`,
    );
  }
}

export function strictConversationAgent(agentType: unknown): AgentClientId {
  switch (agentType) {
    case "claude":
    case "claude_code":
    case "cowork":
      return "claude";
    case "codex":
    case "cursor":
    case "gemini":
    case "opencode":
    case "pi":
    case "grok":
    case "muse":
    case "antigravity":
      return agentType;
    default:
      return fail(
        "INVALID_EXECUTION_AGENT",
        `unsupported conversation agent ${String(agentType)}`,
      );
  }
}

export function validateTargetInput(input: TargetInput): void {
  requireProtocolVersion(input.protocolVersion);
  requireSafePositive(input.configurationRevision, "configurationRevision");
  requireNonEmpty(input.projectPath, "projectPath");
  requireNonEmpty(input.ownerDeviceId, "ownerDeviceId");
  requireNonEmpty(input.daemonBootId, "daemonBootId");
  requireProtocolCapabilities(input.requiredCapabilities);
  if (!agentSupportsExecutionTransport(input.requestedAgent, input.transport)) {
    fail(
      "EXECUTION_TRANSPORT_UNSUPPORTED",
      `${input.requestedAgent} does not support fenced ${input.transport} execution`,
    );
  }
}

export function storedIsolation(input: TargetInput["isolation"]): any {
  if (!input) return undefined;
  return {
    sandbox: input.sandbox,
    approval_policy: input.approvalPolicy,
    isolated: input.isolated,
    worktree_name: input.worktreeName,
  };
}

export function wireIsolation(
  input: any,
): TargetInput["isolation"] | undefined {
  if (!input) return undefined;
  return {
    sandbox: input.sandbox,
    approvalPolicy: input.approval_policy,
    isolated: input.isolated,
    worktreeName: input.worktree_name,
  };
}

// Validators are intentionally declared in this module rather than imported
// from CLI/shared code. Convex analyzes function validators at bundle time; a
// self-contained wire contract prevents runtime/toolchain imports from silently
// widening the authority boundary.
export const agentClientValidator = v.union(
  v.literal("claude"),
  v.literal("codex"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("opencode"),
  v.literal("pi"),
  v.literal("grok"),
  v.literal("muse"),
  v.literal("antigravity"),
);

export const transportValidator = v.union(
  v.literal("tmux"),
  v.literal("app-server"),
  v.literal("external"),
);

const isolationValidator = v.object({
  sandbox: v.optional(
    v.union(
      v.literal("read-only"),
      v.literal("workspace-write"),
      v.literal("danger-full-access"),
    ),
  ),
  approval_policy: v.optional(
    v.union(
      v.literal("untrusted"),
      v.literal("on-failure"),
      v.literal("on-request"),
      v.literal("never"),
    ),
  ),
  isolated: v.optional(v.boolean()),
  worktree_name: v.optional(v.string()),
});

export const targetValidator = v.object({
  requested_agent: agentClientValidator,
  transport: transportValidator,
  project_path: v.string(),
  isolation: v.optional(isolationValidator),
  configuration_revision: v.number(),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  owner_device_id: v.string(),
  daemon_boot_id: v.string(),
  required_capabilities: v.array(capabilityValidator),
  protocol_version: v.number(),
});

export function targetFromWire(target: any): TargetInput {
  return {
    requestedAgent: target.requested_agent,
    transport: target.transport,
    projectPath: target.project_path,
    isolation: target.isolation
      ? {
          sandbox: target.isolation.sandbox,
          approvalPolicy: target.isolation.approval_policy,
          isolated: target.isolation.isolated,
          worktreeName: target.isolation.worktree_name,
        }
      : undefined,
    configurationRevision: target.configuration_revision,
    model: target.model,
    effort: target.effort,
    ownerDeviceId: target.owner_device_id,
    daemonBootId: target.daemon_boot_id,
    requiredCapabilities: target.required_capabilities,
    protocolVersion: target.protocol_version,
  };
}

export function sequenceFromWire(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    fail(
      "INVALID_CONVERSATION_SEQUENCE",
      "conversation_sequence must be a canonical positive integer string",
    );
  }
  return parsed;
}

export function permitFromWire(permit: any): PermitFence {
  return {
    messageId: permit.message_id,
    deliveryId: permit.delivery_id,
    conversationSequence: sequenceFromWire(permit.conversation_sequence),
    attemptId: permit.attempt_id,
    conversationId: permit.conversation_id,
    executionEpoch: permit.execution_epoch,
    configurationRevision: permit.configuration_revision,
    ownerDeviceId: permit.owner_device_id,
    daemonBootId: permit.daemon_boot_id,
    runtimeId: permit.runtime_id,
  };
}

export const startOutcomeArgs = {
  conversation_id: v.id("conversations"),
  epoch: v.number(),
  owner_device_id: v.string(),
  daemon_boot_id: v.string(),
  configuration_revision: v.number(),
  operation_id: v.string(),
  failure_code: v.string(),
  failure_message: v.string(),
  failure_retryable: v.optional(v.boolean()),
  api_token: v.string(),
};
