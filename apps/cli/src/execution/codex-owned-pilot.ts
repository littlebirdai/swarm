import {
  OWNED_CODEX_CHECKPOINT_PREFIX as handlePrefix,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import type { startRelayLiveness } from "@codecast/edge-client/relay-liveness";
import {
  EDGE_PROTOCOL_VERSION as v,
  STEER_BATON_CAPABILITY,
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
import { CodexPilotDisplay } from "./codex-pilot-display.js";
import {
  checkpointOf,
  codexPilotSettings,
  readOwnedCodexRelayFlags,
  startOwnedCodexRelayContact,
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
import {
  ParkedPilotRegistry,
  PilotErrorClearer,
  checkPilotRenewalLiveness,
  claimOwnedPilotRun,
  closeOwnedPilotSession,
  closePilots,
  createOwnedPilotDriver,
  openOwnedProvider,
  postOwnedEdgeResponse,
  reportPilotFailure,
  startOwnedPilotSession,
  writeOwnedPilotEvents,
  type ParkRecord,
} from "./codex-pilot-cleanup.js";
import type { ExecutionCoordinator } from "./coordinator.js";
import type { RuntimeDriver } from "./driver.js";
import type {
  EnsureBindingRequest,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "./types.js";

const provider = { agent: "codex", version: "0.153.4" } as const;
const maxConsecutiveLivenessMisses = 3;

export class CodexPilotLeaseBusy extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Owned Codex pilot could not claim the run: busy");
  }
}

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
    readOwnedCodexRelayFlags(env),
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
  private stopped = false;
  private resumeGeneration = 0;
  private deliverySequence = 0;
  private parkFailure?: { retryAfterMs?: number };
  private singleClaimOnly = false;
  private activation?: Promise<void>;
  private closing?: Promise<void>;
  private renewal?: ReturnType<typeof setTimeout>;
  private renewalTask?: Promise<void>;
  private readonly errorClearer: PilotErrorClearer;
  private streamProgress = 0;
  private progressAtRenewal = 0;
  private consecutiveLivenessMisses = 0;
  private controller = new AbortController();
  private relay?: ReturnType<typeof startRelayLiveness>;
  private leaseDeadline = 0;
  private readonly children = new Map<string, CodexOwnedPilot>();

  constructor(
    readonly conversationId: string | undefined,
    private readonly options: PilotOptions,
    readonly acceptsNewSessions = false,
    private readonly relayFlags = readOwnedCodexRelayFlags({}),
    private readonly epoch = 1,
    private readonly onClose?: (pilot: CodexOwnedPilot) => void,
    private readonly registry = new ParkedPilotRegistry(),
    private readonly isCurrent: () => boolean = () => true,
  ) {
    this.errorClearer = new PilotErrorClearer(this.options.display, (message) =>
      this.options.log(message),
    );
  }

  get singleClaimAttempt(): boolean {
    return this.singleClaimOnly;
  }

  markStopped(): void {
    this.stopped = true;
  }

  markParkFailure(retryAfterMs?: number): void {
    this.parkFailure = { retryAfterMs };
    if (!this.onClose && this.conversationId) {
      this.registry.parkFailure(
        this.conversationId,
        this.epoch,
        this.resumeGeneration,
        this.deliverySequence,
        retryAfterMs,
        Date.now(),
      );
    }
  }

  forgetConversation(conversationId: string): void {
    this.registry.forgetConversation(conversationId);
  }
  pruneParkedEpochs(conversationId: string, currentEpoch: number): void {
    this.registry.pruneOlderEpochs(conversationId, currentEpoch);
  }
  parkedRecord(conversationId: string, epoch: number): ParkRecord | undefined {
    return this.registry.get(conversationId, epoch);
  }
  parkedCount(): number {
    return this.registry.size;
  }
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

  private handlesRequest(request: EnsureBindingRequest): boolean {
    const { conversationId, epoch, requestedAgent, transport } = request.target;
    const needsBaton = request.requiredCapabilities.includes(
      STEER_BATON_CAPABILITY,
    );
    if (!needsBaton && this.selects(conversationId, epoch)) return true;
    return (
      this.acceptsNewSessions &&
      needsBaton &&
      requestedAgent === "codex" &&
      transport === "app-server"
    );
  }

  pilotFor(request: EnsureBindingRequest): CodexOwnedPilot | undefined {
    if (this.stopped || !this.handlesRequest(request)) return;
    const { conversationId, epoch } = request.target;
    if (
      !request.requiredCapabilities.includes(STEER_BATON_CAPABILITY) &&
      this.selects(conversationId, epoch)
    )
      return this;

    const key = JSON.stringify([conversationId, epoch]);
    let child = this.children.get(key);
    if (!child) {
      child = new CodexOwnedPilot(
        conversationId,
        this.options,
        false,
        this.relayFlags,
        epoch,
        (closed) => {
          this.children.delete(key);
          if (closed.parkFailure) {
            this.registry.parkFailure(
              conversationId,
              epoch,
              closed.resumeGeneration,
              closed.deliverySequence,
              closed.parkFailure.retryAfterMs,
              Date.now(),
            );
          } else {
            this.registry.parkClean(
              conversationId,
              epoch,
              closed.resumeGeneration,
              closed.deliverySequence,
            );
          }
        },
        this.registry,
        () => !this.stopped && this.children.get(key) === child,
      );
      child.useReceiptJournal(this.delivery.receiptJournal);
      this.children.set(key, child);
    }
    return child;
  }

  private wakePilot(
    pilot: CodexOwnedPilot,
    generation: number,
    deliverySequence: number,
    singleClaimAttempt?: boolean,
  ) {
    if (singleClaimAttempt !== undefined)
      pilot.singleClaimOnly = singleClaimAttempt;
    else if (generation > pilot.resumeGeneration) pilot.singleClaimOnly = false;
    pilot.resumeGeneration = Math.max(pilot.resumeGeneration, generation);
    pilot.deliverySequence = Math.max(pilot.deliverySequence, deliverySequence);
    return {
      kind: "wake" as const,
      pilot,
      singleClaimAttempt: pilot.singleClaimOnly,
    };
  }

  async resumePilotFor(
    request: EnsureBindingRequest,
    generation = 0,
    deliverySequence = 0,
  ): Promise<
    | { kind: "parked" }
    | { kind: "defer"; notBeforeMs: number }
    | { kind: "wake"; pilot: CodexOwnedPilot; singleClaimAttempt: boolean }
  > {
    if (this.stopped || !this.handlesRequest(request))
      return { kind: "parked" };
    const { conversationId, epoch } = request.target;
    const legacySelected =
      !request.requiredCapabilities.includes(STEER_BATON_CAPABILITY) &&
      this.selects(conversationId, epoch);
    if (legacySelected) {
      if (this.closed) return { kind: "parked" };
      if (this.deliveryReady)
        return this.wakePilot(this, generation, deliverySequence);
    } else {
      const existing = this.children.get(
        JSON.stringify([conversationId, epoch]),
      );
      if (existing) {
        if (!existing.closed)
          return this.wakePilot(existing, generation, deliverySequence);
        if (
          generation <= existing.resumeGeneration &&
          deliverySequence <= existing.deliverySequence
        )
          return { kind: "parked" };
        await existing.close();
        if (this.stopped) return { kind: "parked" };
      }
    }
    const decision = this.registry.wakeDecision(
      conversationId,
      epoch,
      generation,
      deliverySequence,
      Date.now(),
    );
    if (decision.kind !== "wake") return decision;
    const pilot = legacySelected ? this : this.pilotFor(request);
    if (!pilot) return { kind: "parked" };
    return this.wakePilot(
      pilot,
      generation,
      deliverySequence,
      decision.singleClaimAttempt,
    );
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

  getProcessIds(): number[] {
    const pid = this.session?.getProcessId?.();
    const children = [...this.children.values()].flatMap((p) =>
      p.getProcessIds(),
    );
    return pid === undefined ? children : [pid, ...children];
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
    return createOwnedPilotDriver(legacy, {
      acceptsNewSessions: this.acceptsNewSessions,
      ownsCheckpoint: ownsCodexCheckpoint,
      start: (request) => {
        if (!this.handlesRequest(request)) return;
        if (this.stopped)
          return Promise.resolve({
            state: "failed-before-effect",
            failure: {
              code: "OWNED_CODEX_STOPPED",
              message: "Owned Codex pilot is stopped",
              retryable: true,
            },
          });
        return this.pilotFor(request)?.start(request);
      },
      stop: (binding) => this.pilotOwning(binding)?.close(),
    });
  }

  private open(spec: StartSpec | ResumeSpec): Promise<ProviderOwnedSession> {
    return (this.opening = this.openProvider(spec));
  }

  private async openProvider(
    spec: StartSpec | ResumeSpec,
  ): Promise<ProviderOwnedSession> {
    const opened = await openOwnedProvider(
      this.adapter,
      {
        provider,
        command: this.options.command,
        retainRaw: (frame) => {
          this.display.retain(frame);
          this.promptCards.retain(frame);
        },
        receiptJournal: this.delivery.receiptJournal,
      },
      spec,
      this.controller.signal,
    );
    this.adapter = opened.adapter;
    return opened.session;
  }

  private async start(
    request: RuntimeStartRequest,
  ): Promise<RuntimeStartResult> {
    const started = await startOwnedPilotSession(
      this.options,
      request,
      (spec) => this.open(spec),
      () => this.close(),
    );
    if (started.session) this.session = started.session;
    return started.result;
  }

  private resetUnclaimed(): void {
    if (this.stopping) return;
    this.claiming = undefined;
    this.controller = new AbortController();
    this.activation = undefined;
  }

  activate(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    if (this.stopping || !this.owns(binding)) return Promise.resolve();
    return (this.activation ??= this.claimAndRead(binding, request).catch(
      async (error) => {
        if (this.claim || this.stopping) {
          if (!this.stopping) {
            this.markParkFailure(
              error instanceof CodexPilotLeaseBusy
                ? error.retryAfterMs
                : undefined,
            );
          }
          await this.close();
        } else {
          await this.cleanup();
          this.resetUnclaimed();
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

  private edgeResponse(
    operation: string,
    request: object,
    signal: AbortSignal,
  ): Promise<Response> {
    return postOwnedEdgeResponse(
      this.options.siteUrl,
      this.options.bearer,
      operation,
      request,
      signal,
    );
  }

  private async claimAndRead(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    const previousClaim = this.claim;
    const started = performance.now();
    this.claiming ??= claimOwnedPilotRun(
      binding,
      (op, req, parse) => this.edge(op, req, parse),
      (retryAfterMs) => new CodexPilotLeaseBusy(retryAfterMs),
    ).then((claim) => {
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
    await recovery;
    this.controller.signal.throwIfAborted();
    await this.errorClearer.clear(
      claim.session,
      this.controller.signal,
      () => !this.stopping && this.isCurrent(),
    );
    this.controller.signal.throwIfAborted();
    this.eventWriter = this.writeEvents(
      claim,
      session,
      binding,
      request.configuration.model,
    ).catch((error) => {
      this.options.log(`[owned-codex] event writer stopped: ${String(error)}`);
    });
    void this.eventWriter.then(() => {
      void this.close().catch(() => {});
    });
    this.deliveryReady = true;
    this.registry.clear(claim.session, claim.run);
    this.startRelayContact(claim, binding);
  }

  private startRelayContact(claim: ClaimGrant, binding: ReadyBinding): void {
    startOwnedCodexRelayContact(
      this.options,
      provider,
      claim,
      binding,
      this.controller.signal,
      () => this.leaseDeadline,
      (relay) => (this.relay = relay),
      this.relayFlags,
    );
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

  private writeEvents(
    claim: ClaimGrant,
    session: ProviderOwnedSession,
    binding: ReadyBinding,
    model: string | undefined,
  ): Promise<void> {
    return writeOwnedPilotEvents({
      claim,
      session,
      binding,
      model,
      signal: this.controller.signal,
      options: this.options,
      events: this.events,
      delivery: this.delivery,
      promptCards: this.promptCards,
      display: this.display,
      publishDelta: this.relayFlags.tokenDeltas
        ? () => this.relay?.publishDelta
        : undefined,
      onProgress: () => (this.streamProgress += 1),
    });
  }

  private scheduleRenewal(claim: ClaimGrant, duration: number): void {
    if (this.controller.signal.aborted) return;
    this.renewal = setTimeout(() => {
      this.renewalTask = (async () => {
        const signal = this.controller.signal;
        const progress = this.streamProgress;
        this.consecutiveLivenessMisses = await checkPilotRenewalLiveness({
          signal,
          session: this.deliveryReady ? this.session : undefined,
          streamProgress: progress,
          progressAtRenewal: this.progressAtRenewal,
          consecutiveMisses: this.consecutiveLivenessMisses,
          maxConsecutiveMisses: maxConsecutiveLivenessMisses,
          sessionId: claim.session,
          display: this.options.display,
          currentProgress: () => this.streamProgress,
        });
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
        if (!this.deliveryReady && !this.stopping) this.markParkFailure();
        void this.close().catch(() => {});
      });
    }, duration / 2);
    this.renewal.unref();
  }

  async failResume(
    binding: ReadyBinding,
    message: string,
    retryAfterMs?: number,
    onReport?: () => void,
  ): Promise<void> {
    this.markParkFailure(retryAfterMs);
    onReport?.();
    await reportPilotFailure(
      this.options.display,
      this.options.log,
      binding,
      message,
    );
    if (!this.onClose && !this.claim) {
      await this.cleanup();
      this.resetUnclaimed();
      return;
    }
    await this.close();
  }

  close(): Promise<void> {
    this.stopping = true;
    return this.cleanup();
  }

  private cleanup(): Promise<void> {
    return (this.closing ??= this.closeOwned().then(
      () => {
        if (this.stopping) this.onClose?.(this);
        else this.closing = undefined;
      },
      (error) => {
        this.closing = undefined;
        throw error;
      },
    ));
  }

  async closeAll(): Promise<void> {
    this.markStopped();
    await closePilots([this, ...this.children.values()]);
    this.registry.clearAll();
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.renewal);
    this.errorClearer.cancel();
    await this.claiming?.catch(() => {});
    await this.renewalTask?.catch(() => {});
    const session =
      (await this.opening?.catch(() => undefined)) ?? this.session;
    this.opening = undefined;
    const claim = this.claim;
    const { disposed, stopped } = await closeOwnedPilotSession({
      log: this.options.log,
      session,
      adapter: this.adapter,
      eventWriter: this.eventWriter,
      events: this.events,
      conversationId: this.conversationId,
      promptCards: this.promptCards,
      syncService: this.options.display.syncService,
      delivery: this.delivery,
      releaseLease: claim
        ? () =>
            this.edge(
              "release",
              { v, ...deliveryFence(claim) },
              parseReleaseResponse,
              AbortSignal.timeout(10_000),
            )
        : undefined,
    });
    if (disposed) this.adapter = undefined;
    if (!stopped) {
      this.session = session;
      this.stopping = true;
      throw new Error("Owned Codex cleanup could not be confirmed");
    }
    this.session = undefined;
    this.adapter = undefined;
  }
}
