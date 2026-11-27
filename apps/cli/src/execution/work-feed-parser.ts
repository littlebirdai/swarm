import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import {
  FENCED_EXECUTION_PROTOCOL_VERSION,
  FENCED_RUNTIME_CAPABILITIES,
  parseReadyBinding,
  type ReadyBinding,
  type RuntimeCapability,
} from "@codecast/agent-clients/executionBinding";
import {
  agentSupportsExecutionTransport,
  parseExecutionAgentClientId,
} from "@codecast/agent-clients/agentClients";
import type { EnsureBindingRequest } from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid ${label}: expected non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Invalid ${label}: expected positive safe integer`);
  }
  return value as number;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalEnum<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`Invalid ${label}: unsupported value`);
  }
  return value as T;
}

function parseCapabilities(value: unknown): RuntimeCapability[] {
  if (
    !Array.isArray(value) ||
    value.some((candidate) => typeof candidate !== "string")
  ) {
    throw new TypeError(
      "Invalid execution work: capabilities must be an array",
    );
  }
  const actual = [...new Set(value)].sort();
  const base = actual.filter(
    (capability) => capability !== STEER_BATON_CAPABILITY,
  );
  const expected = [...FENCED_RUNTIME_CAPABILITIES].sort();
  if (
    base.length !== expected.length ||
    base.some((capability, index) => capability !== expected[index])
  ) {
    throw new TypeError(
      "Invalid execution work: capability handshake mismatch",
    );
  }
  return actual as RuntimeCapability[];
}

function parseEnsureRequest(value: unknown): EnsureBindingRequest {
  const request = object(value, "execution request");
  const target = object(request.target, "execution target");
  const configuration = object(request.configuration, "runtime configuration");
  const requestedAgent = parseExecutionAgentClientId(target.requestedAgent);
  if (requestedAgent !== target.requestedAgent) {
    throw new TypeError("Invalid execution work: agent id is not canonical");
  }
  const transport = string(target.transport, "runtime transport");
  if (
    transport !== "tmux" &&
    transport !== "app-server" &&
    transport !== "external"
  ) {
    throw new TypeError(
      "Invalid execution work: unsupported transport spelling",
    );
  }
  if (!agentSupportsExecutionTransport(requestedAgent, transport)) {
    throw new TypeError("Invalid execution work: agent/transport mismatch");
  }
  let isolation: EnsureBindingRequest["target"]["isolation"];
  if (target.isolation !== undefined) {
    const raw = object(target.isolation, "isolation spec");
    const sandbox = optionalEnum(raw.sandbox, "isolation sandbox", [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ] as const);
    const approvalPolicy = optionalEnum(
      raw.approvalPolicy,
      "isolation approval policy",
      ["untrusted", "on-failure", "on-request", "never"] as const,
    );
    if (raw.isolated !== undefined && typeof raw.isolated !== "boolean") {
      throw new TypeError("Invalid isolation flag: expected boolean");
    }
    isolation = {
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(raw.isolated === undefined ? {} : { isolated: raw.isolated }),
      ...(raw.worktreeName === undefined
        ? {}
        : { worktreeName: string(raw.worktreeName, "worktree name") }),
    };
  }
  const protocolVersion = integer(request.protocolVersion, "protocol version");
  if (protocolVersion !== FENCED_EXECUTION_PROTOCOL_VERSION) {
    throw new TypeError(
      `Invalid execution work: unsupported protocol ${protocolVersion}`,
    );
  }
  return {
    target: {
      conversationId: string(target.conversationId, "conversation id"),
      epoch: integer(target.epoch, "execution epoch"),
      requestedAgent,
      transport,
      projectPath: string(target.projectPath, "project path"),
      ...(isolation ? { isolation } : {}),
    },
    configuration: {
      revision: integer(configuration.revision, "configuration revision"),
      model: optionalString(configuration.model, "model"),
      effort: optionalString(configuration.effort, "effort"),
    },
    ownerDeviceId: string(request.ownerDeviceId, "owner device id"),
    daemonBootId: string(request.daemonBootId, "daemon boot id"),
    requiredCapabilities: parseCapabilities(request.requiredCapabilities),
    protocolVersion,
    trigger: "recovery",
  };
}

export interface BindingWork {
  state: string;
  daemonBootMatch: boolean;
  request: EnsureBindingRequest;
  binding?: ReadyBinding;
}

export interface ExecutionWorkItem {
  conversationId: string;
  currentEpoch: number;
  resumeGeneration?: number;
  nextDeliverySequence?: number;
  pendingEpoch?: number;
  pendingPolicy?: "drain-current" | "cancel-unstarted";
  bindings: BindingWork[];
  pendingIntent?: {
    intentId: string;
    expectedCurrentEpoch: number;
    policy: "drain-current" | "cancel-unstarted";
    request: EnsureBindingRequest;
  };
}

export function parseWork(value: unknown): ExecutionWorkItem[] {
  if (!Array.isArray(value))
    throw new TypeError("Invalid execution work feed: expected array");
  return value.map((rawItem) => {
    const item = object(rawItem, "execution work item");
    const bindingsRaw = item.bindings;
    if (!Array.isArray(bindingsRaw))
      throw new TypeError("Invalid execution work bindings");
    const bindings = bindingsRaw.map((rawBinding): BindingWork => {
      const binding = object(rawBinding, "binding work");
      if (typeof binding.daemonBootMatch !== "boolean") {
        throw new TypeError(
          "Invalid binding work: daemonBootMatch must be boolean",
        );
      }
      const state = string(binding.state, "binding state");
      return {
        state,
        daemonBootMatch: binding.daemonBootMatch,
        request: parseEnsureRequest(binding.request),
        ...(binding.binding === undefined
          ? {}
          : { binding: parseReadyBinding(binding.binding) }),
      };
    });
    let pendingIntent: ExecutionWorkItem["pendingIntent"];
    if (item.pendingIntent !== undefined) {
      const intent = object(item.pendingIntent, "pending successor intent");
      const policy = string(intent.policy, "successor policy");
      if (policy !== "drain-current" && policy !== "cancel-unstarted") {
        throw new TypeError(
          "Invalid execution work: unsupported successor policy",
        );
      }
      pendingIntent = {
        intentId: string(intent.intentId, "successor intent id"),
        expectedCurrentEpoch: integer(
          intent.expectedCurrentEpoch,
          "expected current epoch",
        ),
        policy,
        request: parseEnsureRequest(intent.request),
      };
    }
    const pendingPolicy = item.pendingPolicy;
    if (
      pendingPolicy !== undefined &&
      pendingPolicy !== "drain-current" &&
      pendingPolicy !== "cancel-unstarted"
    ) {
      throw new TypeError("Invalid execution work: malformed pending policy");
    }
    return {
      conversationId: string(item.conversationId, "work conversation id"),
      currentEpoch: integer(item.currentEpoch, "current epoch"),
      ...(item.resumeGeneration === undefined
        ? {}
        : {
            resumeGeneration: integer(
              item.resumeGeneration,
              "resume generation",
            ),
          }),
      ...(item.nextDeliverySequence === undefined
        ? {}
        : {
            nextDeliverySequence: integer(
              item.nextDeliverySequence,
              "next delivery sequence",
            ),
          }),
      ...(item.pendingEpoch === undefined
        ? {}
        : { pendingEpoch: integer(item.pendingEpoch, "pending epoch") }),
      ...(pendingPolicy === undefined ? {} : { pendingPolicy }),
      bindings,
      ...(pendingIntent ? { pendingIntent } : {}),
    };
  });
}
