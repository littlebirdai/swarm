import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import type {
  ProviderAdapterClient,
  ProviderOwnedSession,
} from "@codecast/provider-adapter";
import type { CodexPilotDisplayEffect } from "./codex-pilot-display.js";
import type { PilotOptions } from "./codex-pilot-settings.js";
import type { RuntimeDriver } from "./driver.js";
import type { RuntimeStartRequest, RuntimeStartResult } from "./types.js";

export function createOwnedPilotDriver(
  legacy: RuntimeDriver,
  owned: {
    acceptsNewSessions: boolean;
    ownsCheckpoint: (handle: string) => boolean;
    start: (
      request: RuntimeStartRequest,
    ) => Promise<RuntimeStartResult> | undefined;
    stop: (binding: ReadyBinding) => Promise<void> | undefined;
  },
): RuntimeDriver {
  return {
    id: "codex-app-server-with-owned-pilot-v1",
    transport: legacy.transport,
    supportedAgents: legacy.supportedAgents,
    capabilities: owned.acceptsNewSessions
      ? [...legacy.capabilities, STEER_BATON_CAPABILITY]
      : legacy.capabilities,
    start: (request) => owned.start(request) ?? legacy.start(request),
    adopt: (request) =>
      request.knownHandle && owned.ownsCheckpoint(request.knownHandle.handle)
        ? Promise.resolve({
            state: "unknown",
            failure: {
              code: "OWNED_CODEX_START_UNCONFIRMED",
              message: "Owned Codex can resume only a ready binding",
            },
          })
        : legacy.adopt(request),
    deliver: (request) =>
      owned.ownsCheckpoint(request.binding.handle)
        ? Promise.resolve({
            state: "failed-before-effect",
            failure: {
              code: "OWNED_CODEX_DELIVERY_PENDING",
              message: "Owned Codex delivery is unavailable",
            },
          })
        : legacy.deliver(request),
    stop: (binding) => owned.stop(binding) ?? legacy.stop(binding),
    quarantine: (binding, reason) =>
      owned.stop(binding) ?? legacy.quarantine(binding, reason),
  };
}

export type ParkedPilot = {
  generation: number;
  deliverySequence: number;
  exhausted: boolean;
};

export class ParkedPilotRegistry {
  private readonly parked = new Map<string, ParkedPilot>();
  private readonly recordedFailures = new Set<string>();

  park(key: string, state: ParkedPilot): void {
    this.parked.set(key, state);
  }

  unpark(key: string): void {
    this.parked.delete(key);
  }

  wakeDecision(
    key: string,
    generation: number,
    deliverySequence: number,
  ): { wake: false } | { wake: true; singleClaimAttempt: boolean } {
    const parked = this.parked.get(key);
    if (
      parked !== undefined &&
      generation <= parked.generation &&
      deliverySequence <= parked.deliverySequence
    )
      return { wake: false };
    return {
      wake: true,
      singleClaimAttempt:
        parked?.exhausted === true && generation <= parked.generation,
    };
  }

  recordFailure(conversationId: string): boolean {
    if (this.recordedFailures.has(conversationId)) return false;
    this.recordedFailures.add(conversationId);
    return true;
  }

  hasFailure(conversationId: string): boolean {
    return this.recordedFailures.has(conversationId);
  }

  clearFailure(conversationId: string): void {
    this.recordedFailures.delete(conversationId);
  }
}

export async function clearPilotFailure(
  display: PilotOptions["display"],
  log: (message: string) => void,
  conversationId: string,
): Promise<void> {
  await display.syncService
    .setSessionError(conversationId, undefined, { force: true })
    .catch((error) => {
      log(`[owned-codex] session error clear failed: ${String(error)}`);
    });
}

export async function applyPilotDisplayEffect(
  options: PilotOptions["display"],
  conversationId: string,
  runtimeId: string,
  effect: CodexPilotDisplayEffect,
): Promise<void> {
  const { syncService, retryQueue, conversationCache, ...display } = options;
  switch (effect.type) {
    case "statusChanged": {
      const status = display.mapCodexAppServerThreadStatusToAgentStatus(
        effect.status,
      );
      if (status)
        display.sendAgentStatus(syncService, conversationId, runtimeId, status);
      break;
    }
    case "threadNameUpdated":
      await syncService.updateTitle(conversationId, effect.name);
      break;
    case "itemStarted":
      await display.trackTmuxSpawns(
        [effect.message],
        conversationId,
        syncService,
        conversationCache,
      );
      break;
    case "error":
      await syncService.setSessionError(conversationId, effect.message, {
        force: true,
      });
      break;
    case "messages":
      await display.syncMessagesBatch(
        effect.messages,
        conversationId,
        syncService,
        retryQueue,
      );
      break;
  }
}

export async function reportPilotFailure(
  display: PilotOptions["display"],
  log: (message: string) => void,
  binding: ReadyBinding,
  message: string,
): Promise<void> {
  display.sendAgentStatus(
    display.syncService,
    binding.conversationId,
    binding.runtimeId,
    "stopped",
  );
  await display.syncService
    .setSessionError(binding.conversationId, message, { force: true })
    .catch((error) => {
      log(`[owned-codex] session error update failed: ${String(error)}`);
    });
}

export async function closeOwnedProvider(
  log: (message: string) => void,
  session: ProviderOwnedSession | undefined,
  adapter: ProviderAdapterClient | undefined,
) {
  async function cleanup<T>(name: string, step: () => T | Promise<T>) {
    try {
      return await step();
    } catch (error) {
      log(`[owned-codex] ${name} failed: ${String(error)}`);
    }
  }
  const outcome = await cleanup("provider close", () => session?.close());
  const disposed = await cleanup("adapter disposal", async () => {
    await adapter?.dispose();
    return true;
  });
  const stopped =
    !session ||
    outcome?.status === "closed" ||
    (await cleanup("process exit confirmation", () => session.processGone?.()));
  return { disposed, stopped, cleanup };
}

export async function closePilots(
  pilots: readonly { close(): Promise<void> }[],
) {
  const results = await Promise.allSettled(
    pilots.map((pilot) => pilot.close()),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}
