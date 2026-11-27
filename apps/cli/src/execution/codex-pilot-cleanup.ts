import { randomUUID } from "node:crypto";
import {
  OWNED_CODEX_CHECKPOINT_PREFIX as handlePrefix,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import { argumentValidationProblem } from "@codecast/convex-errors/convexErrors";
import type { ClaimGrant } from "@codecast/edge-client";
import {
  EDGE_PROTOCOL_VERSION as v,
  STEER_BATON_CAPABILITY,
  parseClaimResponse,
  type EdgeParseResult,
} from "@codecast/edge-contract";
import type {
  ProviderAdapterClient,
  ProviderOwnedSession,
  RawProviderFrame,
} from "@codecast/provider-adapter";
import type {
  DeliveryReceiptJournal,
  ResumeSpec,
  StartSpec,
} from "@codecast/provider-contract";
import { STABLE_ENV_MODE } from "@codecast/snippets/stableContext";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { TerminalEventRejected } from "../terminal/terminal-lifecycle.js";
import type { CodexPilotDelivery } from "./codex-pilot-delivery.js";
import type {
  CodexPilotDisplay,
  CodexPilotDisplayEffect,
} from "./codex-pilot-display.js";
import type { CodexPilotEvents } from "./codex-pilot-events.js";
import type { CodexPilotPromptCards } from "./codex-pilot-prompt-cards.js";
import {
  codexPilotSettings,
  type PilotOptions,
} from "./codex-pilot-settings.js";
import type { RuntimeDriver } from "./driver.js";
import {
  structuredFailure,
  type RuntimeStartRequest,
  type RuntimeStartResult,
} from "./types.js";

export const PILOT_RESUME_BUSY_ERROR =
  "Could not resume Codex session: the previous run still holds its lease.";

export type SessionErrorOptions = {
  force?: boolean;
  onlyIfEquals?: string;
  throwOnError?: boolean;
};

const baseParkBackoffMs = 2_000;
const maxParkBackoffMs = 5 * 60_000;
const defaultMaxParkEntries = 1024;
const initialErrorClearRetryMs = 1_000;
const maxErrorClearRetryMs = 16_000;
const maxErrorClearRetries = 5;

function isPermanentClearError(error: unknown): boolean {
  if (argumentValidationProblem(error)) return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    if (status >= 400 && status < 500 && ![408, 425, 429].includes(status))
      return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const httpMatch = /\bHTTP\s+(4\d\d)\b/i.exec(message);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (![408, 425, 429].includes(status)) return true;
  }
  return false;
}

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

export type ParkRecord = {
  conversationId: string;
  epoch: number;
  generation: number;
  deliverySequence: number;
  failures: number;
  notBeforeMs: number;
};

export type ParkWakeDecision =
  | { kind: "parked" }
  | { kind: "defer"; notBeforeMs: number }
  | { kind: "wake"; singleClaimAttempt: boolean };

export function parkBackoffMs(failures: number, retryAfterMs = 0): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 16);
  const backoff = Math.min(maxParkBackoffMs, baseParkBackoffMs * 2 ** exponent);
  return Math.max(Math.max(0, retryAfterMs), backoff);
}

function parkKey(conversationId: string, epoch: number): string {
  return JSON.stringify([conversationId, epoch]);
}

export class ParkedPilotRegistry {
  private readonly parked = new Map<string, ParkRecord>();

  constructor(private readonly maxEntries = defaultMaxParkEntries) {}

  get size(): number {
    return this.parked.size;
  }

  get(conversationId: string, epoch: number): ParkRecord | undefined {
    return this.parked.get(parkKey(conversationId, epoch));
  }

  private put(key: string, record: ParkRecord): void {
    if (this.parked.has(key)) this.parked.delete(key);
    while (this.parked.size >= this.maxEntries) {
      const oldest = this.parked.keys().next().value;
      if (oldest === undefined) break;
      this.parked.delete(oldest);
    }
    this.parked.set(key, record);
  }

  parkClean(
    conversationId: string,
    epoch: number,
    generation: number,
    deliverySequence: number,
  ): void {
    const key = parkKey(conversationId, epoch);
    const existing = this.parked.get(key);
    this.put(key, {
      conversationId,
      epoch,
      generation: Math.max(existing?.generation ?? 0, generation),
      deliverySequence: Math.max(
        existing?.deliverySequence ?? 0,
        deliverySequence,
      ),
      failures: 0,
      notBeforeMs: 0,
    });
  }

  parkFailure(
    conversationId: string,
    epoch: number,
    generation: number,
    deliverySequence: number,
    retryAfterMs: number | undefined,
    now: number,
  ): ParkRecord {
    const key = parkKey(conversationId, epoch);
    const existing = this.parked.get(key);
    const sameGeneration =
      existing !== undefined && generation <= existing.generation;
    const failures = (sameGeneration ? existing.failures : 0) + 1;
    const record: ParkRecord = {
      conversationId,
      epoch,
      generation: Math.max(existing?.generation ?? 0, generation),
      deliverySequence: Math.max(
        existing?.deliverySequence ?? 0,
        deliverySequence,
      ),
      failures,
      notBeforeMs: now + parkBackoffMs(failures, retryAfterMs),
    };
    this.put(key, record);
    return record;
  }

  clear(conversationId: string, epoch: number): void {
    this.parked.delete(parkKey(conversationId, epoch));
  }

  forgetConversation(conversationId: string): void {
    for (const [key, record] of this.parked) {
      if (record.conversationId === conversationId) this.parked.delete(key);
    }
  }

  pruneOlderEpochs(conversationId: string, currentEpoch: number): void {
    for (const [key, record] of this.parked) {
      if (
        record.conversationId === conversationId &&
        record.epoch < currentEpoch
      )
        this.parked.delete(key);
    }
  }

  clearAll(): void {
    this.parked.clear();
  }

  wakeDecision(
    conversationId: string,
    epoch: number,
    generation: number,
    deliverySequence: number,
    now: number,
  ): ParkWakeDecision {
    const record = this.parked.get(parkKey(conversationId, epoch));
    if (!record) return { kind: "wake", singleClaimAttempt: false };
    if (generation > record.generation) {
      return { kind: "wake", singleClaimAttempt: false };
    }
    if (deliverySequence <= record.deliverySequence) {
      return { kind: "parked" };
    }
    if (now < record.notBeforeMs) {
      return { kind: "defer", notBeforeMs: record.notBeforeMs };
    }
    return { kind: "wake", singleClaimAttempt: record.failures > 0 };
  }
}

export class PilotErrorClearer {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly display: PilotOptions["display"],
    private readonly log: (message: string) => void,
  ) {}

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async clear(
    conversationId: string,
    signal: AbortSignal,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    this.cancel();
    if (signal.aborted || !isCurrent()) return;
    const attempt = () =>
      this.display.syncService.setSessionError(conversationId, undefined, {
        force: true,
        onlyIfEquals: PILOT_RESUME_BUSY_ERROR,
        throwOnError: true,
      });
    try {
      await attempt();
      return;
    } catch (error) {
      this.log(`[owned-codex] session error clear failed: ${String(error)}`);
      if (isPermanentClearError(error)) return;
    }
    this.scheduleRetry(
      attempt,
      signal,
      isCurrent,
      initialErrorClearRetryMs,
      maxErrorClearRetries,
    );
  }

  private scheduleRetry(
    attempt: () => Promise<void>,
    signal: AbortSignal,
    isCurrent: () => boolean,
    delayMs: number,
    remaining: number,
  ): void {
    if (remaining <= 0 || signal.aborted || !isCurrent()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (signal.aborted || !isCurrent()) return;
      void attempt().catch((error) => {
        if (isPermanentClearError(error)) return;
        this.scheduleRetry(
          attempt,
          signal,
          isCurrent,
          Math.min(maxErrorClearRetryMs, delayMs * 2),
          remaining - 1,
        );
      });
    }, delayMs);
    this.timer.unref();
  }
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

export async function closeOwnedPilotSession(deps: {
  log: (message: string) => void;
  session: ProviderOwnedSession | undefined;
  adapter: ProviderAdapterClient | undefined;
  eventWriter: Promise<void> | undefined;
  events: CodexPilotEvents;
  conversationId: string | undefined;
  promptCards: CodexPilotPromptCards;
  syncService: PilotOptions["display"]["syncService"];
  delivery: CodexPilotDelivery;
  releaseLease?: () => Promise<unknown>;
}): Promise<{ disposed: boolean; stopped: boolean }> {
  const { stopped, disposed, cleanup } = await closeOwnedProvider(
    deps.log,
    deps.session,
    deps.adapter,
  );
  if (stopped) await cleanup("event writer cleanup", () => deps.eventWriter);
  await cleanup("event cleanup", () => deps.events.close());
  if (deps.conversationId) {
    await cleanup("prompt card cleanup", () =>
      deps.promptCards.closeAll(
        deps.conversationId!,
        Date.now(),
        deps.syncService,
      ),
    );
  }
  await cleanup("image cleanup", () => deps.delivery.clearImages());
  if (stopped && deps.session && deps.releaseLease) {
    await cleanup("lease release", deps.releaseLease);
  }
  return { disposed: Boolean(disposed), stopped: Boolean(stopped) };
}

export async function checkPilotRenewalLiveness(deps: {
  signal: AbortSignal;
  session: ProviderOwnedSession | undefined;
  streamProgress: number;
  progressAtRenewal: number;
  consecutiveMisses: number;
  maxConsecutiveMisses: number;
  sessionId: string;
  display: PilotOptions["display"];
  currentProgress: () => number;
}): Promise<number> {
  const responsive =
    deps.streamProgress !== deps.progressAtRenewal ||
    !deps.session?.checkLiveness ||
    (await deps.session.checkLiveness(deps.signal).catch(() => false));
  deps.signal.throwIfAborted();
  if (responsive || deps.streamProgress !== deps.currentProgress()) return 0;
  const misses = deps.consecutiveMisses + 1;
  if (misses >= deps.maxConsecutiveMisses) {
    if (deps.session) {
      deps.display.sendAgentStatus(
        deps.display.syncService,
        deps.sessionId,
        deps.session.getCheckpoint(),
        "stopped",
      );
    }
    throw new Error("Owned Codex app-server stopped responding");
  }
  return misses;
}

export async function claimOwnedPilotRun(
  binding: ReadyBinding,
  edge: <T>(
    operation: string,
    request: object,
    parse: (input: unknown) => EdgeParseResult<T>,
  ) => Promise<T>,
  onBusy: (retryAfterMs: number) => Error,
): Promise<ClaimGrant> {
  const claim = await edge(
    "claim",
    {
      v,
      session: binding.conversationId,
      machine: binding.ownerDeviceId,
      boot: binding.daemonBootId,
      claim_id: randomUUID(),
    },
    parseClaimResponse,
  );
  if (claim.status === "busy") throw onBusy(claim.retry_after_ms);
  if (claim.status !== "granted") {
    throw new Error(
      `Owned Codex pilot could not claim the run: ${claim.status}`,
    );
  }
  return claim;
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

export async function postOwnedEdgeResponse(
  siteUrl: string,
  bearer: string | undefined,
  operation: string,
  request: object,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(new URL(`/edge/v1/${operation}`, siteUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    const message = `Owned Codex ${operation} failed with HTTP ${response.status}`;
    if (
      operation === "events.append" &&
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 425, 429].includes(response.status)
    )
      throw new TerminalEventRejected(message);
    throw new Error(message);
  }
  return response;
}

export async function openOwnedProvider(
  adapter: ProviderAdapterClient | undefined,
  options: {
    provider: { agent: "codex"; version: string };
    command: () => readonly [string, ...string[]];
    retainRaw: (frame: RawProviderFrame) => void;
    receiptJournal: DeliveryReceiptJournal | undefined;
  },
  spec: StartSpec | ResumeSpec,
  signal: AbortSignal,
): Promise<{
  adapter: ProviderAdapterClient;
  session: ProviderOwnedSession;
}> {
  const { createProviderAdapter } = await import("@codecast/provider-adapter");
  signal.throwIfAborted();
  const nextAdapter =
    adapter ??
    createProviderAdapter({
      provider: options.provider,
      command: options.command(),
      env: { ...process.env, PATH: agentSpawnPath(), [STABLE_ENV_MODE]: "off" },
      retainRaw: options.retainRaw,
      receiptJournal: options.receiptJournal,
      uniquePromptIds: true,
    });
  const result =
    "checkpoint" in spec
      ? await nextAdapter.resume(spec, signal)
      : await nextAdapter.start(spec, signal);
  if (result.status !== "opened")
    throw new Error("message" in result ? result.message : result.status);
  return { adapter: nextAdapter, session: result.session };
}

export async function writeOwnedPilotEvents(deps: {
  claim: ClaimGrant;
  session: ProviderOwnedSession;
  binding: ReadyBinding;
  model: string | undefined;
  signal: AbortSignal;
  options: PilotOptions;
  events: CodexPilotEvents;
  delivery: CodexPilotDelivery;
  promptCards: CodexPilotPromptCards;
  display: CodexPilotDisplay;
  onProgress: () => void;
}): Promise<void> {
  const { syncService, sendAgentStatus } = deps.options.display;
  const { conversationId, runtimeId } = deps.binding;
  for await (const event of deps.session.events) {
    deps.signal.throwIfAborted();
    deps.onProgress();
    if (event.kind === "message.delta") continue;
    await deps.events.appendEvent(
      deps.claim,
      deps.delivery.attributeTurnStart(event),
    );
    await deps.delivery.observe(event, deps.session, deps.signal);
    await deps.promptCards
      .publish(event, deps.claim, deps.session, syncService, () => {
        sendAgentStatus(
          syncService,
          conversationId,
          runtimeId,
          "permission_blocked",
        );
      })
      .catch((error) =>
        deps.options.log(
          `[owned-codex] prompt card update failed: ${String(error)}`,
        ),
      );
    await deps.display
      .publish(
        runtimeId,
        event,
        (effect) =>
          applyPilotDisplayEffect(
            deps.options.display,
            conversationId,
            runtimeId,
            effect,
          ),
        deps.model,
      )
      .catch((error) =>
        deps.options.log(
          `[owned-codex] display update failed: ${String(error)}`,
        ),
      );
  }
}

export async function startOwnedPilotSession(
  options: PilotOptions,
  request: RuntimeStartRequest,
  open: (spec: StartSpec) => Promise<ProviderOwnedSession>,
  onClose: () => Promise<void>,
): Promise<{
  session?: ProviderOwnedSession;
  result: RuntimeStartResult;
}> {
  try {
    const defaults = options.permissions();
    const permissions = {
      sandbox: request.target.isolation?.sandbox ?? defaults.sandbox,
      approvalPolicy:
        request.target.isolation?.approvalPolicy ?? defaults.approvalPolicy,
    };
    const session = await open({
      session: request.target.conversationId,
      run: request.target.epoch,
      cwd: request.target.projectPath,
      afterSeq: 1,
      fencing_token: request.operationId,
      options: await codexPilotSettings(
        options.instructions,
        request,
        permissions,
      ),
    });
    const threadId = session.getCheckpoint();
    return {
      session,
      result: {
        state: "started",
        handle: {
          runtimeId: threadId,
          handle: handlePrefix + JSON.stringify({ threadId, ...permissions }),
          actualAgent: "codex",
          transport: "app-server",
          capabilities: request.requiredCapabilities,
        },
      },
    };
  } catch (error) {
    await onClose().catch(() => {});
    return {
      result: {
        state: "ambiguous",
        failure: structuredFailure("OWNED_CODEX_START_AMBIGUOUS", error),
      },
    };
  }
}
