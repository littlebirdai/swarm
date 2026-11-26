import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FENCED_RUNTIME_CAPABILITIES,
  parseStartedDeliveryPermit,
  type ReadyBinding,
  type StartedDeliveryPermit,
} from "@codecast/agent-clients/executionBinding";
import { fake } from "../../../../tests/codex-driver-parity/peers.js";
import type { RetryQueue } from "../retryQueue.js";
import type { SyncService } from "../syncService.js";
import { strictStub } from "../test-helpers/strictStub.js";
import { createCodexOwnedPilot } from "./codex-owned-pilot.js";
import type { ExecutionConvexTransport } from "./convexControlPlane.js";
import type { RuntimeDriver } from "./driver.js";
import { InMemoryExecutionOperationJournal } from "./localJournal.js";
import { DaemonExecutionRuntime } from "./runtime-rail.js";
import type { RuntimeStartRequest } from "./types.js";

function request(
  conversationId: string,
  projectPath: string,
  epoch = 1,
): RuntimeStartRequest {
  return {
    target: {
      conversationId,
      epoch,
      projectPath,
      requestedAgent: "codex",
      transport: "app-server",
    },
    ownerDeviceId: "device",
    daemonBootId: "boot",
    protocolVersion: 1,
    operationId: `start-${conversationId}-${epoch}`,
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    configuration: { revision: epoch },
    trigger: "recovery",
  };
}

function bindingFor(
  { target, ...start }: RuntimeStartRequest,
  owned = false,
): ReadyBinding {
  const runtimeId = `${target.conversationId}-thread-${target.epoch}`;
  return {
    conversationId: target.conversationId,
    epoch: target.epoch,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    runtimeId,
    handle: owned
      ? "owned-codex-v1:" +
        JSON.stringify({
          threadId: runtimeId,
          sandbox: "read-only",
          approvalPolicy: "on-request",
        })
      : runtimeId,
    ownerDeviceId: start.ownerDeviceId,
    daemonBootId: start.daemonBootId,
    operationId: start.operationId,
    appliedConfigurationRevision: start.configuration.revision,
    protocolVersion: 1,
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
  };
}

function pending(request: RuntimeStartRequest, binding?: ReadyBinding) {
  return {
    request,
    state: binding ? "ready" : "requested",
    daemonBootMatch: true,
    binding,
  };
}

function item(request: RuntimeStartRequest, binding?: ReadyBinding) {
  return {
    conversationId: request.target.conversationId,
    currentEpoch: request.target.epoch,
    bindings: [pending(request, binding)],
  };
}

function started(
  binding: ReadyBinding,
  sequence: string,
): StartedDeliveryPermit {
  return parseStartedDeliveryPermit({
    state: "delivery-started",
    messageId: `message-${sequence}`,
    deliveryId: `delivery-${sequence}`,
    conversationSequence: sequence,
    attemptId: `attempt-${sequence}`,
    conversationId: binding.conversationId,
    executionEpoch: binding.epoch,
    configurationRevision: binding.appliedConfigurationRevision,
    ownerDeviceId: binding.ownerDeviceId,
    daemonBootId: binding.daemonBootId,
    runtimeId: binding.runtimeId,
  });
}

function fixture(selected = "pilot") {
  const directory = mkdtempSync(join(tmpdir(), "owned-codex-recovery-"));
  const appServer = fake(directory, "owned-recovery");
  const actions: string[] = [];
  const logs: string[] = [];
  const pilotRequest = request("pilot", directory);
  const legacyRequest = request("legacy", directory);
  const successor = request("pilot", directory, 2);
  const ledger = new Map<
    string,
    [RuntimeStartRequest, ReadyBinding | undefined]
  >([
    ["pilot:1", [pilotRequest, undefined]],
    ["legacy:1", [legacyRequest, undefined]],
    ["pilot:2", [successor, undefined]],
  ]);
  const legacy: RuntimeDriver = {
    id: "legacy-codex",
    supportedAgents: new Set(["codex"]),
    transport: "app-server",
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    async start(request) {
      actions.push(
        `legacy-start:${request.target.conversationId}:${request.target.epoch}`,
      );
      return { state: "started", handle: bindingFor(request) };
    },
    async deliver({ binding, permit }) {
      actions.push(
        `legacy-deliver:${binding.conversationId}:${binding.epoch}:${permit.conversationSequence}`,
      );
      return { state: "delivered" };
    },
    async adopt() {
      return { state: "missing" };
    },
    async stop(binding) {
      actions.push(`legacy-stop:${binding.conversationId}`);
    },
    async quarantine(binding) {
      actions.push(`legacy-quarantine:${binding.conversationId}`);
    },
  };
  const pilot = createCodexOwnedPilot(
    {
      siteUrl: "https://pilot.invalid",
      bearer: "fixture-bearer",
      command: () => [appServer.executable],
      permissions: () => ({
        sandbox: "read-only",
        approvalPolicy: "on-request",
      }),
      instructions: async () => undefined,
      display: {
        syncService: strictStub<SyncService>("syncService"),
        retryQueue: strictStub<RetryQueue>("retryQueue"),
        conversationCache: {},
        mapCodexAppServerThreadStatusToAgentStatus: () => null,
        sendAgentStatus: () => {},
        trackTmuxSpawns: async () => {},
        syncMessagesBatch: async () => {},
      },
      log: (message) => logs.push(message),
    },
    {
      CODECAST_FENCED_EXECUTION_V1: "1",
      CODECAST_CODEX_OWNED_PILOT_SESSION: selected,
    },
  )!;
  let initial: unknown = [];
  const permits = new Map<string, StartedDeliveryPermit>();
  const remaining = new Map([
    ["legacy:1", 2],
    ["pilot:2", 1],
  ]);
  const emptyAfterDelivery = new Set<string>();
  const transport: ExecutionConvexTransport = {
    async executionControlQuery() {
      return initial;
    },
    subscribeExecutionControlQuery() {
      actions.push("subscribed");
      return () => {};
    },
    async executionControlMutation(name, args) {
      const key = `${args.conversation_id}:${args.epoch ?? args.execution_epoch}`;
      const row = ledger.get(key);
      if (name === "registerExecutionDaemonBoot") return { registered: true };
      if (name === "claimExecutionStart") {
        if (!row) throw new Error(`Missing binding ${key}`);
        if (row[1]) return { state: "ready", binding: row[1] };
        return {
          state: "claimed",
          operationId: row[0].operationId,
          recovery: { state: "fresh" },
        };
      }
      if (name === "publishReadyBinding" && row) {
        row[1] = {
          ...bindingFor(row[0]),
          operationId: String(args.operation_id),
          handle: String(args.handle),
          runtimeId: String(args.runtime_id),
        };
        return { accepted: true };
      }
      if (name === "claimNextDelivery" && row?.[1]) {
        actions.push(`claim-delivery:${key}`);
        if (emptyAfterDelivery.delete(key)) return { state: "empty" };
        const count = remaining.get(key) ?? 0;
        if (!count) return { state: "empty" };
        remaining.set(key, count - 1);
        emptyAfterDelivery.add(key);
        const permit = started(row[1], String(3 - count));
        permits.set(permit.attemptId, permit);
        return {
          state: "claimed",
          permit: { ...permit, state: "claimed" },
          message: { content: "queued follow-up" },
        };
      }
      if (name === "startDelivery") {
        const wire = args.permit as { attempt_id: string };
        return permits.get(wire.attempt_id);
      }
      if (name === "completeDelivery") return { delivered: true };
      if (name === "publishRuntimeDisposition") {
        actions.push(`disposition:${key}:${args.disposition}`);
        return { accepted: true };
      }
      if (name === "activateExecutionSuccessor") {
        actions.push(
          `activate:${args.expected_current_epoch}:${args.successor_epoch}`,
        );
        return { activated: true };
      }
      throw new Error(`Unexpected execution mutation ${name} for ${key}`);
    },
  };
  const driver = pilot.register(legacy);
  const runtime = new DaemonExecutionRuntime({
    transport,
    ownerDeviceId: "device",
    daemonBootId: "boot",
    drivers: [driver],
    codexOwnedPilot: pilot,
    journal: new InMemoryExecutionOperationJournal(),
    onLog: (message) => logs.push(message),
  });
  const claimResponses: Response[] = [];
  const releasing = Promise.withResolvers<void>();
  let release: Promise<void> | undefined;
  let lastSeq = 0;
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init: Parameters<typeof fetch>[1],
      ) => {
        const operation = new URL(String(input)).pathname.split("/").at(-1);
        const body = JSON.parse(String(init?.body));
        actions.push(`edge:${operation}`);
        if (operation === "claim") {
          return (
            claimResponses.shift() ??
            Response.json({
              v: 1,
              status: "granted",
              session: "pilot",
              run: 1,
              fencing_token: "edge-lease",
              lease_ms: 60_000,
              last_pane_instance: 0,
              last_event_seq: lastSeq,
            })
          );
        }
        if (operation === "events.append") {
          const [batch] = body.batches;
          lastSeq = batch.events[0].seq;
          return Response.json({
            v: 1,
            results: [
              { session: "pilot", status: "appended", through_seq: lastSeq },
            ],
          });
        }
        if (operation === "release") {
          expect(body.fencing_token).toBe("edge-lease");
          releasing.resolve();
          await release;
          return Response.json({ v: 1, status: "released" });
        }
        throw new Error(`Unexpected edge operation ${operation}`);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  return {
    actions,
    logs,
    runtime,
    pilot,
    driver,
    appServer,
    pilotRequest,
    legacyRequest,
    successor,
    claimResponses,
    releasing,
    pauseRelease(gate: Promise<void>) {
      release = gate;
    },
    initial(work: unknown) {
      initial = work;
    },
    ready(request: RuntimeStartRequest, binding?: ReadyBinding) {
      const row = ledger.get(
        `${request.target.conversationId}:${request.target.epoch}`,
      )!;
      if (binding) row[1] = binding;
      if (!row[1]) throw new Error("No ready fixture binding");
      return row[1];
    },
    async dispose() {
      try {
        await runtime.stop();
      } finally {
        network.mockRestore();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

test("startup claim failure leaves legacy work running and the pilot retries a busy claim on the next updates", async () => {
  const f = fixture();
  try {
    f.claimResponses.push(
      new Response(null, { status: 503 }),
      Response.json({ v: 1, status: "busy", retry_after_ms: 0 }),
    );
    const work = [item(f.pilotRequest), item(f.legacyRequest)];
    f.initial(work);
    await f.runtime.start();
    expect(f.actions).toContain("subscribed");
    expect(f.actions).toContain("legacy-start:legacy:1");
    expect(f.actions).toContain("legacy-deliver:legacy:1:1");
    await f.runtime.processWorkUpdate(work);
    expect(f.actions).toContain("legacy-deliver:legacy:1:2");
    await f.runtime.processWorkUpdate(work);
    expect(f.actions.filter((action) => action === "edge:claim")).toHaveLength(
      3,
    );
    expect(f.logs.join("\n")).toContain("HTTP 503");
    expect(f.logs.join("\n")).toContain("busy");
    expect(f.actions).toContain("edge:events.append");
    expect(
      f.appServer.wire().filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(f.actions).not.toContain("claim-delivery:pilot:1");
    expect(f.actions).not.toContain("edge:release");
  } finally {
    await f.dispose();
  }
});

test("retargeted pilot leaves the old checkpoint parked and drains the next legacy conversation", async () => {
  const f = fixture("retargeted");
  try {
    const old = f.ready(f.pilotRequest, bindingFor(f.pilotRequest, true));
    const activate = spyOn(f.pilot, "activate");
    await f.runtime.processWorkUpdate([
      item(f.pilotRequest, old),
      item(f.legacyRequest),
    ]);
    expect(activate).not.toHaveBeenCalled();
    expect(f.actions).toContain("legacy-deliver:legacy:1:1");
    expect(f.actions).not.toContain("edge:claim");
    expect(f.actions).not.toContain("claim-delivery:pilot:1");
    await f.driver.stop(old);
    await f.driver.quarantine(old, "retargeted");
    expect(f.actions).toContain("legacy-stop:pilot");
    expect(f.actions).toContain("legacy-quarantine:pilot");
  } finally {
    await f.dispose();
  }
});

test("owned current epoch stops before the legacy successor activates and drains", async () => {
  const f = fixture();
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    const owned = f.ready(f.pilotRequest);
    await f.runtime.processWorkUpdate([
      {
        ...item(f.pilotRequest, owned),
        pendingEpoch: 2,
        pendingPolicy: "drain-current",
        bindings: [pending(f.pilotRequest, owned), pending(f.successor)],
      },
    ]);
    expect(f.actions).toEqual([
      "edge:claim",
      "edge:events.append",
      "legacy-start:pilot:2",
      "edge:release",
      "disposition:pilot:1:stopped",
      "activate:1:2",
      "claim-delivery:pilot:2",
      "legacy-deliver:pilot:2:2",
      "claim-delivery:pilot:2",
    ]);
  } finally {
    await f.dispose();
  }
});

test("the owned driver refuses delivery before effect and reports uncertain adoption", async () => {
  const f = fixture();
  try {
    const binding = bindingFor(f.pilotRequest, true);
    const permit = started(binding, "1");
    await expect(
      f.driver.deliver({
        binding,
        permit,
        delivery: {
          messageId: permit.messageId,
          deliveryId: permit.deliveryId,
          conversationSequence: "1",
          input: [{ type: "text", text: "queued" }],
        },
      }),
    ).resolves.toMatchObject({
      state: "failed-before-effect",
      failure: { code: "OWNED_CODEX_DELIVERY_PENDING" },
    });
    await expect(
      f.driver.adopt({
        ...f.pilotRequest,
        knownHandle: { ...binding },
      }),
    ).resolves.toMatchObject({
      state: "unknown",
      failure: { code: "OWNED_CODEX_START_UNCONFIRMED" },
    });
    expect(f.actions).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("runtime shutdown waits for the lease release after confirmed provider cleanup", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    f.pauseRelease(gate.promise);
    let stopped = false;
    const shutdown = Promise.resolve(f.runtime.stop()).then(() => {
      stopped = true;
    });
    await f.releasing.promise;
    expect(stopped).toBe(false);
    gate.resolve();
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("runtime shutdown retains the edge lease when provider cleanup is unconfirmed", async () => {
  const f = fixture();
  const spawn = Bun.spawn;
  const kill = process.kill.bind(process);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    ...args: Parameters<typeof Bun.spawn>
  ) => {
    const launched = Reflect.apply(spawn, Bun, args) as ReturnType<
      typeof Bun.spawn
    >;
    const spec = args[0];
    if (
      spec &&
      "cmd" in spec &&
      Array.isArray(spec.cmd) &&
      spec.cmd[0] === f.appServer.executable
    )
      child = launched;
    return launched;
  }) as typeof Bun.spawn);
  const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (child && pid === -child.pid)
      throw Object.assign(new Error("fixture kill denied"), { code: "EPERM" });
    return kill(pid, signal);
  });
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    expect(child).toBeDefined();
    await f.runtime.stop();
    expect(f.logs.join("\n")).toContain("cleanup could not be confirmed");
    expect(f.actions).not.toContain("edge:release");
  } finally {
    spawnSpy.mockRestore();
    killSpy.mockRestore();
    if (child) {
      try {
        kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error;
      }
      await child.exited;
    }
    await f.dispose();
  }
});

test("a granted lease is retained if the provider never opened", async () => {
  const f = fixture();
  try {
    const binding = {
      ...bindingFor(f.pilotRequest, true),
      handle: "owned-codex-v1:{}",
    };
    f.ready(f.pilotRequest, binding);
    await f.runtime.processWorkUpdate([item(f.pilotRequest, binding)]);
    expect(f.logs.join("\n")).toContain("Invalid owned Codex checkpoint");
    await f.runtime.stop();
    expect(f.actions).toEqual(["edge:claim"]);
  } finally {
    await f.dispose();
  }
});
