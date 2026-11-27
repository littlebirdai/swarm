import { randomUUID } from "node:crypto";
import { TerminalEventRejected } from "../terminal/terminal-lifecycle.js";
import {
  OWNED_CODEX_CHECKPOINT_PREFIX as handlePrefix,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import type { startRelayLiveness } from "@codecast/edge-client/relay-liveness";
import {
  EDGE_PROTOCOL_VERSION as v,
  STEER_BATON_CAPABILITY,
  parseClaimResponse,
  parseReleaseResponse,
  parseRenewResponse,
  type CanonicalEvent,
  type EdgeParseResult,
} from "@codecast/edge-contract";
import type {
  ProviderAdapterClient,
  ProviderOwnedSession,
} from "@codecast/provider-adapter";
import type {
  DeliveryReceiptJournal,
  ResumeSpec,
  StartSpec,
} from "@codecast/provider-contract";
import { STABLE_ENV_MODE } from "@codecast/snippets/stableContext";
import { CodexPilotDisplay } from "./codex-pilot-display.js";
import { agentSpawnPath } from "../agentSpawnPath.js";
import {
  checkpointOf,
  codexPilotSettings,
  type PilotOptions,
} from "./codex-pilot-settings.js";
import {
  CodexPilotDelivery,
  CodexPilotLeaseLost,
  deliveryFence,
  readEdge,
} from "./codex-pilot-delivery.js";
import { CodexPilotEvents } from "./codex-pilot-events.js";
import { CodexPilotPromptCards } from "./codex-pilot-prompt-cards.js";
import type { ExecutionCoordinator } from "./coordinator.js";
import type { RuntimeDriver } from "./driver.js";
import type {
  EnsureBindingRequest,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "./types.js";
import { structuredFailure } from "./types.js";

const provider = { agent: "codex", version: "0.153.4" } as const;
const maxConsecutiveLivenessMisses = 3;

export function ownsCodexCheckpoint(handle: string): boolean {
  return handle.startsWith(handlePrefix);
}

export function createCodexOwnedPilot(
  options: PilotOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexOwnedPilot | undefined {
  const conversationId =
    env.CODECAST_CODEX_OWNED_PILOT_SESSION?.trim() || undefined;
  const acceptsNewSessions = env.CODECAST_CODEX_OWNED_NEW_SESSIONS === "1";
  if (
    env.CODECAST_FENCED_EXECUTION_V1 !== "1" ||
    (!conversationId && !acceptsNewSessions)
  )
    return;
  if (!options.bearer) {
    options.log("[owned-codex] pilot requires daemon auth");
    return;
  }
  return new CodexOwnedPilot(
    conversationId,
    options,
    acceptsNewSessions,
    env.CODECAST_RELAY_LIVENESS_PUBLISH === "1",
  );
}

export class CodexOwnedPilot {
  private readonly display = new CodexPilotDisplay();
  private readonly promptCards = new CodexPilotPromptCards();
  private readonly delivery = new CodexPilotDelivery(
    this.edgeResponse.bind(this),
    (message) => this.options.log(message),
  );
  private deliveryReady = false;
  private adapter?: ProviderAdapterClient;
  private session?: ProviderOwnedSession;
  private opening?: Promise<ProviderOwnedSession>;
  private eventWriter?: Promise<void>;
  private readonly events = new CodexPilotEvents(
    this.edge.bind(this),
    (message) => this.options.log(message),
  );
  private claim?: ClaimGrant;
  private claiming?: Promise<ClaimGrant>;
  private stopping = false;
  private resumeGeneration = 0;
  private activation?: Promise<void>;
  private closing?: Promise<void>;
  private renewal?: ReturnType<typeof setTimeout>;
  private renewalTask?: Promise<void>;
  private streamProgress = 0;
  private progressAtRenewal = 0;
  private consecutiveLivenessMisses = 0;
  private controller = new AbortController();
  private relay?: ReturnType<typeof startRelayLiveness>;
  private leaseDeadline = 0;
  private readonly children = new Map<string, CodexOwnedPilot>();
  private readonly parkedGenerations = new Map<string, number>();

  constructor(
    readonly conversationId: string | undefined,
    private readonly options: PilotOptions,
    readonly acceptsNewSessions = false,
    private readonly relayEnabled = false,
    private readonly epoch = 1,
    private readonly onClose?: (pilot: CodexOwnedPilot) => void,
  ) {}

  selects(conversationId: string, epoch = 1): boolean {
    return conversationId === this.conversationId && epoch === this.epoch;
  }

  get closed(): boolean {
    return this.stopping;
  }

  ownsThread(threadId: string): boolean {
    return (
      this.session?.getCheckpoint() === threadId ||
      [...this.children.values()].some((pilot) => pilot.ownsThread(threadId))
    );
  }

  pilotFor(request: EnsureBindingRequest): CodexOwnedPilot | undefined {
    const { conversationId, epoch, requestedAgent, transport } = request.target;
    const needsBaton = request.requiredCapabilities.includes(
      STEER_BATON_CAPABILITY,
    );
    if (!needsBaton && this.selects(conversationId, epoch)) return this;
    if (
      !this.acceptsNewSessions ||
      !needsBaton ||
      requestedAgent !== "codex" ||
      transport !== "app-server"
    )
      return;

    const key = JSON.stringify([conversationId, epoch]);
    let child = this.children.get(key);
    if (!child) {
      child = new CodexOwnedPilot(
        conversationId,
        this.options,
        false,
        this.relayEnabled,
        epoch,
        (closed) => {
          this.children.delete(key);
          this.parkedGenerations.set(key, closed.resumeGeneration);
        },
      );
      child.useReceiptJournal(this.delivery.receiptJournal);
      this.children.set(key, child);
    }
    return child;
  }

  async resumePilotFor(request: EnsureBindingRequest, generation = 0) {
    const { conversationId, epoch } = request.target;
    const key = JSON.stringify([conversationId, epoch]);
    const parked = this.parkedGenerations.get(key);
    if (parked !== undefined && generation <= parked) return;
    let pilot = this.pilotFor(request);
    if (!pilot || pilot === this) return pilot;
    if (pilot.closed) {
      if (generation <= pilot.resumeGeneration) return;
      await pilot.close();
      pilot = this.pilotFor(request);
      if (!pilot) return;
    }
    this.parkedGenerations.delete(key);
    pilot.resumeGeneration = Math.max(pilot.resumeGeneration, generation);
    return pilot;
  }

  private pilotOwning(binding: ReadyBinding): CodexOwnedPilot | undefined {
    const child = this.children.get(
      JSON.stringify([binding.conversationId, binding.epoch]),
    );
    if (child?.owns(binding)) return child;
    return this.owns(binding) ? this : undefined;
  }

  getProcessId(): number | undefined {
    return this.session?.getProcessId?.();
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
      capabilities: this.acceptsNewSessions
        ? [...legacy.capabilities, STEER_BATON_CAPABILITY]
        : legacy.capabilities,
      start: (request) =>
        this.pilotFor(request)?.start(request) ?? legacy.start(request),
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
        this.pilotOwning(binding)?.close() ?? legacy.stop(binding),
      quarantine: (binding, reason) =>
        this.pilotOwning(binding)?.close() ??
        legacy.quarantine(binding, reason),
    };
  }

  private open(spec: StartSpec | ResumeSpec): Promise<ProviderOwnedSession> {
    return (this.opening = this.openProvider(spec));
  }

  private async openProvider(
    spec: StartSpec | ResumeSpec,
  ): Promise<ProviderOwnedSession> {
    const { createProviderAdapter } =
      await import("@codecast/provider-adapter");
    this.controller.signal.throwIfAborted();
    this.adapter ??= createProviderAdapter({
      provider,
      command: this.options.command(),
      env: { ...process.env, PATH: agentSpawnPath(), [STABLE_ENV_MODE]: "off" },
      retainRaw: (frame) => {
        this.display.retain(frame);
        this.promptCards.retain(frame);
      },
      receiptJournal: this.delivery.receiptJournal,
      uniquePromptIds: true,
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
        options: await codexPilotSettings(
          this.options.instructions,
          request,
          permissions,
        ),
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

  private async claimAndRead(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    const previousClaim = this.claim;
    const started = performance.now();
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
      this.leaseDeadline = started + claim.lease_ms;
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
      if (
        this.controller.signal.aborted ||
        error instanceof CodexPilotLeaseLost
      )
        throw error;
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
      options: await codexPilotSettings(
        this.options.instructions,
        request,
        checkpoint,
      ),
      checkpoint: checkpoint.threadId,
      inDoubtDeliveryIds: pending ? [pending.delivery_id] : [],
    });
    this.events.prepare(claim);
    if (previous === 0) {
      const event: CanonicalEvent = {
        v,
        session: claim.session,
        run: claim.run,
        seq: 1,
        at: Date.now(),
        source: "provider",
        turn: null,
        kind: "session.started",
        body: { machine: binding.ownerDeviceId, provider: provider.agent },
      };
      await this.events.appendEvent(claim, event);
    }
    await this.events.startWatching();
    const session = this.session;
    const recovery =
      previous > 0 && this.options.bearer && session.getPendingPrompts
        ? this.promptCards.recover(
            claim.session,
            this.options.bearer,
            this.options.display.syncService,
            session.getPendingPrompts,
            this.controller.signal,
          )
        : Promise.resolve();
    this.eventWriter = recovery
      .then(() =>
        this.writeEvents(claim, session, binding, request.configuration.model),
      )
      .catch((error) => {
        this.options.log(
          `[owned-codex] event writer stopped: ${String(error)}`,
        );
      });
    void this.eventWriter.then(() => {
      void this.close().catch(() => {});
    });
    await recovery;
    this.controller.signal.throwIfAborted();
    this.deliveryReady = true;
    this.startRelayContact(claim, binding);
  }

  private startRelayContact(claim: ClaimGrant, binding: ReadyBinding): void {
    const { bearer, siteUrl, log } = this.options;
    if (!this.relayEnabled || !bearer) return;
    const { signal } = this.controller;
    const launchRelayPublisher = () => {
      void Promise.all([
        import("@codecast/edge-client"),
        import("@codecast/edge-client/relay-liveness"),
      ])
        .then(([{ createHttpEdgeTransport }, { startRelayLiveness }]) => {
          if (signal.aborted) return;
          this.relay = startRelayLiveness(
            {
              transport: createHttpEdgeTransport(
                new URL("/edge/v1/", siteUrl),
                {
                  Authorization: `Bearer ${bearer}`,
                },
              ),
              hello: {
                machine: binding.ownerDeviceId,
                boot: binding.daemonBootId,
                providers: [
                  { name: provider.agent, version: provider.version },
                ],
                runtimes: [{ host: "daemon", isolation: "app-server" }],
                capacity: {
                  memory_total_bytes: 0,
                  memory_available_bytes: 0,
                  live_agents: 1,
                },
              },
            },
            signal,
            [{ ...deliveryFence(claim), deadline: this.leaseDeadline }],
          );
          return this.relay.running;
        })
        .catch(() => {
          if (!signal.aborted) log("[owned-codex] relay liveness stopped");
        });
    };
    setImmediate(launchRelayPublisher).unref();
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
    try {
      return await this.delivery.drain(
        binding,
        coordinator,
        session,
        claim,
        prepareText,
        this.controller.signal,
        sendNew,
      );
    } catch (error) {
      if (error instanceof CodexPilotLeaseLost) await this.close();
      throw error;
    }
  }

  private async writeEvents(
    claim: ClaimGrant,
    session: ProviderOwnedSession,
    binding: ReadyBinding,
    model: string | undefined,
  ): Promise<void> {
    const { syncService, retryQueue, conversationCache, ...display } =
      this.options.display;
    const { conversationId, runtimeId } = binding;
    for await (const event of session.events) {
      this.streamProgress++;
      if (event.kind === "message.delta") continue;
      await this.events.appendEvent(
        claim,
        this.delivery.attributeTurnStart(event),
      );
      await this.delivery.observe(event, session, this.controller.signal);
      await this.promptCards
        .publish(event, claim, session, syncService, () => {
          display.sendAgentStatus(
            syncService,
            conversationId,
            runtimeId,
            "permission_blocked",
          );
        })
        .catch((error) =>
          this.options.log(
            `[owned-codex] prompt card update failed: ${String(error)}`,
          ),
        );
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

  private scheduleRenewal(claim: ClaimGrant, duration: number): void {
    if (this.controller.signal.aborted) return;
    this.renewal = setTimeout(() => {
      this.renewalTask = (async () => {
        const signal = this.controller.signal;
        const session = this.deliveryReady ? this.session : undefined;
        const progress = this.streamProgress;
        const responsive =
          progress !== this.progressAtRenewal ||
          !session?.checkLiveness ||
          (await session.checkLiveness(signal).catch(() => false));
        signal.throwIfAborted();
        if (responsive || progress !== this.streamProgress) {
          this.consecutiveLivenessMisses = 0;
        } else if (
          ++this.consecutiveLivenessMisses >= maxConsecutiveLivenessMisses
        ) {
          const { display } = this.options;
          if (session)
            display.sendAgentStatus(
              display.syncService,
              claim.session,
              session.getCheckpoint(),
              "stopped",
            );
          throw new Error("Owned Codex app-server stopped responding");
        }
        const started = performance.now();
        const result = await this.edge(
          "renew",
          { v, ...deliveryFence(claim) },
          parseRenewResponse,
          signal,
        );
        if (result.status !== "renewed")
          throw new Error("Owned Codex lease expired");
        this.leaseDeadline = started + result.lease_ms;
        this.relay?.update([
          { ...deliveryFence(claim), deadline: this.leaseDeadline },
        ]);
        this.progressAtRenewal = progress;
        this.scheduleRenewal(claim, result.lease_ms);
      })();
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
    if (this.stopping && this.closing) return this.closing;
    this.stopping = true;
    return (this.closing = (this.closing ?? this.closeOwned()).finally(() =>
      this.onClose?.(this),
    ));
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      this.close(),
      ...Array.from(this.children.values(), (pilot) => pilot.close()),
    ]);
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.renewal);
    await this.claiming?.catch(() => {});
    await this.renewalTask?.catch(() => {});
    const session =
      (await this.opening?.catch(() => undefined)) ?? this.session;
    this.session = undefined;
    this.opening = undefined;
    const outcome = await session?.close();
    await this.eventWriter;
    await this.events.close();
    if (this.conversationId) {
      await this.promptCards
        .closeAll(
          this.conversationId,
          Date.now(),
          this.options.display.syncService,
        )
        .catch((error) =>
          this.options.log(
            `[owned-codex] prompt card cleanup failed: ${String(error)}`,
          ),
        );
    }
    if (outcome && outcome.status !== "closed")
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
