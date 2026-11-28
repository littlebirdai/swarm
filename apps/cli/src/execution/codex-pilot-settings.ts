import {
  OWNED_CODEX_CHECKPOINT_PREFIX as handlePrefix,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import type { startRelayLiveness } from "@codecast/edge-client/relay-liveness";
import type { EdgeJson } from "@codecast/edge-contract";
import type { AgentStatus } from "@codecast/sessions/agentStatus";
import type { ParsedMessage } from "../parser.js";
import type { RetryQueue } from "../retryQueue.js";
import type { SyncService } from "../syncService.js";
import { withWorktreeConfig } from "../worktreeEnv.js";
import { deliveryFence } from "./codex-pilot-delivery.js";
import type { CodexPilotDisplayEffect } from "./codex-pilot-display.js";
import { CodexAppServerRuntimeDriver } from "./drivers/codex-app-server.js";
import type { RuntimeDriver, RuntimeDriverRegistry } from "./driver.js";
import type { EnsureBindingRequest } from "./types.js";

const sandboxes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
const approvals = ["untrusted", "on-failure", "on-request", "never"] as const;
export type Permissions = {
  sandbox: (typeof sandboxes)[number];
  approvalPolicy: (typeof approvals)[number];
};

export function checkpointOf(
  binding: ReadyBinding,
): Permissions & { threadId: string } {
  const { threadId, sandbox, approvalPolicy } = JSON.parse(
    binding.handle.slice(handlePrefix.length),
  );
  if (
    threadId !== binding.runtimeId ||
    !sandboxes.includes(sandbox) ||
    !approvals.includes(approvalPolicy)
  )
    throw new Error("Invalid owned Codex checkpoint");
  return { threadId, sandbox, approvalPolicy };
}

export type CodexPilotInstructions = (
  cwd: string,
  prefs: Record<string, never>,
  conversationId: string,
) => Promise<{ text: string } | undefined>;

export type PilotOptions = {
  siteUrl: string;
  bearer: string | undefined;
  command: () => readonly [string, ...string[]];
  permissions: () => Permissions;
  instructions: CodexPilotInstructions;
  display: {
    syncService: SyncService;
    retryQueue: RetryQueue;
    conversationCache: Record<string, string>;
    mapCodexAppServerThreadStatusToAgentStatus: (
      status: Extract<
        CodexPilotDisplayEffect,
        { type: "statusChanged" }
      >["status"],
    ) => AgentStatus | null;
    sendAgentStatus: (
      service: SyncService,
      conversation: string,
      thread: string,
      status: AgentStatus,
    ) => void;
    trackTmuxSpawns: (
      messages: ParsedMessage[],
      conversation: string,
      service: SyncService,
      cache: Record<string, string>,
    ) => Promise<void>;
    syncMessagesBatch: (
      messages: ParsedMessage[],
      conversation: string,
      service: SyncService,
      retry: RetryQueue,
    ) => Promise<unknown>;
  };
  log: (message: string) => void;
};

export async function codexPilotSettings(
  instructions: CodexPilotInstructions,
  request: EnsureBindingRequest,
  permissions: Permissions,
): Promise<EdgeJson> {
  const { sandbox, approvalPolicy } = permissions;
  const developerInstructions = (
    await instructions(
      request.target.projectPath,
      {},
      request.target.conversationId,
    )
  )?.text;
  return withWorktreeConfig({
    cwd: request.target.projectPath,
    ...(request.configuration.model
      ? { model: request.configuration.model }
      : {}),
    sandbox: request.target.isolation?.sandbox ?? sandbox,
    approvalPolicy: request.target.isolation?.approvalPolicy ?? approvalPolicy,
    ...(request.configuration.effort
      ? { config: { model_reasoning_effort: request.configuration.effort } }
      : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
  });
}

export type OwnedCodexRelayFlags = {
  liveness: boolean;
  tokenDeltas: boolean;
};

export function readOwnedCodexRelayFlags(
  env: Record<string, string | undefined> = process.env,
): OwnedCodexRelayFlags {
  return {
    liveness: env.CODECAST_RELAY_LIVENESS_PUBLISH === "1",
    tokenDeltas: env.CODECAST_RELAY_TOKEN_DELTAS === "1",
  };
}

export function startOwnedCodexRelayContact(
  options: Pick<PilotOptions, "bearer" | "siteUrl" | "log">,
  provider: { readonly agent: string; readonly version: string },
  claim: ClaimGrant,
  binding: ReadyBinding,
  signal: AbortSignal,
  deadline: () => number,
  onRelay: (relay: ReturnType<typeof startRelayLiveness>) => void,
  flags: OwnedCodexRelayFlags = { liveness: true, tokenDeltas: false },
): void {
  const { bearer, siteUrl, log } = options;
  if (!bearer || (!flags.liveness && !flags.tokenDeltas)) return;
  const launchRelayPublisher = () => {
    void Promise.all([
      import("@codecast/edge-client"),
      import("@codecast/edge-client/relay-liveness"),
    ])
      .then(([{ createHttpEdgeTransport }, { startRelayLiveness }]) => {
        if (signal.aborted) return;
        const relay = startRelayLiveness(
          {
            transport: createHttpEdgeTransport(new URL("/edge/v1/", siteUrl), {
              Authorization: `Bearer ${bearer}`,
            }),
            sessionLiveness: flags.liveness,
            tokenDeltas: flags.tokenDeltas,
            hello: {
              machine: binding.ownerDeviceId,
              boot: binding.daemonBootId,
              providers: [{ name: provider.agent, version: provider.version }],
              runtimes: [{ host: "daemon", isolation: "app-server" }],
              capacity: {
                memory_total_bytes: 0,
                memory_available_bytes: 0,
                live_agents: 1,
              },
            },
          },
          signal,
          [{ ...deliveryFence(claim), deadline: deadline() }],
        );
        onRelay(relay);
        return relay.running;
      })
      .catch(() => {
        if (!signal.aborted) log("[owned-codex] relay liveness stopped");
      });
  };
  setImmediate(launchRelayPublisher).unref();
}

export function registerCodexExecutionDriver(
  registry: RuntimeDriverRegistry,
  pilot: { register(legacy: RuntimeDriver): RuntimeDriver } | undefined,
  options: {
    client: ConstructorParameters<
      typeof CodexAppServerRuntimeDriver
    >[0]["io"]["client"];
    defaultPermissions: () => Permissions;
    threads: ReadonlyMap<string, { conversationId: string }>;
    isRunning: () => boolean;
    registerThread: ConstructorParameters<
      typeof CodexAppServerRuntimeDriver
    >[0]["io"]["registerThread"];
    teardownConversation: (conversationId: string) => Promise<unknown>;
  },
): void {
  const stopThread = async (threadId: string) => {
    const entry = options.threads.get(threadId);
    if (entry) await options.teardownConversation(entry.conversationId);
  };
  const legacy = new CodexAppServerRuntimeDriver({
    defaultPermissions: options.defaultPermissions,
    io: {
      client: options.client,
      registerThread: options.registerThread,
      inspectThread: async (id) =>
        !options.isRunning()
          ? "unknown"
          : options.threads.has(id)
            ? "alive"
            : "unknown",
      stopThread,
      quarantineThread: stopThread,
    },
  });
  registry.register(pilot?.register(legacy) ?? legacy);
}
