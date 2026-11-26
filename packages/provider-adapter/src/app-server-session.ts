import type {
  ControlOutcome,
  DeliveryOutcome,
  InterruptRequest,
  ResumeSpec,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { turnItems, wireInput } from "./app-server-items";
import { appServerReceipts, deliveryClientId } from "./app-server-receipts";
import {
  Initialize,
  InterruptReply,
  Notification,
  OpenOptions,
  Prompt,
  RpcLine,
  SteerReply,
  ThreadReply,
  TurnReply,
} from "./app-server-schema";
import { describePrompt, prepareAnswer } from "./app-server-prompts";
import { inDoubt, refused, type ProviderAdapterOptions } from "./options";
import {
  diagnostic,
  pendingPromptLimit,
  type DurablePayload,
} from "./provider-events";
import type { ProviderFrame } from "./provider-wire";
import { failedAction, project, providerSession } from "./provider-session";
import {
  AdapterError,
  processError,
  rawFrames,
  ownProviderProcess,
  type RpcId,
} from "./provider-process";

type ServerPrompt = { id: RpcId; turn: string; wire: typeof Prompt.Type };
const dialect = {
  name: "Codex app-server",
  command: ["codex", "app-server"],
} as const;
const noReceipt = inDoubt(
  "best-effort",
  "no-receipt",
  "Codex app-server does not record delivery IDs",
);
const waitingReceipt = inDoubt(
  "best-effort",
  "no-receipt",
  "Codex has not confirmed a journaled user item",
);
const rememberedTurns = 4_096;
const rememberedRequests = 128;

export const openAppServer = Effect.fn("app-server.open")(function* (
  options: ProviderAdapterOptions,
  spec: StartSpec | ResumeSpec,
  scope: Scope.Closeable,
) {
  const settings = yield* Schema.decodeUnknownEffect(OpenOptions)(
    spec.options ?? {},
  ).pipe(
    Effect.mapError((cause) =>
      processError(
        "invalid-options",
        "Invalid app-server thread options",
        cause,
      ),
    ),
  );
  const receipts = yield* appServerReceipts(
    spec,
    settings.ephemeral ? undefined : options.receiptJournal,
  );
  const transport = yield* ownProviderProcess(
    options,
    spec.cwd,
    scope,
    dialect,
  );

  const {
    events,
    incoming,
    start,
    establish,
    awaitReply,
    envelope,
    projectEvent,
    checkTurn,
    close,
    answer: makeAnswer,
    respond,
    durable: canonical,
  } = yield* providerSession(
    spec,
    transport,
    scope,
    dialect.name,
    "app-server",
  );
  const { retain: retainRaw, getUnknownPayloadCount } = rawFrames(
    options,
    spec,
  );
  const prompts = new Map<string, ServerPrompt>();
  const completed = new Set<string>();
  const sentTurns = new Map<
    number,
    {
      method: "turn/start" | "turn/steer";
      deliveryId: string;
    }
  >();
  let checkpoint: string | undefined;
  let starting: { id: number; request: SteerRequest } | undefined;
  let active:
    | { id: string; startId?: number; items: ReturnType<typeof turnItems> }
    | undefined;
  let unlocatedTurn = false;
  let projection: Effect.Effect<void>[] = [];

  function retain(...args: Parameters<typeof retainRaw>) {
    projection.push(retainRaw(...args));
  }

  function durable(payload: DurablePayload, turn = active?.id ?? null) {
    projection.push(canonical(payload, turn));
  }

  function begin(turn: string) {
    if (active || completed.has(turn)) return;
    const items = turnItems(
      (payload) => durable(payload, turn),
      (body) => {
        const stamp = envelope();
        projection.push(
          projectEvent(() =>
            events.emit({ ...stamp, turn, kind: "message.delta", body }),
          ),
        );
      },
    );
    if (starting) items.associate(starting.id, starting.request);
    active = { id: turn, startId: starting?.id, items };
    starting = undefined;
    unlocatedTurn = false;
    durable({ kind: "turn.started", body: {} }, turn);
  }

  function finish(reason: string, message?: string) {
    if (!active) return;
    const turn = active.id;
    if (message)
      durable(
        {
          kind: "error",
          body: {
            class: "codex-turn",
            message: diagnostic(message),
            retryable: false,
          },
        },
        turn,
      );
    for (const [key, prompt] of prompts) {
      if (prompt.turn === turn) prompts.delete(key);
    }
    durable({ kind: "turn.ended", body: { reason } }, turn);
    if (completed.size >= rememberedTurns) {
      const oldest = completed.values().next().value;
      if (oldest) completed.delete(oldest);
    }
    completed.add(turn);
    active = undefined;
  }

  function finishTurn(turn: typeof TurnReply.Type.turn) {
    finish(
      turn.status,
      turn.status === "failed"
        ? (turn.error?.message ?? "Codex turn failed")
        : undefined,
    );
  }

  function installThread(thread: typeof ThreadReply.Type.thread) {
    if (checkpoint === undefined) {
      for (const receipt of receipts.replay)
        durable({ kind: "receipt", body: receipt }, null);
    }
    checkpoint = thread.id;
    for (const previous of thread.turns?.slice(-rememberedTurns) ?? []) {
      if (previous.status !== "inProgress") completed.add(previous.id);
    }
    if (thread.status?.type === "active") {
      const live = thread.turns
        ?.filter((turn) => turn.status === "inProgress")
        .at(-1);
      if (live) begin(live.id);
      else unlocatedTurn = true;
    }
  }

  function promptId(id: RpcId) {
    return `${spec.run}:app-server:${typeof id}:${id}`;
  }

  function rejectRequest(id: RpcId, code: number, message: string) {
    projection.push(
      respond({ id, error: { code, message } }).pipe(Effect.asVoid),
    );
  }

  const receivePrompt = Effect.fn("app-server.prompt")(function* (
    line: string,
    id: RpcId,
    method: string,
    params: unknown,
  ) {
    const parsed = yield* Effect.result(
      Schema.decodeUnknownEffect(Prompt)({ method, params }),
    );
    if (parsed._tag === "Failure") {
      retain(line, "unknown");
      rejectRequest(id, -32601, "Unsupported app-server client request");
      return;
    }
    const wire = parsed.success;
    const turn = active?.id;
    if (wire.params.threadId !== checkpoint || wire.params.turnId !== turn) {
      retain(line, "replay");
      rejectRequest(id, -32602, "Prompt does not belong to the active turn");
      return;
    }
    retain(line, "decoded");
    const key = promptId(id);
    if (prompts.has(key)) return;
    if (prompts.size >= pendingPromptLimit) {
      rejectRequest(id, -32000, "Too many pending app-server prompts");
      return;
    }
    prompts.set(key, { id, turn, wire });
    for (const event of describePrompt(wire, key)) durable(event, turn);
  });

  const responseSchemas = {
    initialize: Initialize,
    "thread/start": ThreadReply,
    "thread/resume": ThreadReply,
    "turn/start": TurnReply,
    "turn/steer": SteerReply,
    "turn/interrupt": InterruptReply,
  } as const;
  const receiveResponse = Effect.fn("app-server.rpc-response")(function* (
    line: string,
    id: RpcId,
    result: unknown,
    error: typeof RpcLine.Type.error,
  ) {
    const pending = transport.pendingMethod(id);
    const remembered = typeof id === "number" ? sentTurns.get(id) : undefined;
    if (typeof id === "number") sentTurns.delete(id);
    const method = pending ?? remembered?.method;
    if (!method) return retain(line, "unknown");
    const schema: Schema.Codec<unknown> | undefined = Object.hasOwn(
      responseSchemas,
      method,
    )
      ? responseSchemas[method as keyof typeof responseSchemas]
      : undefined;
    if (!schema) {
      retain(line, "unknown");
      return;
    }
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(schema)(result),
    );
    retain(line, error || decoded._tag === "Success" ? "decoded" : "unknown");
    if (typeof id === "number") {
      if (error) {
        if (starting?.id === id) starting = undefined;
        active?.items.reject(id);
        if (remembered) receipts.reject(remembered.deliveryId);
      } else if (method === "turn/start" && decoded._tag === "Success") {
        const { turn } = decoded.success as typeof TurnReply.Type;
        if (starting?.id === id) {
          begin(turn.id);
          starting = undefined;
        }
        if (
          active?.id === turn.id &&
          active.startId === id &&
          turn.status !== "inProgress"
        )
          finishTurn(turn);
      }
    }
    if (
      !error &&
      decoded._tag === "Success" &&
      (method === "thread/start" || method === "thread/resume")
    ) {
      const { thread } = decoded.success as typeof ThreadReply.Type;
      if (!("checkpoint" in spec) || thread.id === spec.checkpoint)
        installThread(thread);
    }
    return transport.settle(id, result, error);
  });

  const receive = Effect.fn("app-server.receive")(function* (
    frame: ProviderFrame,
  ) {
    const { line, base64Fragment } = frame;
    const turn = active;
    if (base64Fragment) return retain(line, "unknown", base64Fragment);
    const decodedRpc = yield* Effect.result(
      Schema.decodeUnknownEffect(RpcLine)(line),
    );
    if (decodedRpc._tag === "Failure") return retain(line, "unknown");
    const { id, method, params, result, error } = decodedRpc.success;
    if (id !== undefined) {
      return yield* method
        ? receivePrompt(line, id, method, params)
        : receiveResponse(line, id, result, error);
    }
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(Notification)({ method, params }),
    );
    if (decoded._tag === "Failure") return retain(line, "unknown");
    const event = decoded.success;
    if (event.method === "thread/started") {
      return retain(
        line,
        checkpoint && event.params.thread.id !== checkpoint
          ? "replay"
          : "decoded",
      );
    }
    if (event.params.threadId !== checkpoint) return retain(line, "replay");
    if (
      ("turnId" in event.params && event.params.turnId !== turn?.id) ||
      (event.method === "turn/started" &&
        (completed.has(event.params.turn.id) ||
          (!starting &&
            !unlocatedTurn &&
            event.params.turn.id !== turn?.id))) ||
      (event.method === "turn/completed" && event.params.turn.id !== turn?.id)
    ) {
      return retain(line, "replay");
    }
    retain(line, "decoded");
    switch (event.method) {
      case "thread/status/changed":
        if (event.params.status.type === "idle") unlocatedTurn = false;
        durable(
          { kind: "context", body: { data: { status: event.params.status } } },
          turn?.id ?? null,
        );
        break;
      case "thread/name/updated":
        durable(
          {
            kind: "context",
            body: { data: { name: event.params.threadName } },
          },
          turn?.id ?? null,
        );
        break;
      case "turn/started":
        begin(event.params.turn.id);
        break;
      case "turn/completed":
        finishTurn(event.params.turn);
        break;
      case "item/started":
      case "item/completed": {
        const item = event.params.item;
        if (
          event.method === "item/completed" &&
          item.type === "userMessage" &&
          turn &&
          checkpoint
        ) {
          const acceptance = receipts.observe(
            checkpoint,
            turn.id,
            item.id,
            item.clientId,
          );
          if (acceptance)
            projection.push(
              acceptance.pipe(
                Effect.flatMap((receipt) =>
                  receipt
                    ? canonical({ kind: "receipt", body: receipt }, turn.id)
                    : Effect.void,
                ),
              ),
            );
        }
        turn?.items.project(
          event.params.item,
          event.method === "item/completed",
        );
        break;
      }
      case "item/agentMessage/delta":
        turn?.items.assistantDelta(event.params.itemId, event.params.delta);
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        turn?.items.outputDelta(event.params.itemId, event.params.delta);
        break;
      case "serverRequest/resolved":
        prompts.delete(promptId(event.params.requestId));
        break;
    }
  });

  const projector = yield* start(
    Effect.fn("app-server.project-frame")(function* (frame) {
      projection = [];
      const acknowledge = yield* receive(frame);
      const work = project(projection);
      projection = [];
      return { work, acknowledge: acknowledge ?? Effect.void };
    }),
    (reason) => {
      projection = [];
      finish(reason);
      prompts.clear();
      return project(projection);
    },
  );

  const roundTrip = Effect.fn("app-server.round-trip")(function* (
    method: string,
    params: object,
  ) {
    return yield* awaitReply(yield* transport.request(method, params), method);
  });

  const { thread, sandbox } = yield* establish(
    projector,
    Effect.gen(function* () {
      const initialized = yield* roundTrip("initialize", {
        clientInfo: {
          name: "codecast",
          title: "Codecast Daemon",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true },
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Initialize)),
        Effect.mapError((cause) =>
          processError(
            "initialize-failed",
            cause instanceof AdapterError
              ? cause.message
              : "Invalid app-server initialize response",
            cause,
          ),
        ),
      );
      if (
        initialized.userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1] !==
        options.provider.version
      ) {
        return yield* processError(
          "agent-version",
          "Codex app-server reported a different version",
        );
      }
      yield* transport
        .write(() => {
          const error = incoming.error();
          return error
            ? Result.fail(error)
            : Result.succeed([{ method: "initialized" }]);
        })
        .pipe(Effect.raceFirst(incoming.stopped));
      const resuming = "checkpoint" in spec;
      const thread = yield* roundTrip(
        resuming ? "thread/resume" : "thread/start",
        {
          ...settings,
          cwd: spec.cwd,
          ...(resuming ? { threadId: spec.checkpoint } : {}),
        },
      ).pipe(
        Effect.flatMap((reply) =>
          Schema.decodeUnknownEffect(ThreadReply)(reply).pipe(
            Effect.mapError((cause) =>
              processError(
                "invalid-thread",
                "Invalid app-server thread response",
                cause,
              ),
            ),
          ),
        ),
      );
      if (resuming && thread.thread.id !== spec.checkpoint)
        return yield* processError(
          "checkpoint-mismatch",
          "Codex app-server resumed a different thread",
        );
      return thread;
    }),
  );
  const threadId = thread.id;

  const steer = Effect.fn("app-server.steer")(function* (
    request: SteerRequest,
  ): Effect.fn.Return<DeliveryOutcome> {
    const preflight = checkTurn(request.expected, active?.id ?? null);
    if (preflight) return preflight;
    const replay = receipts.retry(request.delivery_id);
    if (replay) return replay;
    const stored = yield* Effect.result(
      receipts.find(threadId, request.delivery_id),
    );
    if (stored._tag === "Failure")
      return inDoubt("unknown", stored.failure.code, stored.failure.message);
    if (stored.success) return { status: "duplicate", receipt: stored.success };
    if (starting || unlocatedTurn)
      return inDoubt(
        "unknown",
        "turn-pending",
        "Codex has not identified the active turn",
      );
    if (!request.input.length)
      return refused("empty-input", "Codex prompt is empty");
    const input = wireInput(request.input);
    const turn = request.expected.turn;
    const method = turn ? "turn/steer" : "turn/start";
    const params = {
      threadId,
      input,
      ...(receipts.enabled
        ? { clientUserMessageId: deliveryClientId(request.delivery_id) }
        : {}),
    };
    const rpc = yield* transport.request(
      method,
      turn
        ? { ...params, expectedTurnId: turn }
        : { ...params, ...(sandbox ? { sandboxPolicy: sandbox } : {}) },
    );
    const result = yield* Effect.result(
      awaitReply<DeliveryOutcome>(
        rpc,
        turn ? "turn/steer" : "turn/start",
        () => {
          const rejected = checkTurn(request.expected, active?.id ?? null);
          if (rejected) return Result.fail(rejected);
          if (starting || unlocatedTurn)
            return Result.fail(
              inDoubt(
                "unknown",
                "turn-pending",
                "Codex has not identified the active turn",
              ),
            );
          const replay = receipts.reserve(request.delivery_id);
          if (replay) return Result.fail(replay);
          if (sentTurns.size >= rememberedRequests) {
            const oldest = sentTurns.keys().next().value;
            if (oldest !== undefined) sentTurns.delete(oldest);
          }
          sentTurns.set(rpc.id, { method, deliveryId: request.delivery_id });
          if (active) active.items.associate(rpc.id, request);
          else starting = { id: rpc.id, request };
          return Result.succeed(undefined);
        },
      ),
    );
    const receipt = yield* receipts
      .find(threadId, request.delivery_id)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const accepted = receipt && ({ status: "accepted", receipt } as const);
    if (result._tag === "Failure")
      return result.failure instanceof AdapterError
        ? (accepted ?? failedAction(result.failure))
        : result.failure;
    if (accepted) return accepted;
    if (turn) {
      const reply = yield* Effect.result(
        Schema.decodeUnknownEffect(SteerReply)(result.success),
      );
      if (reply._tag === "Failure" || reply.success.turnId !== turn)
        return inDoubt(
          "unknown",
          "invalid-steer",
          "Codex did not confirm the expected turn",
        );
    } else {
      const reply = yield* Effect.result(
        Schema.decodeUnknownEffect(TurnReply)(result.success),
      );
      if (reply._tag === "Failure")
        return inDoubt(
          "unknown",
          "invalid-start",
          "Codex did not identify the started turn",
        );
    }
    return receipts.enabled ? waitingReceipt : noReceipt;
  });

  const interrupt = Effect.fn("app-server.interrupt")(function* (
    request: InterruptRequest,
  ): Effect.fn.Return<ControlOutcome<"turn">> {
    const preflight = checkTurn(request.expected, active?.id ?? null);
    if (preflight) return preflight;
    const rpc = yield* transport.request("turn/interrupt", {
      threadId,
      turnId: request.expected.turn,
    });
    const result = yield* Effect.result(
      awaitReply<ControlOutcome<"turn">>(rpc, "turn/interrupt", () => {
        const rejected = checkTurn(request.expected, active?.id ?? null);
        return rejected ? Result.fail(rejected) : Result.succeed(undefined);
      }),
    );
    if (result._tag === "Failure")
      return result.failure instanceof AdapterError
        ? failedAction(result.failure)
        : result.failure;
    const ack = yield* Effect.result(
      Schema.decodeUnknownEffect(InterruptReply)(result.success),
    );
    return ack._tag === "Success"
      ? { status: "applied" }
      : inDoubt(
          "unknown",
          "invalid-interrupt",
          "Codex did not confirm interrupt",
        );
  });

  const answer = makeAnswer(prompts, (prompt, answer) =>
    prepareAnswer(prompt.wire, answer).pipe(
      Effect.map(
        (planned) =>
          planned && {
            wire: { id: prompt.id, result: planned.result },
            publicAnswer: planned.publicAnswer,
          },
      ),
    ),
  );

  return {
    mode: "own" as const,
    getCheckpoint: () => threadId,
    getUnknownPayloadCount,
    recoveredReceipts: receipts.recovered,
    events: events.events,
    unsubscribe: events.unsubscribe,
    steer,
    interrupt,
    answer,
    close,
  };
});
