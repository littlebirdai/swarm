import { randomUUID } from "node:crypto";
import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import {
  EDGE_PROTOCOL_VERSION as v,
  parseClaimResponse,
  parseEventsAppendResponse,
  parseReleaseResponse,
  parseRenewResponse,
  type CanonicalEvent,
  type EdgeJson,
  type EdgeParseResult,
} from "@codecast/edge-contract";
import type { ProviderAdapterClient } from "@codecast/provider-adapter";
import type {
  DeliveryReceiptJournal,
  OwnedSession,
  ResumeSpec,
  StartSpec,
} from "@codecast/provider-contract";
import type { AgentStatus } from "@codecast/sessions/agentStatus";
import { STABLE_ENV_MODE } from "@codecast/snippets/stableContext";
import {
  CodexPilotDisplay,
  type CodexPilotDisplayEffect,
} from "./codex-pilot-display.js";
import type { ParsedMessage } from "../parser.js";
import type { RetryQueue } from "../retryQueue.js";
import type { SyncService } from "../syncService.js";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { withWorktreeConfig } from "../worktreeEnv.js";
import {
  CodexPilotDelivery,
  deliveryFence,
  readEdge,
} from "./codex-pilot-delivery.js";
import type { ExecutionCoordinator } from "./coordinator.js";
import type { RuntimeDriver } from "./driver.js";
import type {
  EnsureBindingRequest,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "./types.js";
import { structuredFailure } from "./types.js";

const handlePrefix = "owned-codex-v1:";
const provider = { agent: "codex", version: "0.153.4" } as const;

export function ownsCodexCheckpoint(handle: string): boolean {
  return handle.startsWith(handlePrefix);
}

const sandboxes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
const approvals = ["untrusted", "on-failure", "on-request", "never"] as const;
type Permissions = {
  sandbox: (typeof sandboxes)[number];
  approvalPolicy: (typeof approvals)[number];
};

function checkpointOf(
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

type PilotOptions = {
  siteUrl: string;
  bearer: string | undefined;
  command: () => readonly [string, ...string[]];
  permissions: () => Permissions;
  instructions: (
    cwd: string,
    prefs: Record<string, never>,
    conversationId: string,
  ) => Promise<{ text: string } | undefined>;
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

export function createCodexOwnedPilot(
  options: PilotOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexOwnedPilot | undefined {
  const conversationId = env.CODECAST_CODEX_OWNED_PILOT_SESSION?.trim();
  if (env.CODECAST_FENCED_EXECUTION_V1 !== "1" || !conversationId) return;
  if (!options.bearer) {
    options.log("[owned-codex] pilot requires daemon auth");
    return;
  }
  return new CodexOwnedPilot(conversationId, options);
}

export class CodexOwnedPilot {
  private readonly display = new CodexPilotDisplay();
  private readonly delivery = new CodexPilotDelivery(
    this.edgeResponse.bind(this),
    (message) => this.options.log(message),
  );
  private deliveryReady = false;
  private adapter?: ProviderAdapterClient;
  private session?: OwnedSession;
  private opening?: Promise<OwnedSession>;
  private claim?: ClaimGrant;
  private claiming?: Promise<ClaimGrant>;
  private stopping = false;
  private activation?: Promise<void>;
  private closing?: Promise<void>;
  private renewal?: ReturnType<typeof setTimeout>;
  private renewalTask?: Promise<void>;
  private controller = new AbortController();

  constructor(
    private readonly conversationId: string,
    private readonly options: PilotOptions,
  ) {}

  selects(conversationId: string, epoch = 1): boolean {
    return conversationId === this.conversationId && epoch === 1;
  }

  owns(binding: ReadyBinding): boolean {
    return (
      this.selects(binding.conversationId, binding.epoch) &&
      binding.actualAgent === "codex" &&
      binding.transport === "app-server" &&
      ownsCodexCheckpoint(binding.handle)
    );
  }

  useReceiptJournal(journal: DeliveryReceiptJournal | undefined): void {
    this.delivery.receiptJournal = journal;
  }

  register(legacy: RuntimeDriver): RuntimeDriver {
    return {
      id: "codex-app-server-with-owned-pilot-v1",
      transport: legacy.transport,
      supportedAgents: legacy.supportedAgents,
      capabilities: legacy.capabilities,
      start: (request) =>
        this.selects(request.target.conversationId, request.target.epoch)
          ? this.start(request)
          : legacy.start(request),
      adopt: (request) =>
        request.knownHandle && ownsCodexCheckpoint(request.knownHandle.handle)
          ? Promise.resolve({
              state: "unknown",
              failure: {
                code: "OWNED_CODEX_START_UNCONFIRMED",
                message: "Owned Codex can resume only a ready binding",
              },
            })
          : legacy.adopt(request),
      deliver: (request) =>
        ownsCodexCheckpoint(request.binding.handle)
          ? Promise.resolve({
              state: "failed-before-effect",
              failure: {
                code: "OWNED_CODEX_DELIVERY_PENDING",
                message: "Owned Codex delivery is unavailable",
              },
            })
          : legacy.deliver(request),
      stop: (binding) =>
        this.owns(binding) ? this.close() : legacy.stop(binding),
      quarantine: (binding, reason) =>
        this.owns(binding) ? this.close() : legacy.quarantine(binding, reason),
    };
  }

  private async settings(
    request: EnsureBindingRequest,
    permissions: Permissions,
  ): Promise<EdgeJson> {
    const { sandbox, approvalPolicy } = permissions;
    const developerInstructions = (
      await this.options.instructions(
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
      approvalPolicy:
        request.target.isolation?.approvalPolicy ?? approvalPolicy,
      ...(request.configuration.effort
        ? { config: { model_reasoning_effort: request.configuration.effort } }
        : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    });
  }

  private open(spec: StartSpec | ResumeSpec): Promise<OwnedSession> {
    return (this.opening = this.openProvider(spec));
  }

  private async openProvider(
    spec: StartSpec | ResumeSpec,
  ): Promise<OwnedSession> {
    const { createProviderAdapter } =
      await import("@codecast/provider-adapter");
    this.controller.signal.throwIfAborted();
    this.adapter ??= createProviderAdapter({
      provider,
      command: this.options.command(),
      env: { ...process.env, PATH: agentSpawnPath(), [STABLE_ENV_MODE]: "off" },
      retainRaw: (frame) => this.display.retain(frame),
      receiptJournal: this.delivery.receiptJournal,
    });
    const result =
      "checkpoint" in spec
        ? await this.adapter.resume(spec, this.controller.signal)
        : await this.adapter.start(spec, this.controller.signal);
    if (result.status !== "opened")
      throw new Error("message" in result ? result.message : result.status);
    return result.session;
  }

  private async start(
    request: RuntimeStartRequest,
  ): Promise<RuntimeStartResult> {
    try {
      const defaults = this.options.permissions();
      const permissions = {
        sandbox: request.target.isolation?.sandbox ?? defaults.sandbox,
        approvalPolicy:
          request.target.isolation?.approvalPolicy ?? defaults.approvalPolicy,
      };
      this.session = await this.open({
        session: request.target.conversationId,
        run: request.target.epoch,
        cwd: request.target.projectPath,
        afterSeq: 1,
        fencing_token: request.operationId,
        options: await this.settings(request, permissions),
      });
      const threadId = this.session.getCheckpoint();
      return {
        state: "started",
        handle: {
          runtimeId: threadId,
          handle: handlePrefix + JSON.stringify({ threadId, ...permissions }),
          actualAgent: "codex",
          transport: "app-server",
          capabilities: request.requiredCapabilities,
        },
      };
    } catch (error) {
      await this.close().catch(() => {});
      return {
        state: "ambiguous",
        failure: structuredFailure("OWNED_CODEX_START_AMBIGUOUS", error),
      };
    }
  }

  activate(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    if (this.stopping || !this.owns(binding)) return Promise.resolve();
    return (this.activation ??= this.claimAndRead(binding, request).catch(
      async (error) => {
        if (this.claim || this.stopping) {
          await this.close();
        } else {
          await (this.closing ??= this.closeOwned());
          if (!this.stopping) {
            this.session = undefined;
            this.opening = undefined;
            this.adapter = undefined;
            this.claiming = undefined;
            this.controller = new AbortController();
            this.closing = undefined;
            this.activation = undefined;
          }
        }
        throw error;
      },
    ));
  }

  private async edge<T>(
    operation: string,
    request: object,
    parse: (input: unknown) => EdgeParseResult<T>,
    signal: AbortSignal = this.controller.signal,
  ): Promise<T> {
    return readEdge(
      this.edgeResponse.bind(this),
      signal,
      operation,
      request,
      parse,
    );
  }

  private async edgeResponse(
    operation: string,
    request: object,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(
      new URL(`/edge/v1/${operation}`, this.options.siteUrl),
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    if (!response.ok)
      throw new Error(
        `Owned Codex ${operation} failed with HTTP ${response.status}`,
      );
    return response;
  }

  private async claimAndRead(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    const previousClaim = this.claim;
    this.claiming ??= this.edge(
      "claim",
      {
        v,
        session: binding.conversationId,
        machine: binding.ownerDeviceId,
        boot: binding.daemonBootId,
        claim_id: randomUUID(),
      },
      parseClaimResponse,
    ).then((claim) => {
      if (claim.status !== "granted")
        throw new Error(
          `Owned Codex pilot could not claim the run: ${claim.status}`,
        );
      this.claim = claim;
      return claim;
    });
    const claim = await this.claiming;
    this.controller.signal.throwIfAborted();
    if (claim.session !== binding.conversationId || claim.run !== binding.epoch)
      throw new Error("Owned Codex lease does not match the binding");
    if (!previousClaim) this.scheduleRenewal(claim, claim.lease_ms);
    const checkpoint = checkpointOf(binding);
    const previous = claim.last_event_seq ?? 0;
    let pending;
    try {
      pending = await this.delivery.nextPermit(claim, this.controller.signal);
    } catch (error) {
      if (this.controller.signal.aborted) throw error;
      this.options.log(
        `[owned-codex] could not read the delivery head: ${String(error)}`,
      );
      this.activation = undefined;
      return;
    }
    if (!this.delivery.receiptJournal)
      throw new Error(
        "Owned Codex requires a durable delivery receipt journal",
      );
    if (this.session) {
      if (previous !== 0)
        throw new Error("Fresh owned Codex binding already has events");
      if ((await this.session.close()).status !== "closed")
        throw new Error("Could not close the provisional owned Codex session");
    }
    await this.delivery.pruneSettledReceipts(
      claim.session,
      checkpoint.threadId,
      pending?.delivery_id,
      this.controller.signal,
    );
    this.session = await this.open({
      session: claim.session,
      run: claim.run,
      fencing_token: claim.fencing_token,
      cwd: request.target.projectPath,
      afterSeq: Math.max(previous, 1),
      options: await this.settings(request, checkpoint),
      checkpoint: checkpoint.threadId,
      inDoubtDeliveryIds: pending ? [pending.delivery_id] : [],
    });
    if (previous === 0) {
      await this.append(claim, {
        v,
        session: claim.session,
        run: claim.run,
        seq: 1,
        at: Date.now(),
        source: "provider",
        turn: null,
        kind: "session.started",
        body: { machine: binding.ownerDeviceId, provider: provider.agent },
      });
    }
    this.deliveryReady = true;
    void this.writeEvents(
      claim,
      this.session,
      binding,
      request.configuration.model,
    )
      .then(() => this.close())
      .catch((error) => {
        this.options.log(
          `[owned-codex] event writer stopped: ${String(error)}`,
        );
        void this.close().catch(() => {});
      });
  }

  async drain(
    binding: ReadyBinding,
    coordinator: ExecutionCoordinator,
    prepareText: (text: string) => Promise<string>,
    sendNew: boolean,
  ): Promise<boolean> {
    const { session, claim } = this;
    if (
      !this.deliveryReady ||
      this.stopping ||
      !session ||
      !claim ||
      !this.owns(binding)
    )
      return false;
    return this.delivery.drain(
      binding,
      coordinator,
      session,
      claim,
      prepareText,
      this.controller.signal,
      sendNew,
    );
  }

  private async writeEvents(
    claim: ClaimGrant,
    session: OwnedSession,
    binding: ReadyBinding,
    model: string | undefined,
  ): Promise<void> {
    const { syncService, retryQueue, conversationCache, ...display } =
      this.options.display;
    const { conversationId, runtimeId } = binding;
    for await (const event of session.events) {
      if (event.kind === "message.delta") continue;
      await this.append(claim, event);
      await this.delivery.observe(event, session, this.controller.signal);
      await this.display
        .publish(
          runtimeId,
          event,
          async (effect) => {
            switch (effect.type) {
              case "statusChanged": {
                const status =
                  display.mapCodexAppServerThreadStatusToAgentStatus(
                    effect.status,
                  );
                if (status)
                  display.sendAgentStatus(
                    syncService,
                    conversationId,
                    runtimeId,
                    status,
                  );
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
                await syncService.setSessionError(
                  conversationId,
                  effect.message,
                  { force: true },
                );
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
          },
          model,
        )
        .catch((error) =>
          this.options.log(
            `[owned-codex] display update failed: ${String(error)}`,
          ),
        );
    }
  }

  private async append(
    claim: ClaimGrant,
    event: CanonicalEvent,
  ): Promise<void> {
    const response = await this.edge(
      "events.append",
      {
        v,
        batches: [{ ...deliveryFence(claim), events: [event] }],
      },
      parseEventsAppendResponse,
    );
    const result = "results" in response ? response.results[0] : undefined;
    if (
      result?.status !== "appended" ||
      result.session !== claim.session ||
      result.through_seq !== event.seq
    )
      throw new Error("Owned Codex event sequence was not confirmed");
  }

  private scheduleRenewal(claim: ClaimGrant, duration: number): void {
    if (this.controller.signal.aborted) return;
    this.renewal = setTimeout(() => {
      this.renewalTask = this.edge(
        "renew",
        { v, ...deliveryFence(claim) },
        parseRenewResponse,
      ).then((result) => {
        if (result.status !== "renewed")
          throw new Error("Owned Codex lease expired");
        this.scheduleRenewal(claim, result.lease_ms);
      });
      void this.renewalTask.catch((error) => {
        this.options.log(
          `[owned-codex] lease renewal failed: ${String(error)}`,
        );
        void this.close().catch(() => {});
      });
    }, duration / 2);
    this.renewal.unref();
  }

  close(): Promise<void> {
    this.stopping = true;
    return (this.closing ??= this.closeOwned());
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.renewal);
    await this.claiming?.catch(() => {});
    await this.renewalTask?.catch(() => {});
    const session =
      (await this.opening?.catch(() => undefined)) ?? this.session;
    if (session && (await session.close()).status !== "closed")
      throw new Error("Owned Codex cleanup could not be confirmed");
    await this.adapter?.dispose();
    await this.delivery.clearImages();
    if (this.claim && session) {
      await this.edge(
        "release",
        { v, ...deliveryFence(this.claim) },
        parseReleaseResponse,
        AbortSignal.timeout(10_000),
      );
    }
  }
}
