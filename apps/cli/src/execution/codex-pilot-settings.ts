import {
  OWNED_CODEX_CHECKPOINT_PREFIX as handlePrefix,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import type { EdgeJson } from "@codecast/edge-contract";
import type { AgentStatus } from "@codecast/sessions/agentStatus";
import type { ParsedMessage } from "../parser.js";
import type { RetryQueue } from "../retryQueue.js";
import type { SyncService } from "../syncService.js";
import { withWorktreeConfig } from "../worktreeEnv.js";
import type { CodexPilotDisplayEffect } from "./codex-pilot-display.js";
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
