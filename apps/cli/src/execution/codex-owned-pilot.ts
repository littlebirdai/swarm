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
import type { OwnedSession, StartSpec } from "@codecast/provider-contract";
import { STABLE_ENV_MODE } from "@codecast/snippets/stableContext";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { withWorktreeConfig } from "../worktreeEnv.js";
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
  instructions: (request: EnsureBindingRequest) => Promise<string | undefined>;
  log: (message: string) => void;
};

export function createCodexOwnedPilot(
  options: PilotOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexOwnedPilot | undefined {
  const conversationId = env.CODECAST_CODEX_OWNED_PILOT_SESSION?.trim();
  if (env.CODECAST_FENCED_EXECUTION_V1 !== "1" || !conversationId) return;
  if (!options.bearer)
    throw new Error("Owned Codex pilot requires daemon auth");
  return new CodexOwnedPilot(conversationId, options);
}

export class CodexOwnedPilot {
  private adapter?: ProviderAdapterClient;
  private session?: OwnedSession;
  private opening?: Promise<OwnedSession>;
  private claim?: ClaimGrant;
  private activation?: Promise<void>;
  private closing?: Promise<void>;
  private renewal?: ReturnType<typeof setTimeout>;
  private renewalTask?: Promise<void>;
  private controller = new AbortController();

  constructor(
    private readonly conversationId: string,
    private readonly options: PilotOptions,
  ) {}

  register(legacy: RuntimeDriver): RuntimeDriver {
    return {
      id: "codex-app-server-with-owned-pilot-v1",
      transport: legacy.transport,
      supportedAgents: legacy.supportedAgents,
      capabilities: legacy.capabilities,
      start: (request) =>
        request.target.conversationId === this.conversationId &&
        request.target.epoch === 1
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
        ownsCodexCheckpoint(binding.handle)
          ? this.close()
          : legacy.stop(binding),
      quarantine: (binding, reason) =>
        ownsCodexCheckpoint(binding.handle)
          ? this.close()
          : legacy.quarantine(binding, reason),
    };
  }

  private async settings(
    request: EnsureBindingRequest,
    permissions: Permissions,
  ): Promise<EdgeJson> {
    const { sandbox, approvalPolicy } = permissions;
    const developerInstructions = await this.options.instructions(request);
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

  private open(spec: StartSpec, checkpoint?: string): Promise<OwnedSession> {
    return (this.opening = this.openProvider(spec, checkpoint));
  }

  private async openProvider(
    spec: StartSpec,
    checkpoint?: string,
  ): Promise<OwnedSession> {
    const { createProviderAdapter } =
      await import("@codecast/provider-adapter");
    this.adapter ??= createProviderAdapter({
      provider,
      command: this.options.command(),
      env: { ...process.env, PATH: agentSpawnPath(), [STABLE_ENV_MODE]: "off" },
      retainRaw: () => {},
    });
    const result = checkpoint
      ? await this.adapter.resume(
          { ...spec, checkpoint },
          this.controller.signal,
        )
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
    if (binding.conversationId !== this.conversationId || binding.epoch !== 1)
      return Promise.reject(
        new Error("Owned Codex binding does not match the pilot session"),
      );
    return (this.activation ??= this.claimAndRead(binding, request).catch(
      async (error) => {
        await this.close();
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
    const result = parse(await response.json());
    if (!result.ok) throw result.error;
    return result.value;
  }

  private fence(claim: ClaimGrant) {
    return {
      session: claim.session,
      run: claim.run,
      fencing_token: claim.fencing_token,
    };
  }

  private async claimAndRead(
    binding: ReadyBinding,
    request: EnsureBindingRequest,
  ): Promise<void> {
    const claim = await this.edge(
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
    if (claim.status !== "granted")
      throw new Error("Owned Codex pilot could not claim the run");
    this.claim = claim;
    if (claim.session !== binding.conversationId || claim.run !== binding.epoch)
      throw new Error("Owned Codex lease does not match the binding");
    this.scheduleRenewal(claim, claim.lease_ms);
    const checkpoint = checkpointOf(binding);
    const previous = claim.last_event_seq ?? 0;
    if (this.session && previous !== 0)
      throw new Error("Fresh owned Codex binding already has events");
    this.session ??= await this.open(
      {
        session: claim.session,
        run: claim.run,
        fencing_token: claim.fencing_token,
        cwd: request.target.projectPath,
        afterSeq: Math.max(previous, 1),
        options: await this.settings(request, checkpoint),
      },
      checkpoint.threadId,
    );
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
    void this.writeEvents(claim, this.session)
      .then(() => this.close())
      .catch((error) => {
        this.options.log(
          `[owned-codex] event writer stopped: ${String(error)}`,
        );
        void this.close().catch(() => {});
      });
  }

  private async writeEvents(
    claim: ClaimGrant,
    session: OwnedSession,
  ): Promise<void> {
    for await (const event of session.events) {
      if (event.kind !== "message.delta") await this.append(claim, event);
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
        batches: [{ ...this.fence(claim), events: [event] }],
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
        { v, ...this.fence(claim) },
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
    return (this.closing ??= this.closeOwned());
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.renewal);
    await this.renewalTask?.catch(() => {});
    const session =
      this.session ?? (await this.opening?.catch(() => undefined));
    if (session && (await session.close()).status !== "closed")
      throw new Error("Owned Codex cleanup could not be confirmed");
    await this.adapter?.dispose();
    if (this.claim) {
      await this.edge(
        "release",
        { v, ...this.fence(this.claim) },
        parseReleaseResponse,
        AbortSignal.timeout(10_000),
      );
    }
  }
}
