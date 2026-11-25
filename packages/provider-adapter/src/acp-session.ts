import type { CanonicalEvent } from "@codecast/edge-contract";
import type {
  AnswerRequest,
  ControlOutcome,
  DeliveryOutcome,
  InterruptRequest,
  ProviderEvent,
  ResumeSpec,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import { fail, type Done } from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { permissionChoice, promptBlocks } from "./acp-input";
import { processError, spawnAcp, AdapterError } from "./acp-process";
import {
  Initialize,
  LoadSession,
  NewSession,
  establishSession,
  Permission,
  PromptResult,
  RpcLine,
  SessionUpdate,
  Update,
  type RpcId,
} from "./acp-schema";
import {
  closed,
  inDoubt,
  refused,
  unsupported,
  type ProviderAdapterOptions,
  type RawProviderFrame,
} from "./options";

type DurablePayload = {
  [Kind in CanonicalEvent["kind"]]: Pick<
    Extract<CanonicalEvent, { kind: Kind }>,
    "kind" | "body"
  >;
}[CanonicalEvent["kind"]];
type Emit = (event: ProviderEvent) => void;
type Disposition = RawProviderFrame["disposition"];

interface Turn {
  readonly id: string;
  readonly rpcId: number;
  readonly request: SteerRequest;
  userText: string;
  userEmitted: boolean;
  assistantText: string;
  assistantIndex: number;
}

const bufferCapacity = 32;
const requestTimeout = "30 seconds";
const promptTimeout = "1 hour";
const maxMessageLength = 1024 * 1024;
export const openAcp = Effect.fn("acp.open")(function* (
  options: ProviderAdapterOptions,
  spec: StartSpec | ResumeSpec,
  scope: Scope.Closeable,
) {
  const transport = yield* Effect.acquireRelease(
    Effect.try({
      try: () => spawnAcp(options, spec.cwd),
      catch: (cause) =>
        processError("spawn-failed", "Could not start ACP process", cause),
    }),
    (transport) =>
      Effect.flatMap(Effect.promise(transport.release), (result) =>
        result.status === "failed"
          ? Effect.die(processError(result.code, result.message))
          : Effect.void,
      ),
  ).pipe(Scope.provide(scope));

  const events = yield* Queue.bounded<ProviderEvent, AdapterError | Done>(
    bufferCapacity,
  );
  const publisher = yield* Semaphore.make(1);
  let opened = false;
  let checkpoint = "checkpoint" in spec ? spec.checkpoint : undefined;
  let seq = spec.afterSeq;
  let unknownCount = 0;
  let turnNumber = 0;
  let turn: Turn | undefined;
  let subscriptionEnded = false;
  let overflowed = false;
  let sessionClosed = false;
  let runtimeEnded = false;
  let readerClaimed = false;
  const prompts = new Map<
    string,
    {
      id: RpcId;
      choices: typeof Permission.Type.options;
      turnId: string | null;
    }
  >();

  function publish(build: (emit: Emit) => void) {
    return Semaphore.withPermit(
      publisher,
      Effect.suspend(() => {
        const batch: ProviderEvent[] = [];
        build((event) => batch.push(event));
        if (
          subscriptionEnded ||
          overflowed ||
          sessionClosed ||
          batch.length === 0
        )
          return Effect.void;
        if (
          !opened &&
          Queue.sizeUnsafe(events) + batch.length > bufferCapacity
        ) {
          overflowed = true;
          Queue.failCauseUnsafe(events, overflow);
          return Effect.void;
        }
        return Effect.asVoid(Queue.offerAll(events, batch));
      }),
    );
  }

  function durable(
    emit: Emit,
    payload: DurablePayload,
    turnId = turn?.id ?? null,
  ) {
    emit({
      ...payload,
      v: 1,
      source: "provider",
      session: spec.session,
      run: spec.run,
      turn: turnId,
      seq: ++seq,
      at: Date.now(),
    });
  }

  function flushUser(emit: Emit, active: Turn) {
    if (active.userEmitted || !active.userText) return;
    active.userEmitted = true;
    const { input, authors, delivery_id } = active.request;
    const expectedText = input
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    durable(emit, {
      kind: "message.user",
      body: {
        text: active.userText,
        authors: [...authors],
        ...(active.userText === expectedText ? { delivery_id } : {}),
      },
    });
    active.userText = "";
  }

  function messageId(active: Turn) {
    return `${active.id}:assistant:${active.assistantIndex}`;
  }

  function flushAssistant(emit: Emit, active: Turn) {
    if (!active.assistantText) return;
    durable(emit, {
      kind: "message.assistant",
      body: { message_id: messageId(active), text: active.assistantText },
    });
    active.assistantIndex++;
    active.assistantText = "";
  }

  function assistantChunk(emit: Emit, active: Turn, text: string) {
    flushUser(emit, active);
    if (active.assistantText.length + text.length > maxMessageLength)
      flushAssistant(emit, active);
    emit({
      v: 1,
      source: "provider",
      session: spec.session,
      run: spec.run,
      at: Date.now(),
      turn: active.id,
      kind: "message.delta",
      body: {
        message_id: messageId(active),
        text,
        offset: active.assistantText.length,
      },
    });
    active.assistantText += text;
  }

  function finishTurn(emit: Emit, active: Turn, reason: string) {
    if (turn !== active) return;
    flushUser(emit, active);
    flushAssistant(emit, active);
    durable(emit, { kind: "turn.ended", body: { reason } });
    turn = undefined;
    prompts.clear();
  }

  function project(emit: Emit, update: typeof SessionUpdate.Type) {
    switch (update.sessionUpdate) {
      case "available_commands_update":
        durable(emit, {
          kind: "context",
          body: { data: { availableCommands: [...update.availableCommands] } },
        });
        return;
      case "model_changed":
        durable(emit, {
          kind: "context",
          body: { data: { model: update.model_id } },
        });
        return;
      case "tool_call":
        if (turn) {
          flushUser(emit, turn);
          flushAssistant(emit, turn);
        }
        durable(emit, {
          kind: "tool.call",
          body: {
            call_id: update.toolCallId,
            name: update.title,
            input: update.rawInput ?? null,
          },
        });
        return;
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed")
          durable(emit, {
            kind: "tool.result",
            body: {
              call_id: update.toolCallId,
              output: {
                inline: update.rawOutput ?? [...(update.content ?? [])],
              },
              is_error: update.status === "failed",
            },
          });
        return;
      case "user_message_chunk":
        if (
          !turn ||
          turn.userEmitted ||
          turn.userText.length + update.content.text.length > maxMessageLength
        )
          return;
        turn.userText += update.content.text;
        return;
      case "agent_message_chunk":
        if (!turn) return;
        assistantChunk(emit, turn, update.content.text);
        return;
      case "turn_completed":
        if (
          turn &&
          turn.assistantIndex === 0 &&
          !turn.assistantText &&
          update.agent_result
        )
          assistantChunk(emit, turn, update.agent_result);
        return;
    }
  }

  const retain = Effect.fn("acp.retain")(function* (
    line: string,
    disposition: Disposition,
    base64Fragment?: RawProviderFrame["base64Fragment"],
  ) {
    if (
      disposition === "unknown" &&
      (!base64Fragment || base64Fragment.index === 0)
    )
      unknownCount++;
    yield* Effect.promise(async (signal) =>
      options.retainRaw(
        {
          session: spec.session,
          run: spec.run,
          line,
          disposition,
          ...(base64Fragment ? { base64Fragment } : {}),
        },
        signal,
      ),
    );
  });

  const receive = Effect.fn("acp.receive")(function* ({
    line,
    base64Fragment,
  }: Pick<RawProviderFrame, "line" | "base64Fragment">) {
    if (base64Fragment) {
      yield* retain(line, "unknown", base64Fragment);
      return;
    }
    if (!line.trim()) return;
    const parsed = yield* Effect.result(
      Schema.decodeUnknownEffect(RpcLine)(line),
    );
    if (parsed._tag === "Failure") {
      yield* retain(line, "unknown");
      return;
    }

    const { id, method, params, result, error } = parsed.success;
    if (!method && id !== undefined) {
      const requestMethod = transport.pendingMethod(id);
      if (!requestMethod) {
        yield* retain(line, "unknown");
        return;
      }

      if (requestMethod === "session/prompt") {
        const decoded = yield* Effect.result(
          Schema.decodeUnknownEffect(PromptResult)(result),
        );
        yield* retain(
          line,
          error || decoded._tag === "Success" ? "decoded" : "unknown",
        );
        const active = turn;
        if (active?.rpcId === id) {
          yield* publish((emit) => {
            if (error || decoded._tag === "Failure")
              durable(emit, {
                kind: "error",
                body: {
                  class: "acp-prompt",
                  message: error?.message ?? "ACP did not report a stop reason",
                  retryable: false,
                },
              });
            if (error || decoded._tag === "Success")
              finishTurn(
                emit,
                active,
                error
                  ? "rpc-rejected"
                  : decoded._tag === "Success"
                    ? decoded.success.stopReason
                    : "unknown",
              );
          });
        }
      } else {
        const schema =
          requestMethod === "initialize"
            ? Initialize
            : requestMethod === "session/new"
              ? NewSession
              : LoadSession;
        const checked = yield* Effect.result(
          Schema.decodeUnknownEffect(schema)(result),
        );
        yield* retain(
          line,
          error || checked._tag === "Success" ? "decoded" : "unknown",
        );
      }
      yield* transport.settle(id, result, error);
    } else if (id !== undefined && method) {
      const permission = yield* Effect.result(
        Schema.decodeUnknownEffect(Permission)(params),
      );
      if (
        method === "session/request_permission" &&
        permission._tag === "Success" &&
        permission.success.sessionId === checkpoint &&
        permission.success.options.length > 0
      ) {
        const prompt_id = `${spec.run}:permission:${typeof id}:${id}`;
        const { toolCall, options } = permission.success;
        yield* retain(line, "decoded");
        yield* publish((emit) => {
          prompts.set(prompt_id, {
            id,
            choices: options,
            turnId: turn?.id ?? null,
          });
          durable(emit, {
            kind: "prompt.opened",
            body: {
              prompt_id,
              kind: "permission",
              tool_call_id:
                toolCall.toolCallId.length <= 256 && toolCall.toolCallId.trim()
                  ? toolCall.toolCallId
                  : undefined,
              tool_name:
                toolCall.title &&
                toolCall.title.length <= 128 &&
                toolCall.title.trim()
                  ? toolCall.title
                  : undefined,
            },
          });
        });
      } else {
        yield* retain(line, "unknown");
        yield* Effect.ignore(
          transport.write({
            id,
            error: { code: -32601, message: "Unsupported ACP client request" },
          }),
        );
      }
    } else if (
      method === "session/update" ||
      method === "_x.ai/session/update"
    ) {
      const update = yield* Effect.result(
        Schema.decodeUnknownEffect(Update)(params),
      );
      if (update._tag === "Success" && update.success._meta?.isReplay) {
        yield* retain(line, "replay");
        return;
      }
      if (
        update._tag === "Success" &&
        checkpoint &&
        update.success.sessionId === checkpoint
      ) {
        const decoded = yield* Effect.result(
          Schema.decodeUnknownEffect(SessionUpdate)(update.success.update),
        );
        if (decoded._tag === "Success") {
          const payload = decoded.success;
          const outOfTurn =
            !turn &&
            (payload.sessionUpdate === "user_message_chunk" ||
              payload.sessionUpdate === "agent_message_chunk");
          const oversizedUser =
            turn &&
            payload.sessionUpdate === "user_message_chunk" &&
            (turn.userEmitted ||
              turn.userText.length + payload.content.text.length >
                maxMessageLength);
          yield* retain(
            line,
            outOfTurn || oversizedUser ? "unknown" : "decoded",
          );
          if (!outOfTurn && !oversizedUser)
            yield* publish((emit) => project(emit, payload));
          return;
        }
      }
      yield* retain(line, "unknown");
    } else {
      yield* retain(line, "unknown");
    }
  });

  const pump = Stream.fromAsyncIterable(transport.frames(), (cause) =>
    cause instanceof AdapterError
      ? cause
      : processError("read-failed", "Could not read ACP output", cause),
  ).pipe(
    Stream.runForEach(receive),
    Effect.andThen(Effect.promise(() => transport.exit)),
    Effect.tap((reason) =>
      publish((emit) => {
        runtimeEnded = true;
        if (turn) finishTurn(emit, turn, reason);
        prompts.clear();
        durable(emit, { kind: "session.ended", body: { reason } });
      }).pipe(Effect.andThen(Queue.end(events))),
    ),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        runtimeEnded = true;
        if (exit._tag === "Failure") Queue.failCauseUnsafe(events, exit.cause);
        yield* transport.failPending(
          processError("channel-ended", "ACP output ended"),
        );
      }),
    ),
    Effect.ignoreCause,
  );
  yield* Effect.forkIn(pump, scope);
  const unsubscribe = Effect.sync(() => {
    subscriptionEnded = true;
  }).pipe(
    Effect.andThen(Queue.end(events)),
    Effect.andThen(Effect.ignoreCause(Queue.clear(events))),
    Effect.asVoid,
  );
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      sessionClosed = true;
      prompts.clear();
      transport.fence();
    }).pipe(Effect.andThen(unsubscribe)),
  );

  const roundTrip = Effect.fn("acp.roundTrip")(function* (
    method: string,
    params: object,
    timeout: typeof requestTimeout | typeof promptTimeout,
  ) {
    const request = yield* transport.request(method, params);
    return yield* Effect.andThen(request.send, request.awaitResponse).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(processError("timeout", `ACP ${method} timed out`)),
      }),
    );
  });

  const established = yield* Effect.result(
    establishSession(options, spec, roundTrip),
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
  const sessionId = established.success;
  checkpoint = sessionId;
  opened = true;

  function validFence(expected: { run: number; fencing_token: string }) {
    return (
      expected.run === spec.run && expected.fencing_token === spec.fencing_token
    );
  }

  function staleTurn() {
    return {
      status: "stale",
      observed: { kind: "turn", turn: turn?.id ?? null },
    } as const;
  }

  function checkSteer(request: SteerRequest) {
    if (sessionClosed || runtimeEnded) return closed;
    if (
      !validFence(request.expected) ||
      request.expected.turn !== (turn?.id ?? null)
    )
      return staleTurn();
    if (turn) return unsupported("steer-mid-turn");
    return undefined;
  }

  const steer = Effect.fn("acp.steer")(function* (
    request: SteerRequest,
  ): Effect.fn.Return<DeliveryOutcome> {
    const preflight = checkSteer(request);
    if (preflight) return preflight;
    const blocks = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) => promptBlocks(request.input, signal),
        catch: (error) => processError("input", String(error), error),
      }),
    );
    const afterRead = checkSteer(request);
    if (afterRead) return afterRead;
    if (blocks._tag === "Failure")
      return refused(blocks.failure.code, blocks.failure.message);
    if (blocks.success.length === 0)
      return refused("empty-input", "ACP prompt is empty");

    const rpc = yield* transport.request("session/prompt", {
      sessionId,
      prompt: blocks.success,
    });
    const beforeWrite = checkSteer(request);
    if (beforeWrite) {
      yield* rpc.discard;
      return beforeWrite;
    }
    const active: Turn = {
      id: `${spec.run}:${++turnNumber}`,
      rpcId: rpc.id,
      request,
      userText: "",
      userEmitted: false,
      assistantText: "",
      assistantIndex: 0,
    };
    turn = active;
    const start = publish((emit) =>
      durable(emit, { kind: "turn.started", body: {} }),
    );
    yield* Effect.forkIn(start, scope, { startImmediately: true });
    const sent = yield* Effect.result(rpc.send);
    if (sent._tag === "Failure") {
      const { code, message } = sent.failure;
      if (code === "channel-busy" || code === "channel-closed") {
        yield* publish((emit) => finishTurn(emit, active, "write-refused"));
        return code === "channel-busy" ? refused(code, message) : closed;
      }
      return inDoubt("unknown", code, message);
    }
    yield* Effect.forkIn(
      rpc.awaitResponse.pipe(
        Effect.timeoutOrElse({
          duration: promptTimeout,
          orElse: () =>
            publish((emit) => {
              if (turn === active)
                durable(emit, {
                  kind: "error",
                  body: {
                    class: "acp-prompt-timeout",
                    message: "ACP prompt timed out",
                    retryable: false,
                  },
                });
            }),
        }),
        Effect.ignore,
      ),
      scope,
    );
    return inDoubt(
      "best-effort",
      "no-receipt",
      "ACP does not record delivery IDs",
    );
  });

  const writeControl = (...messages: object[]) =>
    Effect.result(transport.write(...messages)).pipe(
      Effect.map((result) => {
        if (result._tag === "Success")
          return inDoubt(
            "best-effort",
            "no-control-ack",
            "ACP does not acknowledge this control write",
          );
        const { code, message } = result.failure;
        if (code === "channel-busy") return refused(code, message);
        if (code === "channel-closed") return closed;
        return inDoubt("unknown", code, message);
      }),
    );

  const interrupt = Effect.fn("acp.interrupt")(function* (
    request: InterruptRequest,
  ): Effect.fn.Return<ControlOutcome<"turn">> {
    if (sessionClosed || runtimeEnded) return closed;
    if (!validFence(request.expected) || request.expected.turn !== turn?.id)
      return staleTurn();
    const pendingPrompts = [...prompts].filter(
      ([, prompt]) => prompt.turnId === request.expected.turn,
    );
    for (const [id] of pendingPrompts) prompts.delete(id);
    const result = yield* writeControl(
      ...pendingPrompts.map(([, prompt]) => ({
        id: prompt.id,
        result: { outcome: { outcome: "cancelled" } },
      })),
      { method: "session/cancel", params: { sessionId } },
    );
    if (
      result.status === "refused" &&
      !sessionClosed &&
      turn?.id === request.expected.turn
    )
      for (const [id, prompt] of pendingPrompts) prompts.set(id, prompt);
    return result;
  });

  const answer = Effect.fn("acp.answer")(function* (
    request: AnswerRequest,
  ): Effect.fn.Return<ControlOutcome<"prompt">> {
    if (sessionClosed || runtimeEnded) return closed;
    const { prompt_id } = request.expected;
    const prompt = prompts.get(prompt_id);
    if (!validFence(request.expected) || !prompt) {
      return {
        status: "stale",
        observed: {
          kind: "prompt",
          run: spec.run,
          prompt_id: [...prompts.keys()].at(-1) ?? null,
        },
      };
    }
    const choice = permissionChoice(request.answer, prompt.choices);
    if (choice === undefined)
      return refused(
        "invalid-option",
        "Answer must select an available ACP permission option",
      );
    prompts.delete(prompt_id);
    const result = yield* writeControl({
      id: prompt.id,
      result: {
        outcome:
          choice === null
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: choice },
      },
    });
    if (
      result.status === "refused" &&
      !sessionClosed &&
      (turn?.id ?? null) === prompt.turnId
    )
      prompts.set(prompt_id, prompt);
    if (
      !sessionClosed &&
      !runtimeEnded &&
      result.status === "in-doubt" &&
      result.reason === "best-effort"
    ) {
      yield* publish((emit) =>
        durable(
          emit,
          {
            kind: "prompt.settled",
            body: { prompt_id, by: request.by, answer: request.answer },
          },
          prompt.turnId,
        ),
      );
    }
    return result;
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
    getCheckpoint: () => sessionId,
    getUnknownPayloadCount: () => unknownCount,
    recoveredReceipts: [],
    events: Stream.unwrap(
      Effect.gen(function* () {
        if (readerClaimed || subscriptionEnded) return Stream.empty;
        readerClaimed = true;
        yield* Effect.addFinalizer(() => unsubscribe);
        return Stream.fromQueue(events);
      }),
    ),
    unsubscribe,
    steer,
    interrupt,
    answer,
    close,
  };
});

const overflow = fail(
  processError("event-overflow", "ACP event buffer is full"),
);
