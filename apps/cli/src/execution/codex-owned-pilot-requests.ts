import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FENCED_RUNTIME_CAPABILITIES,
  parseStartedDeliveryPermit,
  type ReadyBinding,
  type StartedDeliveryPermit,
} from "@codecast/agent-clients/executionBinding";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import type { RuntimeDriver } from "./driver.js";
import type { RuntimeStartRequest } from "./types.js";

export type FixtureStartFailure = {
  operationId: string;
  daemonBootId: string;
  retryable: boolean;
};

export function resolveFailedStartClaim(
  failed: FixtureStartFailure,
  args: Record<string, unknown>,
) {
  if (!failed.retryable) {
    return {
      state: "busy" as const,
      operationId: failed.operationId,
      failure: {
        code: "START_NOT_RETRYABLE",
        message:
          "binding state start-failed-before-effect does not authorize startup",
      },
    };
  }
  if (failed.operationId !== String(args.proposed_operation_id)) {
    return {
      state: "rejected" as const,
      failure: {
        code: "START_RETRY_OPERATION_MISMATCH",
        message:
          "a proven pre-effect retry must reuse the exact durable operation id",
      },
    };
  }
  return {
    state: "claimed" as const,
    operationId: failed.operationId,
    recovery:
      failed.daemonBootId !== String(args.daemon_boot_id)
        ? {
            state: "recovering" as const,
            previousDaemonBootId: failed.daemonBootId,
            previousBootTerminated: true,
          }
        : { state: "fresh" as const },
  };
}

export function createFixturePeerIo(directory: string) {
  let commandIndex = 0;
  async function sendFrame(command: object) {
    const name = String(++commandIndex).padStart(6, "0");
    const barrier = `barrier:${name}`;
    const temporary = join(directory, `${name}.tmp`);
    writeFileSync(temporary, JSON.stringify({ ...command, barrier }));
    renameSync(temporary, join(directory, `${name}.command`));
    await until(
      () => existsSync(join(directory, barrier)),
      "fake app-server consumes the frame",
    );
  }
  function providerRequests() {
    const effects = join(directory, "effects");
    if (!existsSync(effects)) return [];
    return readFileSync(effects, "utf8")
      .split("\n")
      .slice(0, -1)
      .map((line) => {
        const {
          message,
        }: { message: { method: string; params: Record<string, unknown> } } =
          JSON.parse(line);
        return message;
      });
  }
  function deliveryRequests() {
    return providerRequests().filter(
      ({ method }) => method === "turn/start" || method === "turn/steer",
    );
  }
  return { sendFrame, providerRequests, deliveryRequests };
}

export function legacyFixtureDriver(actions: string[]): RuntimeDriver {
  return {
    id: "legacy-codex",
    supportedAgents: new Set(["codex"]),
    transport: "app-server",
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    async start(request) {
      actions.push(
        `legacy-start:${request.target.conversationId}:${request.target.epoch}`,
      );
      return { state: "started", handle: bindingFor(request) };
    },
    async deliver({ binding, permit }) {
      actions.push(
        `legacy-deliver:${binding.conversationId}:${binding.epoch}:${permit.conversationSequence}`,
      );
      return { state: "delivered" };
    },
    async adopt() {
      return { state: "missing" };
    },
    async stop(binding) {
      actions.push(`legacy-stop:${binding.conversationId}`);
    },
    async quarantine(binding) {
      actions.push(`legacy-quarantine:${binding.conversationId}`);
    },
  };
}

export function request(
  conversationId: string,
  projectPath: string,
  epoch = 1,
): RuntimeStartRequest {
  return {
    target: {
      conversationId,
      epoch,
      projectPath,
      requestedAgent: "codex",
      transport: "app-server",
    },
    ownerDeviceId: "device",
    daemonBootId: "boot",
    protocolVersion: 1,
    operationId: `start-${conversationId}-${epoch}`,
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    configuration: { revision: epoch },
    trigger: "recovery",
  };
}

export function bindingFor(
  { target, ...start }: RuntimeStartRequest,
  owned = false,
): ReadyBinding {
  const runtimeId = `${target.conversationId}-thread-${target.epoch}`;
  return {
    conversationId: target.conversationId,
    epoch: target.epoch,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    runtimeId,
    handle: owned
      ? "owned-codex-v1:" +
        JSON.stringify({
          threadId: runtimeId,
          sandbox: "read-only",
          approvalPolicy: "on-request",
        })
      : runtimeId,
    ownerDeviceId: start.ownerDeviceId,
    daemonBootId: start.daemonBootId,
    operationId: start.operationId,
    appliedConfigurationRevision: start.configuration.revision,
    protocolVersion: 1,
    capabilities: [...start.requiredCapabilities],
  };
}

export function pending(request: RuntimeStartRequest, binding?: ReadyBinding) {
  return {
    request,
    state: binding ? "ready" : "requested",
    daemonBootMatch: true,
    binding,
  };
}

export function item(request: RuntimeStartRequest, binding?: ReadyBinding) {
  return {
    conversationId: request.target.conversationId,
    currentEpoch: request.target.epoch,
    bindings: [pending(request, binding)],
  };
}

export function started(
  binding: ReadyBinding,
  sequence: string,
): StartedDeliveryPermit {
  return parseStartedDeliveryPermit({
    state: "delivery-started",
    messageId: `message-${sequence}`,
    deliveryId: `delivery-${sequence}`,
    conversationSequence: sequence,
    attemptId: `attempt-${sequence}`,
    conversationId: binding.conversationId,
    executionEpoch: binding.epoch,
    configurationRevision: binding.appliedConfigurationRevision,
    ownerDeviceId: binding.ownerDeviceId,
    daemonBootId: binding.daemonBootId,
    runtimeId: binding.runtimeId,
  });
}
