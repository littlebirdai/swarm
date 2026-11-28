import { expect, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FENCED_RUNTIME_CAPABILITIES,
  type ReadyBinding,
  type StartedDeliveryPermit,
} from "@codecast/agent-clients/executionBinding";
import { fake } from "../../../../tests/codex-driver-parity/peers.js";
import type { RetryQueue } from "../retryQueue.js";
import type { SyncService } from "../syncService.js";
import { strictStub } from "../test-helpers/strictStub.js";
import { createCodexOwnedPilot } from "./codex-owned-pilot.js";
import {
  bindingFor,
  createFixturePeerIo,
  item,
  legacyFixtureDriver,
  pending,
  request,
  resolveFailedStartClaim,
  started,
  type FixtureStartFailure,
} from "./codex-owned-pilot-requests.js";
import type { ExecutionConvexTransport } from "./convexControlPlane.js";
import type { RuntimeDriver } from "./driver.js";
import { FileExecutionOperationJournal } from "./local-journal.js";
import {
  parseDeliverySettleRequest,
  RELAY_TOKEN_DELTAS_CAPABILITY,
  STEER_BATON_CAPABILITY,
  parseDeliveryStartRequest,
  parseHelloRequest,
  parseRelayGrantRequest,
  type CanonicalEvent,
  type DeliverySettleRequest,
  type PermitsNextResponse,
} from "@codecast/edge-contract";
import { DaemonExecutionRuntime } from "./runtime-rail.js";
import type { RuntimeStartRequest } from "./types.js";

export { bindingFor, item, pending, started };

type RelayFixture = {
  grant: (signal: AbortSignal) => Promise<Response>;
};

export function fixture(
  selected: string | null = "pilot",
  enabled = true,
  useReceiptPeer: false | "receipt" | "receipt-before-reply" = false,
  manyOrRelay: boolean | RelayFixture = false,
  relayArg?: RelayFixture,
) {
  const many = typeof manyOrRelay === "boolean" ? manyOrRelay : false;
  const relay = typeof manyOrRelay === "object" ? manyOrRelay : relayArg;
  const directory = mkdtempSync(join(tmpdir(), "owned-codex-recovery-"));
  const appServer = fake(directory, "owned-recovery");
  const peerCommand = [
    "/usr/bin/env",
    ...(useReceiptPeer === "receipt-before-reply"
      ? ["FIXTURE_HOLD_START=1"]
      : []),
    process.execPath,
    resolve(
      import.meta.dir,
      "../../../../packages/provider-adapter/test/fake-app-server.ts",
    ),
    directory,
  ] as const;
  let resumedTurn: string | undefined;
  let receiptReplay: Promise<void> | undefined;
  let refuseBlobs = false;
  const { sendFrame, providerRequests, deliveryRequests } =
    createFixturePeerIo(directory);
  const actions: string[] = [];
  const logs: string[] = [];
  const pilotRequest = request("pilot", directory);
  const legacyRequest = request("legacy", directory);
  const newRequest: RuntimeStartRequest = {
    ...request("new", directory),
    requiredCapabilities: [
      ...FENCED_RUNTIME_CAPABILITIES,
      STEER_BATON_CAPABILITY,
    ],
  };
  const successor = request("pilot", directory, 2);
  const ledger = new Map<
    string,
    [RuntimeStartRequest, ReadyBinding | undefined]
  >([
    ["pilot:1", [pilotRequest, undefined]],
    ["legacy:1", [legacyRequest, undefined]],
    ["new:1", [newRequest, undefined]],
    ["pilot:2", [successor, undefined]],
  ]);
  const legacy = legacyFixtureDriver(actions);
  const promptMessages: Parameters<SyncService["addMessages"]>[0]["messages"] =
    [];
  const promptPermissions = new Map<string, { id: string; turn: string }>();
  const cancelledPermissions: string[] = [];
  let promptCleanupError = false;
  let failedPermissionCleanup: string | undefined;
  let questionWrite: Promise<void> | undefined;
  let errorClearPause: { started(): void; resume: Promise<void> } | undefined;
  let errorClearFailures = 0;
  let errorClearFailureError: Error | undefined;
  let failOpen = false;
  let claimStartPause: { started(): void; resume: Promise<void> } | undefined;
  let renewal: Promise<void> | undefined;
  const statuses: string[] = [];
  const currentSessionErrors = new Map<string, string>();
  const setSessionErrorCalls: Array<{
    conversationId: string;
    error?: string;
    onlyIfEquals?: string;
    force?: boolean;
  }> = [];
  const sessionErrors: Array<{
    conversationId: string;
    error?: string;
    force?: boolean;
  }> = [];
  function createPilot(flag = enabled) {
    return createCodexOwnedPilot(
      {
        siteUrl: "https://pilot.invalid",
        bearer: "fixture-bearer",
        command: () =>
          failOpen
            ? (["/usr/bin/false"] as const)
            : !useReceiptPeer
              ? ([appServer.executable] as const)
              : resumedTurn
                ? ([
                    peerCommand[0],
                    `FIXTURE_RESUME_TURN_ID=${resumedTurn}`,
                    ...peerCommand.slice(1),
                  ] as const)
                : peerCommand,
        permissions: () => ({
          sandbox: "read-only",
          approvalPolicy: "on-request",
        }),
        instructions: async () => undefined,
        display: {
          syncService: strictStub<SyncService>("syncService", {
            async addMessages({ messages }) {
              if (
                messages.some((message) => message.toolResults) &&
                promptCleanupError
              )
                throw new Error("Prompt sync failed");
              promptMessages.push(...structuredClone(messages));
              if (messages.some((message) => message.toolCalls))
                await questionWrite;
              return { inserted: messages.length, ids: [] };
            },
            async createPermissionRequest(request) {
              const id = request.fenced_prompt_id!;
              const rowId = `row-${id}`;
              promptPermissions.set(rowId, {
                id,
                turn: request.fenced_prompt_turn_id!,
              });
              return rowId;
            },
            async cancelPermissionRequest(rowId) {
              if (promptCleanupError || rowId === failedPermissionCleanup)
                throw new Error("Prompt sync failed");
              const removed = promptPermissions.delete(rowId);
              if (removed) cancelledPermissions.push(rowId);
              return removed;
            },
            async setSessionError(conversationId, error, opts) {
              setSessionErrorCalls.push({
                conversationId,
                error,
                onlyIfEquals: opts?.onlyIfEquals,
                force: opts?.force,
              });
              if (error === undefined && errorClearPause) {
                const pause = errorClearPause;
                errorClearPause = undefined;
                pause.started();
                await pause.resume;
              }
              if (error === undefined && errorClearFailures > 0) {
                errorClearFailures -= 1;
                if (opts?.throwOnError)
                  throw (
                    errorClearFailureError ??
                    new Error("Transient session error clear failure")
                  );
                return;
              }
              if (
                opts?.onlyIfEquals !== undefined &&
                currentSessionErrors.get(conversationId) !== opts.onlyIfEquals
              ) {
                return;
              }
              if (error === undefined)
                currentSessionErrors.delete(conversationId);
              else currentSessionErrors.set(conversationId, error);
              sessionErrors.push({
                conversationId,
                error,
                force: opts?.force,
              });
            },
            getClient() {
              return strictStub<ReturnType<SyncService["getClient"]>>(
                "prompt query",
                {
                  async query() {
                    const page = [
                      ...Array.from(promptPermissions, ([rowId, card]) => ({
                        kind: "permission",
                        rowId,
                        ...card,
                      })),
                      ...promptMessages.flatMap((message) => {
                        const question = message.toolCalls?.find(
                          ({ name }) => name === "AskUserQuestion",
                        );
                        if (
                          !question ||
                          promptMessages.some(
                            ({ messageUuid }) =>
                              messageUuid === `${message.messageUuid}-closed`,
                          )
                        )
                          return [];
                        return [
                          {
                            kind: "question",
                            messageUuid: message.messageUuid,
                            id: question.id,
                            turn: (question.input as { fencedTurnId: string })
                              .fencedTurnId,
                          },
                        ];
                      }),
                    ];
                    return { page, isDone: true, continueCursor: "" } as never;
                  },
                },
              );
            },
          }),
          retryQueue: strictStub<RetryQueue>("retryQueue"),
          conversationCache: {},
          mapCodexAppServerThreadStatusToAgentStatus: (status) => {
            if (status?.type === "active") return "working";
            if (status?.type === "systemError") return "stopped";
            if (status?.type === "idle") return "idle";
            return null;
          },
          sendAgentStatus: (_sync, _conversation, _runtime, status) =>
            statuses.push(status),
          trackTmuxSpawns: async () => {},
          syncMessagesBatch: async () => {},
        },
        log: (message) => logs.push(message),
      },
      {
        CODECAST_FENCED_EXECUTION_V1: flag ? "1" : "0",
        CODECAST_CODEX_OWNED_PILOT_SESSION: selected ?? undefined,
        CODECAST_CODEX_OWNED_NEW_SESSIONS: many ? "1" : undefined,
      },
    );
  }
  const pilot = createPilot();
  let initial: unknown = [];
  let workSubscription:
    | { args: Record<string, unknown>; onUpdate: (value: unknown) => void }
    | undefined;
  const permits = new Map<string, StartedDeliveryPermit>();
  const remaining = new Map([
    ["legacy:1", 2],
    ["pilot:2", 1],
    ...(!enabled ? [["pilot:1", 1] as const] : []),
  ]);
  const emptyAfterDelivery = new Set<string>();
  const bootRegistrations: Record<string, unknown>[] = [];
  const startFailures = new Map<string, FixtureStartFailure>();
  const transport: ExecutionConvexTransport = {
    async executionControlQuery() {
      return initial;
    },
    subscribeExecutionControlQuery(_name, args, onUpdate) {
      actions.push("subscribed");
      workSubscription = { args, onUpdate };
      return () => {
        workSubscription = undefined;
      };
    },
    async executionControlMutation(name, args) {
      const key = `${args.conversation_id}:${args.epoch ?? args.execution_epoch}`;
      const row = ledger.get(key);
      if (name === "registerExecutionDaemonBoot") {
        bootRegistrations.push(args);
        return { registered: true };
      }
      if (name === "claimExecutionStart") {
        if (claimStartPause) {
          const pause = claimStartPause;
          claimStartPause = undefined;
          pause.started();
          await pause.resume;
        }
        if (!row) throw new Error(`Missing binding ${key}`);
        if (row[1]) return { state: "ready", binding: row[1] };
        const failed = startFailures.get(key);
        if (failed) {
          const result = resolveFailedStartClaim(failed, args);
          if (result.state === "claimed") startFailures.delete(key);
          return result;
        }
        return {
          state: "claimed",
          operationId: row[0].operationId,
          recovery: { state: "fresh" },
        };
      }
      if (name === "publishStartFailedBeforeEffect" && row) {
        actions.push(`start-failed-before-effect:${key}:${args.failure_code}`);
        startFailures.set(key, {
          operationId: String(args.operation_id),
          daemonBootId: String(args.daemon_boot_id),
          retryable: args.failure_retryable === true,
        });
        return { accepted: true };
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
  const journalDirectory = join(directory, "journal");
  const driver = pilot?.register(legacy) ?? legacy;
  function runtimeFor(
    boot: string,
    owned: typeof pilot,
    driver: RuntimeDriver,
  ) {
    return new DaemonExecutionRuntime({
      transport,
      ownerDeviceId: "device",
      daemonBootId: boot,
      drivers: [driver],
      codexOwnedPilot: owned,
      journal: new FileExecutionOperationJournal(journalDirectory),
      onLog: (message) => logs.push(message),
    });
  }
  const runtime = runtimeFor("boot", pilot, driver);
  const runtimes = [runtime];
  type Permit = Extract<PermitsNextResponse, { status: "permit" }>;
  const queue: Permit[] = [];
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const events: CanonicalEvent[] = [];
  const releasedSessions: string[] = [];
  const permitSessions: string[] = [];
  const settlements: DeliverySettleRequest[] = [];
  let refuseSettlement = false;
  let permitReadStatus: "stale" | "takeover_fence" | undefined;
  let permitRead: { started(): void; resume: Promise<void> } | undefined;
  let lease = "edge-lease";
  const claimResponses: Response[] = [];
  const releasing = Promise.withResolvers<void>();
  let release: Promise<void> | undefined;
  const eventCursors = new Map<string, number>();
  let terminalLifecycle = false;
  let terminalStartFailure: "once" | "400" | "conflict" | "503" | undefined;
  const terminalStartAttempts: number[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init: Parameters<typeof fetch>[1],
      ) => {
        const operation = new URL(String(input)).pathname.split("/").at(-1);
        const body = JSON.parse(String(init?.body));
        actions.push(`edge:${operation}`);
        if (operation === "hello") {
          expect(parseHelloRequest(body).ok).toBe(true);
          if (relay) {
            expect(body.capabilities).toEqual([RELAY_TOKEN_DELTAS_CAPABILITY]);
          }
          return Response.json({
            status: "ok",
            version: 1,
            policy: {
              revision: 1,
              heartbeat_interval_ms: 30_000,
              uplink_interval_ms: 30_000,
              limits: {
                max_batch_events: 32,
                max_batch_bytes: 100_000,
                max_blob_bytes: 100_000,
              },
              capabilities: relay ? [RELAY_TOKEN_DELTAS_CAPABILITY] : [],
            },
          });
        }
        if (operation === "relay-grant" && relay) {
          expect(parseRelayGrantRequest(body).ok).toBe(true);
          expect(body.sessions).toEqual([
            { session: "pilot", run: 1, fencing_token: lease },
          ]);
          return relay.grant(init!.signal!);
        }
        if (operation === "claim") {
          return (
            claimResponses.shift() ??
            Response.json({
              v: 1,
              status: "granted",
              session: body.session,
              run: 1,
              fencing_token: lease,
              lease_ms: renewal && body.session === "pilot" ? 10 : 60_000,
              last_pane_instance: 0,
              last_event_seq: eventCursors.get(body.session) ?? 0,
              ...(terminalLifecycle && { terminal_lifecycle: true }),
            })
          );
        }
        if (operation === "renew") {
          if (renewal) {
            await renewal;
            return Response.json({ v: 1, status: "stale" });
          }
          return Response.json({ v: 1, status: "renewed", lease_ms: 60_000 });
        }
        if (operation === "permits.next") {
          permitSessions.push(body.session);
          expect(body.fencing_token).toBe(lease);
          if (body.session !== "pilot" && queue[0]?.session !== body.session)
            return Response.json({ v: 1, status: "empty" });
          if (permitRead) {
            const read = permitRead;
            permitRead = undefined;
            read.started();
            await read.resume;
          }
          if (permitReadStatus === "stale")
            return Response.json({ v: 1, status: "stale" });
          if (permitReadStatus === "takeover_fence")
            return Response.json({
              v: 1,
              status: permitReadStatus,
              session: "pilot",
              run: 1,
              fencing_token: lease,
              fence_id: "takeover",
              turn: "actual-turn-1",
              baton_token: null,
              new_baton_token: 1,
            });
          return Response.json(
            queue[0]
              ? { ...queue[0], fencing_token: lease }
              : { v: 1, status: "empty" },
          );
        }
        if (operation === "blobs.get") {
          if (refuseBlobs) return new Response(null, { status: 404 });
          expect(body.fencing_token).toBe(lease);
          expect(body.attempt_id).toBe(queue[0]?.attempt_id);
          expect(body.blob_id).toBe("image");
          return new Response(image, {
            headers: { "Content-Type": "image/png" },
          });
        }
        if (operation === "delivery.start") {
          const parsed = parseDeliveryStartRequest(body);
          if (!parsed.ok) throw parsed.error;
          const head = queue[0]!;
          expect(parsed.value.fencing_token).toBe(lease);
          expect(parsed.value.attempt_id).toBe(head.attempt_id);
          const status = head.state === "new" ? "started" : "already_started";
          head.state = "started";
          return Response.json({ ...head, fencing_token: lease, status });
        }
        if (operation === "delivery.settle") {
          const parsed = parseDeliverySettleRequest(body);
          if (!parsed.ok) throw parsed.error;
          expect(parsed.value.fencing_token).toBe(lease);
          expect(parsed.value.attempt_id).toBe(queue[0]?.attempt_id);
          if (refuseSettlement) return Response.json({ v: 1, status: "stale" });
          settlements.push(parsed.value);
          if (parsed.value.outcome === "applied") queue.shift();
          return Response.json({ v: 1, status: "recorded" });
        }
        if (operation === "events.append") {
          const [batch] = body.batches;
          if (lease === "renewed-lease" && batch.events[0].kind === "receipt")
            await receiptReplay;
          expect(batch.fencing_token).toBe(lease);
          let lastSeq = eventCursors.get(batch.session) ?? 0;
          const first = batch.events[0];
          if (first.kind === "terminal.started") {
            terminalStartAttempts.push(first.seq);
            if (terminalStartFailure === "conflict")
              return Response.json({
                v: 1,
                results: [
                  {
                    session: batch.session,
                    status: "conflict",
                    seq: first.seq,
                  },
                ],
              });
            if (terminalStartFailure) {
              const status = terminalStartFailure === "400" ? 400 : 503;
              if (terminalStartFailure === "once")
                terminalStartFailure = undefined;
              return new Response(null, { status });
            }
          }
          if (batch.abandon_terminal_seq === lastSeq + 1) {
            expect(batch.events).toHaveLength(1);
            expect(first.kind).not.toStartWith("terminal.");
            lastSeq++;
          }
          for (const event of batch.events) {
            expect(event.seq).toBe(lastSeq + 1);
            events.push(event);
            lastSeq = event.seq;
          }
          eventCursors.set(batch.session, lastSeq);
          return Response.json({
            v: 1,
            results: [
              {
                session: batch.session,
                status: "appended",
                through_seq: lastSeq,
              },
            ],
          });
        }
        if (operation === "release") {
          expect(body.fencing_token).toBe(lease);
          releasedSessions.push(body.session);
          releasing.resolve();
          await release;
          return Response.json({ v: 1, status: "released" });
        }
        throw new Error(`Unexpected edge operation ${operation}`);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const pauseGate = (
    assign: (gate: { started(): void; resume: Promise<void> }) => void,
  ) => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    assign({ started: started.resolve, resume: resume.promise });
    return {
      started: started.promise,
      release: resume.resolve,
      resume: resume.resolve,
    };
  };
  return {
    actions,
    bootRegistrations,
    journalDirectory,
    logs,
    runtime,
    pilot: pilot!,
    driver,
    appServer,
    promptMessages,
    promptPermissions,
    cancelledPermissions,
    rejectPromptCleanup: (value: boolean) => {
      promptCleanupError = value;
    },
    rejectPermissionCleanup: (rowId: string) => {
      failedPermissionCleanup = rowId;
    },
    pauseQuestionWrite: (gate: Promise<void>) => {
      questionWrite = gate;
    },
    pauseErrorClear: () => pauseGate((gate) => (errorClearPause = gate)),
    pauseNextClaimStart: () => pauseGate((gate) => (claimStartPause = gate)),
    failNextErrorClears: (count: number, err?: Error) => {
      errorClearFailures = count;
      errorClearFailureError = err;
    },
    setFailOpen: (value: boolean) => {
      failOpen = value;
    },
    seedSessionError: (conversationId: string, error?: string) => {
      if (error === undefined) currentSessionErrors.delete(conversationId);
      else currentSessionErrors.set(conversationId, error);
    },
    currentSessionError: (conversationId: string) =>
      currentSessionErrors.get(conversationId),
    setSessionErrorCalls,
    setResumedTurn: (turnId?: string) => {
      resumedTurn = turnId;
    },
    createRuntime: (boot: string) => {
      const nextPilot = createPilot()!;
      const nextRuntime = runtimeFor(
        boot,
        nextPilot,
        nextPilot.register(legacy),
      );
      runtimes.push(nextRuntime);
      return { runtime: nextRuntime, pilot: nextPilot };
    },
    rejectRenewalAfter: (gate: Promise<void>) => {
      renewal = gate;
    },
    sendFrame,
    deliveryRequests,
    providerRequests,
    statuses,
    sessionErrors,
    exitProvider() {
      process.kill(
        Number(readFileSync(join(directory, "pid"), "utf8")),
        "SIGTERM",
      );
    },
    deliveryThread: "codex-fixture-thread",
    pilotRequest,
    legacyRequest,
    newRequest,
    releasedSessions,
    permitSessions,
    successor,
    events,
    settlements,
    queue,
    image,
    enqueue(id: number, attachImage = false, session = "pilot") {
      const permit: Permit = {
        status: "permit",
        v: 1,
        session,
        run: 1,
        fencing_token: lease,
        attempt_id: `attempt-${id}`,
        delivery_id: `delivery-${id}`,
        seq: id,
        intent: "queue",
        sender: { kind: "person", id: "owner" },
        state: "new",
        input: [
          { type: "text", text: "identical follow-up" },
          ...(attachImage
            ? [
                {
                  type: "blob",
                  blob_id: "image",
                  content_type: "image/png",
                } as const,
              ]
            : []),
        ],
      };
      queue.push(permit);
    },
    setPermitReadStatus(status?: typeof permitReadStatus) {
      permitReadStatus = status;
    },
    pauseNextPermitRead: () => pauseGate((gate) => (permitRead = gate)),
    terminalStartAttempts,
    failTerminalStart(mode: typeof terminalStartFailure) {
      terminalLifecycle = true;
      terminalStartFailure = mode;
    },
    rejectSettlements(value: boolean) {
      refuseSettlement = value;
    },
    rejectBlobs() {
      refuseBlobs = true;
    },
    pauseReceiptReplay(gate: Promise<void>) {
      receiptReplay = gate;
    },
    async restart(activeTurn?: string, afterStop?: () => void) {
      await runtime.stop();
      afterStop?.();
      resumedTurn = activeTurn;
      const row = ledger.get("pilot:1")!;
      row[0] = { ...row[0], daemonBootId: "restarted-boot" };
      row[1] = { ...row[1]!, daemonBootId: row[0].daemonBootId };
      lease = "renewed-lease";
      const resumed = createPilot()!;
      const restarted = runtimeFor(
        row[0].daemonBootId,
        resumed,
        resumed.register(legacy),
      );
      runtimes.push(restarted);
      const result = item(row[0], row[1]);
      await restarted.processWorkUpdate([result]);
      return { restarted, work: result };
    },
    claimResponses,
    releasing,
    pauseRelease(gate: Promise<void>) {
      release = gate;
    },
    initial(work: unknown) {
      initial = work;
    },
    workSubscription() {
      if (!workSubscription)
        throw new Error("Execution work is not subscribed");
      return workSubscription;
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
        await Promise.all(runtimes.map((current) => current.stop()));
      } finally {
        network.mockRestore();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
