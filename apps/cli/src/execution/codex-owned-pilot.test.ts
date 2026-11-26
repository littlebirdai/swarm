import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FENCED_RUNTIME_CAPABILITIES,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import type { CanonicalEvent } from "@codecast/edge-contract";
import { fake, until } from "../../../../tests/codex-driver-parity/peers.js";
import type { RetryQueue } from "../retryQueue.js";
import type { SyncService } from "../syncService.js";
import { strictStub } from "../test-helpers/strictStub.js";
import { createCodexOwnedPilot } from "./codex-owned-pilot.js";
import type { ExecutionConvexTransport } from "./convexControlPlane.js";
import { CodexAppServerRuntimeDriver } from "./drivers/codexAppServer.js";
import { InMemoryExecutionOperationJournal } from "./local-journal.js";
import { DaemonExecutionRuntime } from "./runtime-rail.js";

const flag = {
  CODECAST_FENCED_EXECUTION_V1: "1",
  CODECAST_CODEX_OWNED_PILOT_SESSION: "pilot-conversation",
};
const options = {
  siteUrl: "https://pilot.invalid",
  bearer: "fixture-bearer",
  permissions: () =>
    ({ sandbox: "read-only", approvalPolicy: "on-request" }) as const,
  instructions: async () => ({ text: "Keep the checkout read-only." }),
  display: {
    syncService: strictStub<SyncService>("syncService"),
    retryQueue: strictStub<RetryQueue>("retryQueue"),
    conversationCache: {},
    mapCodexAppServerThreadStatusToAgentStatus: () => "working" as const,
    sendAgentStatus: () => {},
    trackTmuxSpawns: async () => {},
    syncMessagesBatch: async () => {},
  },
  log: () => {},
};

const legacy = new CodexAppServerRuntimeDriver({
  io: {
    client: {
      async threadStart() {
        throw new Error("Unexpected legacy start");
      },
      async turnStart() {
        throw new Error("Unexpected legacy delivery");
      },
    },
    async inspectThread() {
      return "unknown";
    },
    async stopThread() {},
    async quarantineThread() {},
  },
});

test("the owned pilot requires both rollout flags and leaves the legacy driver selected otherwise", () => {
  for (const env of [
    {},
    { CODECAST_FENCED_EXECUTION_V1: "1" },
    { ...flag, CODECAST_FENCED_EXECUTION_V1: "0" },
  ]) {
    const pilot = createCodexOwnedPilot(
      { ...options, command: () => ["unused"] },
      env,
    );
    expect(pilot?.register(legacy) ?? legacy).toBe(legacy);
  }
});

test("the enabled pilot starts an owned session and resumes its checkpoint with one start event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-codex-pilot-"));
  const appServer = fake(directory, "pilot");
  const savedEvents: CanonicalEvent[] = [];
  let ready: ReadyBinding | undefined;
  const renewals: string[] = [];
  const releases: string[] = [];
  const fetchEdge = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init: Parameters<typeof fetch>[1],
      ) => {
        const operation = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-bearer",
        );
        if (operation.endsWith("/claim")) {
          expect(ready).toBeDefined();
          expect(body.boot).toBe(ready!.daemonBootId);
          return Response.json({
            v: 1,
            status: "granted",
            session: ready!.conversationId,
            run: ready!.epoch,
            fencing_token: `lease-${body.boot}`,
            lease_ms: 120,
            last_pane_instance: 0,
            last_event_seq: savedEvents.length,
          });
        }
        if (operation.endsWith("/events.append")) {
          const [batch] = body.batches;
          expect(batch.fencing_token).toBe(`lease-${ready!.daemonBootId}`);
          expect(batch.events[0].seq).toBe(savedEvents.length + 1);
          savedEvents.push(...batch.events);
          return Response.json({
            v: 1,
            results: [
              {
                session: batch.session,
                status: "appended",
                through_seq: savedEvents.length,
              },
            ],
          });
        }
        if (operation.endsWith("/permits.next"))
          return Response.json({ v: 1, status: "empty" });
        if (operation.endsWith("/renew")) {
          renewals.push(body.fencing_token);
          return Response.json({ v: 1, status: "renewed", lease_ms: 60_000 });
        }
        if (operation.endsWith("/release")) {
          releases.push(body.fencing_token);
          return Response.json({ v: 1, status: "released" });
        }
        throw new Error(`Unexpected edge operation ${operation}`);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const statuses: Array<{
    conversation: string;
    thread: string;
    event: string | undefined;
  }> = [];
  const titles: Array<[string, string, string | undefined]> = [];
  const pilotOptions = {
    ...options,
    display: {
      ...options.display,
      syncService: strictStub<SyncService>("syncService", {
        async updateTitle(conversation, title) {
          titles.push([conversation, title, savedEvents.at(-1)?.kind]);
        },
      }),
      sendAgentStatus(
        _service: SyncService,
        conversation: string,
        thread: string,
      ) {
        statuses.push({
          conversation,
          thread,
          event: savedEvents.at(-1)?.kind,
        });
      },
    },
    command: () => [appServer.executable] as const,
  };
  const first = createCodexOwnedPilot(pilotOptions, flag)!;
  const resumed = createCodexOwnedPilot(
    {
      ...pilotOptions,
      permissions: () => ({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      }),
    },
    flag,
  )!;
  const journal = new InMemoryExecutionOperationJournal();
  function run(boot: string, pilot: typeof first) {
    const request = {
      target: {
        conversationId: flag.CODECAST_CODEX_OWNED_PILOT_SESSION,
        epoch: 1,
        requestedAgent: "codex",
        transport: "app-server",
        projectPath: directory,
      },
      configuration: { revision: 1, model: "test-model" },
      ownerDeviceId: "device-1",
      daemonBootId: boot,
      requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
      protocolVersion: 1,
      trigger: "recovery",
    };
    const transport: ExecutionConvexTransport = {
      async executionControlQuery() {
        throw new Error("Unexpected execution query");
      },
      async executionControlMutation(name, args) {
        if (name === "claimExecutionStart") {
          if (ready) {
            ready = { ...ready, daemonBootId: boot };
            return { state: "ready", binding: ready };
          }
          return {
            state: "claimed",
            operationId: args.proposed_operation_id,
            recovery: { state: "fresh" },
          };
        }
        if (name === "publishReadyBinding") {
          ready = {
            conversationId: request.target.conversationId,
            epoch: 1,
            requestedAgent: "codex",
            actualAgent: "codex",
            transport: "app-server",
            handle: String(args.handle),
            ownerDeviceId: "device-1",
            daemonBootId: boot,
            runtimeId: String(args.runtime_id),
            operationId: String(args.operation_id),
            appliedConfigurationRevision: 1,
            protocolVersion: 1,
            capabilities: [...FENCED_RUNTIME_CAPABILITIES],
          };
          return { accepted: true };
        }
        throw new Error(`Unexpected execution mutation ${name}`);
      },
    };
    const runtime = new DaemonExecutionRuntime({
      transport,
      ownerDeviceId: "device-1",
      daemonBootId: boot,
      drivers: [pilot.register(legacy)],
      codexOwnedPilot: pilot,
      journal,
    });
    const work = [
      {
        conversationId: request.target.conversationId,
        currentEpoch: 1,
        bindings: [
          {
            state: ready ? "ready" : "requested",
            daemonBootMatch: !ready,
            request,
            ...(ready ? { binding: ready } : {}),
          },
        ],
      },
    ];
    return { runtime, work };
  }
  const original = run("boot-1", first);
  let restarted: ReturnType<typeof run> | undefined;
  try {
    expect(original.runtime.drivers.resolve("codex", "app-server").id).toBe(
      "codex-app-server-with-owned-pilot-v1",
    );
    await original.runtime.processWorkUpdate(original.work);
    await original.runtime.processWorkUpdate(original.work);
    expect(
      appServer.wire().filter(({ method }) => method === "thread/start"),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          cwd: directory,
          model: "test-model",
          sandbox: "read-only",
          approvalPolicy: "on-request",
          developerInstructions: "Keep the checkout read-only.",
        }),
      }),
    ]);
    expect(journal.get(ready!.conversationId, 1)?.binding?.handle).toBe(
      ready!.handle,
    );
    await until(
      () => statuses.length === 1,
      "fresh session opens with its lease",
    );
    expect(savedEvents.map(({ kind, seq }) => [kind, seq])).toEqual([
      ["session.started", 1],
      ["turn.started", 2],
    ]);
    await until(
      () => renewals.length === 1,
      "active pilot renews its run lease",
    );
    expect(renewals).toEqual(["lease-boot-1"]);
    await original.runtime.stop();
    expect(releases).toEqual(["lease-boot-1"]);
    restarted = run("boot-2", resumed);
    await restarted.runtime.processWorkUpdate(restarted.work);
    await until(
      () => statuses.length === 2,
      "resumed turn reaches the event writer",
    );
    expect(
      appServer.wire().filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(2);
    for (const { params } of appServer
      .wire()
      .filter(({ method }) => method === "thread/resume")) {
      expect(params).toMatchObject({
        threadId: appServer.thread,
        sandbox: "read-only",
        approvalPolicy: "on-request",
      });
    }
    expect(savedEvents.map(({ kind, seq }) => [kind, seq])).toEqual([
      ["session.started", 1],
      ["turn.started", 2],
      ["turn.started", 3],
    ]);
    appServer.send({
      frames: [
        {
          method: "thread/name/updated",
          params: { threadId: appServer.thread, threadName: "Resumed title" },
        },
      ],
    });
    await until(() => titles.length === 1, "resumed title reaches the daemon");
    expect(titles).toEqual([
      [flag.CODECAST_CODEX_OWNED_PILOT_SESSION, "Resumed title", "context"],
    ]);
    expect(statuses.slice(1)).toEqual([
      {
        conversation: flag.CODECAST_CODEX_OWNED_PILOT_SESSION,
        thread: appServer.thread,
        event: "turn.started",
      },
    ]);
  } finally {
    await Promise.allSettled([
      original.runtime.stop(),
      restarted?.runtime.stop(),
    ]);
    fetchEdge.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
