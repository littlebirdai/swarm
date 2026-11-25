import type {
  AnswerRequest,
  ControlOutcome,
  DeliveryOutcome,
  InterruptRequest,
  ResumeSpec,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { turnItems, wireInput, type DurablePayload } from "./app-server-items";
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
import {
  diagnostic,
  describePrompt,
  prepareAnswer,
} from "./app-server-prompts";
import {
  closed,
  inDoubt,
  refused,
  type ProviderAdapterOptions,
  type RawProviderFrame,
} from "./options";
import { makeProviderEvents, pendingPromptLimit } from "./provider-events";
import {
  AdapterError,
  processError,
  rawFrames,
  ownProviderProcess,
  bestEffortReplies,
  type RpcId,
} from "./provider-process";

type ServerPrompt = { id: RpcId; turn: string; wire: typeof Prompt.Type };
type Frame = Pick<RawProviderFrame, "line" | "base64Fragment">;
const dialect = {
  name: "Codex app-server",
  command: ["codex", "app-server"],
} as const;
const noReceipt = inDoubt(
  "best-effort",
  "no-receipt",
  "Codex app-server does not record delivery IDs",
);
const noAnswerAck = inDoubt(
  "best-effort",
  "no-control-ack",
  "Codex app-server does not acknowledge the prompt reply",
);
const rememberedTurns = 4_096;

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
  const transport = yield* ownProviderProcess(
    options,
    spec.cwd,
    scope,
    dialect,
  );

  const events = yield* makeProviderEvents(dialect.name);
  const replies = yield* bestEffortReplies(transport, scope);
  const { retain, getUnknownPayloadCount } = rawFrames(options, spec);
  const clock = yield* Clock.Clock;
  const prompts = new Map<string, ServerPrompt>();
  const completed = new Set<string>();
  let seq = spec.afterSeq;
  let checkpoint: string | undefined;
  let opening = true;
  let sessionClosed = false;
  let starting: { id: number; request: SteerRequest } | undefined;
  let active: { id: string; items: ReturnType<typeof turnItems> } | undefined;
  let unlocatedTurn = false;
  const envelope = () => ({
    v: 1 as const,
    source: "provider" as const,
    session: spec.session,
    run: spec.run,
    at: clock.currentTimeMillisUnsafe(),
  });

  function durable(payload: DurablePayload, turn = active?.id ?? null) {
    events.emit({ ...payload, ...envelope(), turn, seq: ++seq });
  }

  function begin(turn: string) {
    if (active || completed.has(turn)) return;
    const items = turnItems(
      (payload) => durable(payload, turn),
      (body) =>
        events.emit({ ...envelope(), turn, kind: "message.delta", body }),
    );
    if (starting) items.associate(starting.id, starting.request);
    starting = undefined;
    unlocatedTurn = false;
    active = { id: turn, items };
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

  function promptId(id: RpcId) {
    return `${spec.run}:app-server:${typeof id}:${id}`;
  }

  function rejectRequest(id: RpcId, code: number, message: string) {
    Queue.offerUnsafe(replies, { id, error: { code, message } });
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
      yield* retain(line, "unknown");
      rejectRequest(id, -32601, "Unsupported app-server client request");
      return;
    }
    const wire = parsed.success;
    const turn = active?.id;
    if (
      opening ||
      wire.params.threadId !== checkpoint ||
      wire.params.turnId !== turn
    ) {
      yield* retain(line, "replay");
      rejectRequest(id, -32602, "Prompt does not belong to the active turn");
      return;
    }
    yield* retain(line, "decoded");
    yield* events.awaitSpace();
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
    error?: { code: number; message: string },
  ) {
    const method =
      transport.pendingMethod(id) ??
      (starting?.id === id ? "turn/start" : undefined);
    const schema: Schema.Codec<unknown> | undefined =
      method && Object.hasOwn(responseSchemas, method)
        ? responseSchemas[method as keyof typeof responseSchemas]
        : undefined;
    if (!schema) {
      yield* retain(line, "unknown");
      return;
    }
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(schema)(result),
    );
    yield* retain(
      line,
      error || decoded._tag === "Success" ? "decoded" : "unknown",
    );
    if (typeof id === "number") {
      if (error) {
        if (starting?.id === id) starting = undefined;
        active?.items.reject(id);
      } else if (starting?.id === id && method === "turn/start") {
        const reply = yield* Effect.result(
          Schema.decodeUnknownEffect(TurnReply)(result),
        );
        if (reply._tag === "Success") {
          yield* events.awaitSpace();
          if (starting?.id === id) begin(reply.success.turn.id);
        }
      }
    }
    yield* transport.settle(id, result, error);
  });

  const receive = Effect.fn("app-server.receive")(function* ({
    line,
    base64Fragment,
  }: Frame) {
    const turn = active;
    if (base64Fragment) return yield* retain(line, "unknown", base64Fragment);
    if (!line.trim()) return;
    const parsed = yield* Effect.result(
      Schema.decodeUnknownEffect(RpcLine)(line),
    );
    if (parsed._tag === "Failure") return yield* retain(line, "unknown");
    const { id, method, params, result, error } = parsed.success;
    if (id !== undefined) {
      return yield* method
        ? receivePrompt(line, id, method, params)
        : receiveResponse(line, id, result, error);
    }
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(Notification)({ method, params }),
    );
    if (decoded._tag === "Failure") return yield* retain(line, "unknown");
    const event = decoded.success;
    if (event.method === "thread/started") {
      return yield* retain(
        line,
        checkpoint && event.params.thread.id !== checkpoint
          ? "replay"
          : "decoded",
      );
    }
    if (opening || event.params.threadId !== checkpoint)
      return yield* retain(line, "replay");
    if (
      ("turnId" in event.params && event.params.turnId !== turn?.id) ||
      (event.method === "turn/started" &&
        (completed.has(event.params.turn.id) ||
          (!starting &&
            !unlocatedTurn &&
            event.params.turn.id !== turn?.id))) ||
      (event.method === "turn/completed" && event.params.turn.id !== turn?.id)
    ) {
      return yield* retain(line, "replay");
    }
    yield* retain(line, "decoded");
    yield* events.awaitSpace();
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
        finish(
          event.params.turn.status,
          event.params.turn.status === "failed"
            ? (event.params.turn.error?.message ?? "Codex turn failed")
            : undefined,
        );
        break;
      case "item/started":
      case "item/completed":
        turn?.items.project(
          event.params.item,
          event.method === "item/completed",
        );
        break;
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

  const pump = Stream.fromAsyncIterable(transport.frames(), (cause) =>
    cause instanceof AdapterError
      ? cause
      : processError("read-failed", "Could not read app-server output", cause),
  ).pipe(
    Stream.runForEach(receive),
    Effect.andThen(Effect.promise(() => transport.exit)),
    Effect.tap((reason) =>
      events.awaitSpace().pipe(
        Effect.andThen(
          Effect.sync(() => {
            sessionClosed = true;
            finish(reason);
            prompts.clear();
            durable({ kind: "session.ended", body: { reason } });
          }),
        ),
        Effect.andThen(events.end),
      ),
    ),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        sessionClosed = true;
        if (exit._tag === "Failure") yield* events.fail(exit.cause);
        yield* transport.failPending(
          processError("channel-ended", "Codex app-server output ended"),
        );
      }),
    ),
    Effect.ignoreCause,
  );
  yield* Effect.forkIn(pump, scope);
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      sessionClosed = true;
      prompts.clear();
      transport.fence();
    }).pipe(Effect.andThen(events.unsubscribe)),
  );

  type Request = Effect.Success<ReturnType<typeof transport.request>>;

  function awaitReply<E = never>(
    rpc: Request,
    method: string,
    prepare?: () => Result.Result<void, E>,
  ) {
    return Effect.andThen(
      rpc.send(prepare),
      rpc.awaitResponse.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.fail(processError("timeout", `Codex ${method} timed out`)),
        }),
      ),
    ).pipe(Effect.ensuring(rpc.forget));
  }

  const roundTrip = Effect.fn("app-server.round-trip")(function* (
    method: string,
    params: object,
  ) {
    return yield* awaitReply(yield* transport.request(method, params), method);
  });

  const established = yield* Effect.result(
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
      yield* transport.write(() => Result.succeed([{ method: "initialized" }]));
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
      if (sessionClosed || !events.open())
        return yield* processError(
          "event-overflow",
          "Codex app-server event stream ended before opening",
        );
      return thread;
    }),
  );
  if (established._tag === "Failure") {
    yield* Effect.exit(Scope.close(scope, Exit.void));
    const cleanup = yield* Effect.promise(transport.release);
    if (cleanup.status === "failed")
      return yield* processError(
        "cleanup-uncertain",
        cleanup.message,
        established.failure,
      );
    return yield* established.failure;
  }
  const { thread, sandbox } = established.success;
  const threadId = thread.id;
  checkpoint = threadId;
  opening = false;
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

  function validFence(expected: { run: number; fencing_token: string }) {
    return (
      expected.run === spec.run && expected.fencing_token === spec.fencing_token
    );
  }

  function checkTurn(expected: SteerRequest["expected"]) {
    if (sessionClosed) return closed;
    const turn = active?.id ?? null;
    if (!validFence(expected) || expected.turn !== turn)
      return { status: "stale", observed: { kind: "turn", turn } } as const;
  }

  function failedAction(error: AdapterError) {
    switch (error.code) {
      case "channel-closed":
        return closed;
      case "rpc-rejected":
      case "write-queue-timeout":
        return refused(error.code, error.message);
      default:
        return inDoubt("unknown", error.code, error.message);
    }
  }

  const steer = Effect.fn("app-server.steer")(function* (
    request: SteerRequest,
  ): Effect.fn.Return<DeliveryOutcome> {
    const preflight = checkTurn(request.expected);
    if (preflight) return preflight;
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
    const rpc = yield* transport.request(
      turn ? "turn/steer" : "turn/start",
      turn
        ? { threadId, expectedTurnId: turn, input }
        : { threadId, input, ...(sandbox ? { sandboxPolicy: sandbox } : {}) },
    );
    const result = yield* Effect.result(
      awaitReply<DeliveryOutcome>(
        rpc,
        turn ? "turn/steer" : "turn/start",
        () => {
          const rejected = checkTurn(request.expected);
          if (rejected) return Result.fail(rejected);
          if (starting || unlocatedTurn)
            return Result.fail(
              inDoubt(
                "unknown",
                "turn-pending",
                "Codex has not identified the active turn",
              ),
            );
          if (active) active.items.associate(rpc.id, request);
          else starting = { id: rpc.id, request };
          return Result.succeed(undefined);
        },
      ),
    );
    if (result._tag === "Failure")
      return result.failure instanceof AdapterError
        ? failedAction(result.failure)
        : result.failure;
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
    return noReceipt;
  });

  const interrupt = Effect.fn("app-server.interrupt")(function* (
    request: InterruptRequest,
  ): Effect.fn.Return<ControlOutcome<"turn">> {
    const preflight = checkTurn(request.expected);
    if (preflight) return preflight;
    const rpc = yield* transport.request("turn/interrupt", {
      threadId,
      turnId: request.expected.turn,
    });
    const result = yield* Effect.result(
      awaitReply<ControlOutcome<"turn">>(rpc, "turn/interrupt", () => {
        const rejected = checkTurn(request.expected);
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

  const answer = Effect.fn("app-server.answer")(function* (
    request: AnswerRequest,
  ): Effect.fn.Return<ControlOutcome<"prompt">> {
    if (sessionClosed) return closed;
    const { prompt_id } = request.expected;
    const pending = prompts.get(prompt_id);
    const planned =
      pending && validFence(request.expected)
        ? yield* prepareAnswer(pending.wire, request.answer)
        : undefined;
    const written = yield* Effect.result(
      transport.write<ControlOutcome<"prompt">>(() => {
        if (sessionClosed) return Result.fail(closed);
        const prompt = prompts.get(prompt_id);
        if (prompt !== pending || !prompt || !validFence(request.expected))
          return Result.fail({
            status: "stale",
            observed: {
              kind: "prompt",
              run: spec.run,
              prompt_id: [...prompts.keys()].at(-1) ?? null,
            },
          });
        if (!planned)
          return Result.fail(
            refused("invalid-answer", "Answer does not match the Codex prompt"),
          );
        prompts.delete(prompt_id);
        durable(
          {
            kind: "prompt.settled",
            body: { prompt_id, by: request.by, answer: planned.publicAnswer },
          },
          prompt.turn,
        );
        return Result.succeed([{ id: prompt.id, result: planned.result }]);
      }),
    );
    return written._tag === "Success"
      ? noAnswerAck
      : written.failure instanceof AdapterError
        ? failedAction(written.failure)
        : written.failure;
  });

  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.sync(() => {
        sessionClosed = true;
        transport.fence();
      }).pipe(
        Effect.andThen(Effect.exit(Scope.close(scope, Exit.void))),
        Effect.andThen(Effect.promise(transport.release)),
      ),
    ),
  );

  return {
    mode: "own" as const,
    getCheckpoint: () => threadId,
    getUnknownPayloadCount,
    recoveredReceipts: [],
    events: events.events,
    unsubscribe: events.unsubscribe,
    steer,
    interrupt,
    answer,
    close,
  };
});
