import * as path from "node:path";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { randomUUID } from "node:crypto";
import {
  FENCED_EXECUTION_PROTOCOL_VERSION,
  FENCED_RUNTIME_CAPABILITIES,
  parseReadyBinding,
  type Delivery,
  type ReadyBinding,
  type RuntimeCapability,
} from "@codecast/agent-clients/executionBinding";
import {
  agentSupportsExecutionTransport,
  parseExecutionAgentClientId,
} from "@codecast/agent-clients/agentClients";
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
import { defaultConfigDir } from "../config/configDir.js";

export const FENCED_EXECUTION_FEATURE_FLAG =
  "CODECAST_FENCED_EXECUTION_V1" as const;

/** Explicitly off unless the single rollout bit is exactly `1`. */
export function fencedExecutionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[FENCED_EXECUTION_FEATURE_FLAG] === "1";
}

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
  if (!["tmux", "app-server", "external"].includes(transport)) {
    throw new TypeError(
      "Invalid execution work: unsupported transport spelling",
    );
  }
  if (!agentSupportsExecutionTransport(requestedAgent, transport as any)) {
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
      transport: transport as EnsureBindingRequest["target"]["transport"],
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

interface BindingWork {
  state: string;
  daemonBootMatch: boolean;
  request: EnsureBindingRequest;
  binding?: ReadyBinding;
}

interface ExecutionWorkItem {
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

function parseWork(value: unknown): ExecutionWorkItem[] {
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
  private workChain: Promise<void> = Promise.resolve();
  private readonly pilotPolls = new Map<
    string,
    {
      binding: ReadyBinding;
      pilot: CodexOwnedPilot;
      timer?: ReturnType<typeof setTimeout>;
      sendNew: boolean;
      awaitingSuccessor: boolean;
      resumeRequested: boolean;
      resumeGeneration: number;
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
    // Registration makes THIS boot the device's authorized recovery claimant:
    // the server only transfers a stranded binding to the registered current
    // boot, so it must happen before the recovery pass below.
    await this.controlPlane.registerBoot({
      ownerDeviceId: this.ownerDeviceId,
      daemonBootId: this.daemonBootId,
      ownedCodexNewSessions: this.handshake().ownedCodexNewSessions,
    });
    // Startup recovery is an actual read/process pass before reactive updates;
    // a WebSocket subscription alone can otherwise wait forever on unchanged
    // durable work left by the prior process.
    await this.processWorkUpdate(
      await this.controlPlane.listExecutionWork(this.handshake()),
    );
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
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const id of this.pilotPolls.keys()) this.stopPilotPoll(id);
    await this.codexOwnedPilot
      ?.closeAll()
      .catch((error) => this.onLog(String(error)));
  }

  processWorkUpdate(value: unknown): Promise<void> {
    const work = parseWork(value);
    const next = this.workChain.then(async () => {
      for (const item of work) {
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
      successorFromIntent = await this.coordinator.ensureBinding(
        intent.request,
      );
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

    const pilot =
      currentOwned && current
        ? await this.codexOwnedPilot?.resumePilotFor(
            current.request,
            item.resumeGeneration,
            item.nextDeliverySequence,
          )
        : undefined;
    if (current?.state === "ready" && pilot?.owns(current.binding)) {
      const { conversationId } = current.binding;
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
          awaitingSuccessor,
          sendNew,
          resumeRequested: false,
          resumeGeneration: generation,
        };
        this.pilotPolls.set(conversationId, poll);
      }
      poll.awaitingSuccessor = awaitingSuccessor;
      poll.sendNew = sendNew;
      if (generation > poll.resumeGeneration) {
        poll.resumeGeneration = generation;
        if (poll.leaseRetry) {
          clearTimeout(poll.timer);
          poll.timer = undefined;
          poll.leaseRetry = undefined;
        }
      }
      poll.resumeRequested ||= Boolean(item.resumeGeneration);
      if (poll.leaseRetry && poll.timer) return;
      let idle: boolean;
      try {
        await pilot.activate(current.binding, current.request);
        poll.leaseRetry = undefined;
        idle = await pilot.drain(
          current.binding,
          this.coordinator,
          (text) => this.prepareText(text),
          sendNew,
        );
      } catch (error) {
        if (poll.resumeRequested && error instanceof CodexPilotLeaseBusy) {
          if (
            poll.timer ||
            this.schedulePilotLeaseRetry(poll, current.request, error)
          )
            return;
          this.stopPilotPoll(conversationId);
          await this.failPilotLeaseRetry(pilot, current.binding, error);
          return;
        }
        this.stopPilotPoll(conversationId);
        throw error;
      }
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

  private stopPilotPoll(conversationId: string): void {
    clearTimeout(this.pilotPolls.get(conversationId)?.timer);
    this.pilotPolls.delete(conversationId);
  }

  private schedulePilotLeaseRetry(
    poll: NonNullable<ReturnType<typeof this.pilotPolls.get>>,
    request: EnsureBindingRequest,
    error: CodexPilotLeaseBusy,
  ): boolean {
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
    this.onLog(`[owned-codex] resume lease retry exhausted: ${String(error)}`);
    await pilot
      .failResume(
        binding,
        "Could not resume Codex session: the previous run still holds its lease.",
      )
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
    const { conversationId } = binding;
    const poll = this.pilotPolls.get(conversationId);
    if (poll?.binding !== binding) return;
    if (pilot.closed) {
      this.stopPilotPoll(conversationId);
      return;
    }
    poll.timer = setTimeout(() => {
      const next = this.workChain.then(async () => {
        if (this.pilotPolls.get(conversationId) !== poll) return;
        poll.timer = undefined;
        if (pilot.closed) {
          this.stopPilotPoll(conversationId);
          return;
        }
        await pilot.activate(binding, request);
        poll.leaseRetry = undefined;
        const idle = await pilot.drain(
          binding,
          this.coordinator,
          (text) => this.prepareText(text),
          poll.sendNew,
        );
        if (!idle) return;
        if (poll.awaitingSuccessor) {
          const work = parseWork(
            await this.controlPlane.listExecutionWork(this.handshake()),
          );
          const item = work.find(
            (item) => item.conversationId === conversationId,
          );
          if (item) return this.processItem(item);
        }
        this.stopPilotPoll(conversationId);
      });
      this.workChain = next.catch(async (error) => {
        if (this.pilotPolls.get(conversationId) !== poll) return;
        if (
          poll.resumeRequested &&
          error instanceof CodexPilotLeaseBusy &&
          this.schedulePilotLeaseRetry(poll, request, error)
        )
          return;
        this.stopPilotPoll(conversationId);
        if (poll.resumeRequested && error instanceof CodexPilotLeaseBusy) {
          await this.failPilotLeaseRetry(pilot, binding, error);
          return;
        }
        this.onLog(`[owned-codex] delivery poll failed: ${String(error)}`);
      });
      void this.workChain.then(() => {
        if (!poll.timer) this.schedulePilotPoll(pilot, binding, request);
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
