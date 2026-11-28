import * as path from "node:path";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { randomUUID } from "node:crypto";
import {
  FENCED_EXECUTION_PROTOCOL_VERSION,
  FENCED_RUNTIME_CAPABILITIES,
  type Delivery,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import { ConvexExecutionControlPlane } from "./convexControlPlane.js";
import { ExecutionCoordinator } from "./coordinator.js";
import { RuntimeDriverRegistry, type RuntimeDriver } from "./driver.js";
import {
  FileExecutionOperationJournal,
  type ExecutionOperationJournal,
} from "./local-journal.js";
import type { EnsureBindingRequest } from "./types.js";
import {
  materializeFileTags,
  type AttachedFileRef,
} from "@codecast/daemon/fileAttachment";
import type { ExecutionConvexTransport } from "./convexControlPlane.js";
import {
  CodexPilotLeaseBusy,
  ownsCodexCheckpoint,
  type CodexOwnedPilot,
} from "./codex-owned-pilot.js";
import { PILOT_RESUME_BUSY_ERROR } from "./codex-pilot-cleanup.js";
import { defaultConfigDir } from "../config/configDir.js";
import { parseWork, type ExecutionWorkItem } from "./work-feed-parser.js";

/**
 * Legacy delivery's fail-closed choke. A fenced envelope reaching this point is
 * a programming error; it must never be handed to claimPendingMessageForDelivery,
 * deliverMessage, direct tmux injection, or a fallback transport.
 */
export function assertLegacyDeliveryEnvelope(
  message: Record<string, unknown>,
): void {
  if (
    message.delivery_protocol_version !== undefined ||
    message.delivery_id !== undefined ||
    message.conversation_sequence !== undefined ||
    message.execution_epoch !== undefined ||
    message.delivery_status !== undefined ||
    message.active_delivery_attempt_id !== undefined
  ) {
    throw new Error("FENCED_MESSAGE_ON_LEGACY_DELIVERY_RAIL");
  }
}

export interface DaemonExecutionRuntimeOptions {
  transport: ExecutionConvexTransport;
  ownerDeviceId: string;
  codexOwnedPilot?: CodexOwnedPilot;
  drivers: RuntimeDriverRegistry | readonly RuntimeDriver[];
  journal?: ExecutionOperationJournal;
  journalDirectory?: string;
  daemonBootId?: string;
  resolveImage?: (storageId: string) => Promise<string | null>;
  /** Saves a file attached in the web composer and returns its local path. */
  resolveFile?: (ref: AttachedFileRef) => Promise<string | null>;
  onLog?: (message: string) => void;
}

const maxPilotLeaseRetries = 8;
const maxPilotLeaseRetryDelayMs = 30_000;

export class DaemonExecutionRuntime {
  readonly daemonBootId: string;
  readonly controlPlane: ConvexExecutionControlPlane;
  readonly coordinator: ExecutionCoordinator;
  readonly drivers: RuntimeDriverRegistry;
  private readonly ownerDeviceId: string;
  private readonly codexOwnedPilot?: CodexOwnedPilot;
  private readonly resolveImage?: DaemonExecutionRuntimeOptions["resolveImage"];
  private readonly resolveFile?: DaemonExecutionRuntimeOptions["resolveFile"];
  private readonly onLog: (message: string) => void;
  private unsubscribe?: () => void;
  private stopped = false;
  private workChain: Promise<void> = Promise.resolve();
  private readonly deferredWakes = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      notBeforeMs: number;
      item: ExecutionWorkItem;
    }
  >();
  private readonly pilotPolls = new Map<
    string,
    {
      binding: ReadyBinding;
      pilot: CodexOwnedPilot;
      timer?: ReturnType<typeof setTimeout>;
      timerToken: number;
      sendNew: boolean;
      awaitingSuccessor: boolean;
      resumeRequested: boolean;
      resumeGeneration: number;
      singleClaimAttempt: boolean;
      leaseRetry?: { attempts: number; delayMs: number };
    }
  >();

  constructor(options: DaemonExecutionRuntimeOptions) {
    this.daemonBootId = options.daemonBootId ?? randomUUID();
    this.ownerDeviceId = options.ownerDeviceId;
    this.codexOwnedPilot = options.codexOwnedPilot;
    this.resolveImage = options.resolveImage;
    this.resolveFile = options.resolveFile;
    this.onLog = options.onLog ?? (() => {});
    this.controlPlane = new ConvexExecutionControlPlane(options.transport);
    this.drivers =
      options.drivers instanceof RuntimeDriverRegistry
        ? options.drivers
        : new RuntimeDriverRegistry(options.drivers);
    const journal =
      options.journal ??
      new FileExecutionOperationJournal(
        options.journalDirectory ??
          path.join(defaultConfigDir(), "execution-journal"),
      );
    this.codexOwnedPilot?.useReceiptJournal(journal.deliveryReceipts);
    this.coordinator = new ExecutionCoordinator({
      controlPlane: this.controlPlane,
      drivers: this.drivers,
      journal,
    });
  }

  private handshake() {
    return {
      ownerDeviceId: this.ownerDeviceId,
      daemonBootId: this.daemonBootId,
      protocolVersion: FENCED_EXECUTION_PROTOCOL_VERSION,
      capabilities: [...FENCED_RUNTIME_CAPABILITIES],
      ownedCodexConversationId: this.codexOwnedPilot?.conversationId,
      ownedCodexNewSessions:
        this.codexOwnedPilot?.acceptsNewSessions &&
        this.drivers.supports("codex", "app-server", STEER_BATON_CAPABILITY),
    };
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    // Registration makes THIS boot the device's authorized recovery claimant:
    // the server only transfers a stranded binding to the registered current
    // boot, so it must happen before the recovery pass below.
    await this.controlPlane.registerBoot({
      ownerDeviceId: this.ownerDeviceId,
      daemonBootId: this.daemonBootId,
      ownedCodexNewSessions: this.handshake().ownedCodexNewSessions,
    });
    if (this.stopped) return;
    // Startup recovery is an actual read/process pass before reactive updates;
    // a WebSocket subscription alone can otherwise wait forever on unchanged
    // durable work left by the prior process.
    await this.processWorkUpdate(
      await this.controlPlane.listExecutionWork(this.handshake()),
    );
    if (this.stopped) return;
    this.unsubscribe = this.controlPlane.subscribeExecutionWork(
      this.handshake(),
      (value) => {
        void this.processWorkUpdate(value).catch((error) => {
          this.onLog(
            `[fenced-execution] work update failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.codexOwnedPilot?.markStopped();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearAllTimers();
    await this.workChain;
    this.clearAllTimers();
    await this.codexOwnedPilot
      ?.closeAll()
      .catch((error) => this.onLog(String(error)));
  }

  forgetConversation(conversationId: string): void {
    this.stopPilotPoll(conversationId);
    this.codexOwnedPilot?.forgetConversation(conversationId);
  }

  private clearAllTimers(): void {
    for (const id of [...this.pilotPolls.keys()]) this.stopPilotPoll(id);
    for (const id of [...this.deferredWakes.keys()])
      this.cancelDeferredWake(id);
  }

  processWorkUpdate(value: unknown): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const work = parseWork(value);
    const next = this.workChain.then(async () => {
      for (const item of work) {
        if (this.stopped) return;
        try {
          await this.processItem(item);
        } catch (error) {
          const isPilotWork =
            this.codexOwnedPilot?.selects(item.conversationId) ||
            item.bindings.some(
              ({ binding, request }) =>
                request.requiredCapabilities.includes(STEER_BATON_CAPABILITY) ||
                (binding && ownsCodexCheckpoint(binding.handle)),
            );
          if (!isPilotWork) throw error;
          this.onLog(
            `[owned-codex] work failed for ${item.conversationId}: ${String(error)}`,
          );
        }
      }
    });
    this.workChain = next.catch(() => {});
    return next;
  }

  private async processItem(item: ExecutionWorkItem): Promise<void> {
    if (this.stopped) return;
    this.codexOwnedPilot?.pruneParkedEpochs(
      item.conversationId,
      item.currentEpoch,
    );
    const deferred = this.deferredWakes.get(item.conversationId);
    if (deferred && deferred.item.currentEpoch < item.currentEpoch) {
      this.cancelDeferredWake(item.conversationId);
    }
    let successorFromIntent: ReadyBinding | undefined;
    if (item.pendingIntent) {
      const intent = item.pendingIntent;
      if (intent.request.daemonBootId !== this.daemonBootId) {
        throw new Error("FENCED_INTENT_BOOT_HANDSHAKE_MISMATCH");
      }
      await this.controlPlane.requestSuccessor({
        conversationId: item.conversationId,
        intentId: intent.intentId,
        expectedCurrentEpoch: intent.expectedCurrentEpoch,
        policy: intent.policy,
        request: intent.request,
      });
      if (this.stopped) return;
      successorFromIntent = await this.coordinator.ensureBinding(
        intent.request,
      );
      if (this.stopped) return;
    }

    const ready = new Map<
      number,
      {
        binding: ReadyBinding;
        request: EnsureBindingRequest;
        state: "ready" | "stopped" | "quarantined";
      }
    >();
    for (const work of item.bindings) {
      if (this.stopped) return;
      if (
        (work.state === "stopped" || work.state === "quarantined") &&
        work.binding
      ) {
        // A disposition is durable evidence, not live effect authority. Keep it
        // even across a daemon-boot boundary so recovery can finish the atomic
        // successor activation that may have been interrupted after stop.
        ready.set(work.binding.epoch, {
          binding: work.binding,
          request: work.request,
          state: work.state,
        });
        continue;
      }
      if (["stopped", "quarantined", "start-ambiguous"].includes(work.state))
        continue;
      // A boot mismatch is a binding stranded by a terminated daemon boot on
      // this same device (the daemon is a per-device singleton). Present OUR
      // boot id: the server transfers the binding and returns the recovery
      // proof the coordinator's journal-driven adopt/quarantine path requires.
      // Skipping instead would orphan the conversation until epoch turnover.
      const request = work.daemonBootMatch
        ? work.request
        : { ...work.request, daemonBootId: this.daemonBootId };
      if (!work.daemonBootMatch) {
        this.onLog(
          `[fenced-execution] recovering ${item.conversationId} epoch ${work.request.target.epoch} from terminated daemon boot`,
        );
      }
      const binding = await this.coordinator.ensureBinding(request);
      if (this.stopped) return;
      ready.set(binding.epoch, { binding, request, state: "ready" });
    }
    if (successorFromIntent && item.pendingIntent) {
      ready.set(successorFromIntent.epoch, {
        binding: successorFromIntent,
        request: item.pendingIntent.request,
        state: "ready",
      });
    }

    const current = ready.get(item.currentEpoch);
    const currentOwned =
      current?.binding.actualAgent === "codex" &&
      current.binding.transport === "app-server" &&
      ownsCodexCheckpoint(current.binding.handle);
    const pendingEpoch =
      item.pendingEpoch ?? item.pendingIntent?.request.target.epoch;
    const successor =
      pendingEpoch === undefined ? undefined : ready.get(pendingEpoch);
    const policy = item.pendingPolicy ?? item.pendingIntent?.policy;

    if (current?.state !== "ready") {
      this.stopPilotPoll(item.conversationId);
      if (!(current && successor && policy)) {
        this.codexOwnedPilot?.forgetConversation(item.conversationId);
      }
    }

    const wake =
      currentOwned && current?.state === "ready"
        ? await this.codexOwnedPilot?.resumePilotFor(
            current.request,
            item.resumeGeneration,
            item.nextDeliverySequence,
          )
        : undefined;
    if (this.stopped) return;
    if (wake?.kind === "defer") {
      this.scheduleDeferredWake(item, wake.notBeforeMs);
    }
    const pilot = wake?.kind === "wake" ? wake.pilot : undefined;
    if (current?.state === "ready" && pilot?.owns(current.binding)) {
      const { conversationId } = current.binding;
      this.cancelDeferredWake(conversationId);
      const awaitingSuccessor = Boolean(successor && policy);
      const sendNew = !awaitingSuccessor || policy === "drain-current";
      const generation = item.resumeGeneration ?? 0;
      let poll = this.pilotPolls.get(conversationId);
      if (
        poll?.pilot !== pilot ||
        poll.binding.epoch !== current.binding.epoch
      ) {
        this.stopPilotPoll(conversationId);
        poll = {
          binding: current.binding,
          pilot,
          timerToken: 0,
          awaitingSuccessor,
          sendNew,
          resumeRequested: false,
          resumeGeneration: generation,
          singleClaimAttempt: pilot.singleClaimAttempt,
        };
        this.pilotPolls.set(conversationId, poll);
      }
      poll.awaitingSuccessor = awaitingSuccessor;
      poll.sendNew = sendNew;
      poll.singleClaimAttempt = pilot.singleClaimAttempt;
      if (generation > poll.resumeGeneration) {
        poll.resumeGeneration = generation;
        if (poll.leaseRetry) {
          this.clearPilotPollTimer(poll);
          poll.leaseRetry = undefined;
        }
      }
      poll.resumeRequested ||= Boolean(item.resumeGeneration);
      if (poll.leaseRetry && poll.timer) return;
      let idle: boolean;
      let activated = false;
      try {
        await pilot.activate(current.binding, current.request);
        activated = true;
        poll.leaseRetry = undefined;
        if (this.stopped) return;
        idle = await pilot.drain(
          current.binding,
          this.coordinator,
          (text) => this.prepareText(text),
          sendNew,
        );
      } catch (error) {
        if (poll.resumeRequested && error instanceof CodexPilotLeaseBusy) {
          if (
            !poll.singleClaimAttempt &&
            (poll.timer ||
              this.schedulePilotLeaseRetry(poll, current.request, error))
          )
            return;
          this.stopPilotPoll(conversationId);
          if (poll.singleClaimAttempt) {
            pilot.markParkFailure(error.retryAfterMs);
            if (pilot !== this.codexOwnedPilot)
              await pilot.close().catch(() => {});
          } else {
            await this.failPilotLeaseRetry(pilot, current.binding, error);
          }
          return;
        }
        this.stopPilotPoll(conversationId);
        if (!activated && !pilot.closed) {
          pilot.markParkFailure(
            error instanceof CodexPilotLeaseBusy
              ? error.retryAfterMs
              : undefined,
          );
          if (pilot !== this.codexOwnedPilot) {
            await pilot.close().catch(() => {});
          }
        }
        throw error;
      }
      if (this.stopped) return;
      if (idle || pilot.closed) this.stopPilotPoll(conversationId);
      else if (!poll.timer)
        this.schedulePilotPoll(pilot, poll.binding, current.request);
      if (!awaitingSuccessor || !idle) return;
    }

    if (current && successor && policy) {
      if (currentOwned) this.stopPilotPoll(current.binding.conversationId);
      if (current.state === "ready") {
        if (policy === "drain-current" && !currentOwned)
          await this.drain(current.binding, current.request);
        const driver = this.drivers.resolve(
          current.binding.actualAgent,
          current.binding.transport,
        );
        await driver.stop(current.binding);
        const disposition = await this.controlPlane.publishRuntimeDisposition(
          current.binding,
          "stopped",
          `successor epoch ${successor.binding.epoch} ready`,
        );
        if (!disposition.accepted) throw new Error("STALE_RUNTIME_DISPOSITION");
      }
      for (let batch = 0; batch < 1024; batch += 1) {
        const activation = await this.controlPlane.activateSuccessor({
          current: current.binding,
          successor: successor.binding,
        });
        if (activation.activated) break;
        if (!activation.remainingCancellations) {
          throw new Error("SUCCESSOR_ACTIVATION_STALLED");
        }
        if (batch === 1023) throw new Error("SUCCESSOR_ACTIVATION_BATCH_LIMIT");
      }
      this.codexOwnedPilot?.pruneParkedEpochs(
        item.conversationId,
        successor.binding.epoch,
      );
      const staleDeferred = this.deferredWakes.get(item.conversationId);
      if (
        staleDeferred &&
        staleDeferred.item.currentEpoch < successor.binding.epoch
      ) {
        this.cancelDeferredWake(item.conversationId);
      }
      if (
        successor.state === "ready" &&
        !ownsCodexCheckpoint(successor.binding.handle)
      ) {
        await this.drain(successor.binding, successor.request);
      }
      return;
    }
    if (current?.state !== "ready") return;
    if (currentOwned) return;
    await this.drain(current.binding, current.request);
  }

  private cancelDeferredWake(conversationId: string): void {
    const wake = this.deferredWakes.get(conversationId);
    if (!wake) return;
    clearTimeout(wake.timer);
    this.deferredWakes.delete(conversationId);
  }

  private scheduleDeferredWake(
    item: ExecutionWorkItem,
    notBeforeMs: number,
  ): void {
    if (this.stopped) return;
    const existing = this.deferredWakes.get(item.conversationId);
    if (existing) {
      existing.item = item;
      if (existing.notBeforeMs === notBeforeMs) return;
      clearTimeout(existing.timer);
      this.deferredWakes.delete(item.conversationId);
    }
    const delayMs = Math.max(0, notBeforeMs - Date.now());
    const entry = {
      notBeforeMs,
      item,
      timer: setTimeout(() => {
        if (this.stopped) return;
        if (this.deferredWakes.get(item.conversationId) !== entry) return;
        this.deferredWakes.delete(item.conversationId);
        const next = this.workChain.then(async () => {
          if (this.stopped) return;
          try {
            await this.processItem(entry.item);
          } catch (error) {
            this.onLog(
              `[owned-codex] work failed for ${entry.item.conversationId}: ${String(error)}`,
            );
          }
        });
        this.workChain = next.catch(() => {});
      }, delayMs),
    };
    entry.timer.unref();
    this.deferredWakes.set(item.conversationId, entry);
  }

  private clearPilotPollTimer(
    poll: NonNullable<ReturnType<typeof this.pilotPolls.get>>,
  ): void {
    clearTimeout(poll.timer);
    poll.timer = undefined;
    poll.timerToken += 1;
  }

  private stopPilotPoll(conversationId: string): void {
    const poll = this.pilotPolls.get(conversationId);
    if (poll) this.clearPilotPollTimer(poll);
    this.pilotPolls.delete(conversationId);
    this.cancelDeferredWake(conversationId);
  }

  private schedulePilotLeaseRetry(
    poll: NonNullable<ReturnType<typeof this.pilotPolls.get>>,
    request: EnsureBindingRequest,
    error: CodexPilotLeaseBusy,
  ): boolean {
    if (this.stopped) return false;
    const attempts = (poll.leaseRetry?.attempts ?? 0) + 1;
    if (attempts > maxPilotLeaseRetries) return false;
    const delayMs = Math.min(
      maxPilotLeaseRetryDelayMs,
      Math.max(
        error.retryAfterMs,
        poll.leaseRetry ? poll.leaseRetry.delayMs * 2 : 250,
      ),
    );
    poll.leaseRetry = { attempts, delayMs };
    this.schedulePilotPoll(poll.pilot, poll.binding, request, delayMs);
    return true;
  }

  private async failPilotLeaseRetry(
    pilot: CodexOwnedPilot,
    binding: ReadyBinding,
    error: CodexPilotLeaseBusy,
  ): Promise<void> {
    await pilot
      .failResume(binding, PILOT_RESUME_BUSY_ERROR, error.retryAfterMs, () => {
        this.onLog(
          `[owned-codex] resume lease retry exhausted: ${String(error)}`,
        );
      })
      .catch((closeError) => {
        this.onLog(
          `[owned-codex] exhausted resume cleanup failed: ${String(closeError)}`,
        );
      });
  }

  private schedulePilotPoll(
    pilot: CodexOwnedPilot,
    binding: ReadyBinding,
    request: EnsureBindingRequest,
    delay = 2_000,
  ): void {
    if (this.stopped) return;
    const { conversationId } = binding;
    const poll = this.pilotPolls.get(conversationId);
    if (poll?.binding !== binding) return;
    if (pilot.closed) {
      this.stopPilotPoll(conversationId);
      return;
    }
    this.clearPilotPollTimer(poll);
    const token = poll.timerToken;
    poll.timer = setTimeout(() => {
      if (
        this.stopped ||
        this.pilotPolls.get(conversationId) !== poll ||
        poll.timerToken !== token
      )
        return;
      let entered = false;
      let activated = false;
      const next = this.workChain.then(async () => {
        if (
          this.stopped ||
          this.pilotPolls.get(conversationId) !== poll ||
          poll.timerToken !== token
        )
          return;
        entered = true;
        poll.timer = undefined;
        if (pilot.closed) {
          this.stopPilotPoll(conversationId);
          return;
        }
        await pilot.activate(binding, request);
        activated = true;
        poll.leaseRetry = undefined;
        if (this.stopped) return;
        const idle = await pilot.drain(
          binding,
          this.coordinator,
          (text) => this.prepareText(text),
          poll.sendNew,
        );
        if (!idle || this.stopped) return;
        if (poll.awaitingSuccessor) {
          const work = parseWork(
            await this.controlPlane.listExecutionWork(this.handshake()),
          );
          if (this.stopped) return;
          const item = work.find(
            (item) => item.conversationId === conversationId,
          );
          if (item) return this.processItem(item);
        }
        this.stopPilotPoll(conversationId);
      });
      this.workChain = next.catch(async (error) => {
        if (!entered) return;
        const activePoll =
          !this.stopped &&
          this.pilotPolls.get(conversationId) === poll &&
          poll.timerToken === token;
        if (!activePoll) {
          this.onLog(`[owned-codex] delivery poll failed: ${String(error)}`);
          return;
        }
        if (
          poll.resumeRequested &&
          error instanceof CodexPilotLeaseBusy &&
          !poll.singleClaimAttempt &&
          this.schedulePilotLeaseRetry(poll, request, error)
        )
          return;
        this.stopPilotPoll(conversationId);
        if (poll.resumeRequested && error instanceof CodexPilotLeaseBusy) {
          if (poll.singleClaimAttempt) {
            pilot.markParkFailure(error.retryAfterMs);
            if (pilot !== this.codexOwnedPilot)
              await pilot.close().catch(() => {});
          } else {
            await this.failPilotLeaseRetry(pilot, binding, error);
          }
          return;
        }
        if (!activated && !pilot.closed) {
          pilot.markParkFailure(
            error instanceof CodexPilotLeaseBusy
              ? error.retryAfterMs
              : undefined,
          );
          if (pilot !== this.codexOwnedPilot) {
            await pilot.close().catch(() => {});
          }
        }
        this.onLog(`[owned-codex] delivery poll failed: ${String(error)}`);
      });
      void this.workChain.then(() => {
        if (
          !this.stopped &&
          this.pilotPolls.get(conversationId) === poll &&
          poll.timerToken === token &&
          !poll.timer
        )
          this.schedulePilotPoll(pilot, binding, request);
      });
    }, delay);
    poll.timer.unref();
  }

  private async prepareText(text: string): Promise<string> {
    return this.resolveFile
      ? materializeFileTags(text, this.resolveFile)
      : text;
  }

  private async drain(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    for (let index = 0; index < 1024; index += 1) {
      const claim = await this.controlPlane.claimNextDelivery(binding);
      if (!("permit" in claim)) return;
      const input: Array<Delivery["input"][number]> = [];
      try {
        const text = await this.prepareText(claim.delivery.content);
        input.push({ type: "text", text });
        for (const storageId of claim.delivery.imageStorageIds) {
          if (!this.resolveImage)
            throw new Error("fenced image resolver is unavailable");
          const localPath = await this.resolveImage(storageId);
          if (!localPath)
            throw new Error(`could not resolve fenced image ${storageId}`);
          input.push({ type: "local-image", path: localPath });
        }
      } catch (error) {
        await this.controlPlane.releaseClaimBeforeEffect(
          claim.permit,
          "input preparation failed before delivery/start",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const permit = await this.controlPlane.startDelivery(claim.permit);
      const outcome = await this.coordinator.deliver({
        binding: request,
        permit,
        delivery: {
          messageId: claim.delivery.messageId,
          deliveryId: claim.delivery.deliveryId,
          conversationSequence: claim.delivery.conversationSequence,
          input,
        },
      });
      if (outcome.state !== "delivered") return;
    }
    throw new Error("FENCED_DELIVERY_DRAIN_LIMIT");
  }
}

let processRuntime: DaemonExecutionRuntime | null = null;

/** Exactly one coordinator, driver registry, journal and daemon boot per process. */
export function getProcessExecutionRuntime(
  options: DaemonExecutionRuntimeOptions,
): DaemonExecutionRuntime {
  processRuntime ??= new DaemonExecutionRuntime(options);
  return processRuntime;
}

export function forgetProcessExecutionConversation(
  conversationId: string,
): void {
  processRuntime?.forgetConversation(conversationId);
}
