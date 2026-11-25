import { existsSync } from "node:fs";
import type { CanonicalEvent } from "@codecast/edge-contract";
import type {
  AnswerRequest,
  ControlOutcome,
  DeliveryOutcome,
  InterruptRequest,
  ResumeSpec,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import { withoutSecrets } from "@codecast/secrets/secretShapes";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeAcpEvents, pendingPromptLimit, type Emit } from "./acp-events";
import { permissionChoice, permissionDisplay, promptBlocks } from "./acp-input";
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
      try: () => spawnAcp(options, spec.cwd, scope),
      catch: (cause) =>
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT" &&
        existsSync(spec.cwd)
          ? processError("binary-missing", "ACP executable was not found")
          : processError("spawn-failed", "Could not start ACP process", cause),
    }),
    (transport) =>
      Effect.flatMap(Effect.promise(transport.release), (result) =>
        result.status === "failed"
          ? Effect.die(processError(result.code, result.message))
          : Effect.void,
      ),
  ).pipe(Scope.provide(scope));

  const events = yield* makeAcpEvents();
  const replies = yield* Queue.dropping<object>(32);
  yield* Effect.forkIn(
    Effect.forever(
      Queue.take(replies).pipe(
        Effect.flatMap((reply) =>
          transport.write(() => Result.succeed([reply])),
        ),
        Effect.ignore,
      ),
    ),
    scope,
  );
  const clock = yield* Clock.Clock;
  const emit = events.emit;
  let checkpoint = "checkpoint" in spec ? spec.checkpoint : undefined;
  let seq = spec.afterSeq;
  let unknownCount = 0;
  let turnNumber = 0;
  let turn: Turn | undefined;
  let sessionClosed = false;
  let runtimeEnded = false;
  const prompts = new Map<
    string,
    {
      id: RpcId;
      choices: typeof Permission.Type.options;
      offered: ReturnType<typeof permissionDisplay>["options"];
      turnId: string | null;
    }
  >();

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
      at: clock.currentTimeMillisUnsafe(),
    });
  }

  function flushUser(emit: Emit, active: Turn) {
    if (active.userEmitted || !active.userText) return;
    active.userEmitted = true;
    const { input, authors, delivery_id } = active.request;
    const expectedText = input
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    durable(
      emit,
      {
        kind: "message.user",
        body: {
          text: active.userText,
          authors: [...authors],
          ...(active.userText === expectedText ? { delivery_id } : {}),
        },
      },
      active.id,
    );
    active.userText = "";
  }

  function messageId(active: Turn) {
    return `${active.id}:assistant:${active.assistantIndex}`;
  }

  function flushAssistant(emit: Emit, active: Turn) {
    if (!active.assistantText) return;
    durable(
      emit,
      {
        kind: "message.assistant",
        body: { message_id: messageId(active), text: active.assistantText },
      },
      active.id,
    );
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
      at: clock.currentTimeMillisUnsafe(),
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

  function project(
    emit: Emit,
    update: typeof SessionUpdate.Type,
    active: Turn | undefined,
  ) {
    const publish = (payload: DurablePayload) =>
      durable(emit, payload, active?.id ?? null);
    switch (update.sessionUpdate) {
      case "available_commands_update":
        publish({
          kind: "context",
          body: {
            data: { availableCommands: [...update.availableCommands] },
          },
        });
        return;
      case "model_changed":
        publish({
          kind: "context",
          body: { data: { model: update.model_id } },
        });
        return;
      case "tool_call":
        if (active) {
          flushUser(emit, active);
          flushAssistant(emit, active);
        }
        publish({
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
          publish({
            kind: "tool.result",
            body: {
              call_id: update.toolCallId,
              output: {
                inline:
                  update.rawOutput === undefined
                    ? [...(update.content ?? [])]
                    : update.rawOutput,
              },
              is_error: update.status === "failed",
            },
          });
        return;
      case "user_message_chunk":
        if (
          !active ||
          active.userEmitted ||
          active.userText.length + update.content.text.length > maxMessageLength
        )
          return;
        active.userText += update.content.text;
        return;
      case "agent_message_chunk":
        if (!active) return;
        assistantChunk(emit, active, update.content.text);
        return;
      case "turn_completed":
        if (
          active &&
          active.assistantIndex === 0 &&
          !active.assistantText &&
          update.agent_result
        )
          assistantChunk(emit, active, update.agent_result);
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
    const active = turn;
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
        yield* events.awaitSpace();
        if (active?.rpcId === id) {
          if (error || decoded._tag === "Failure")
            durable(emit, {
              kind: "error",
              body: {
                class: "acp-prompt",
                message: error
                  ? withoutSecrets(error.message)
                  : "ACP did not report a stop reason",
                retryable: false,
              },
            });
          finishTurn(
            emit,
            active,
            error
              ? "rpc-rejected"
              : decoded._tag === "Success"
                ? decoded.success.stopReason
                : "unknown",
          );
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
        const display = permissionDisplay(permission.success);
        yield* retain(line, "decoded");
        yield* events.awaitSpace();
        if (prompts.has(prompt_id)) return;
        if (prompts.size >= pendingPromptLimit) {
          Queue.offerUnsafe(replies, {
            id,
            result: { outcome: { outcome: "cancelled" } },
          });
          return;
        }
        prompts.set(prompt_id, {
          id,
          choices: permission.success.options,
          offered: display.options,
          turnId: active?.id ?? null,
        });
        durable(
          emit,
          {
            kind: "prompt.opened",
            body: {
              prompt_id,
              kind: "permission",
              ...display,
            },
          },
          active?.id ?? null,
        );
      } else {
        yield* retain(line, "unknown");
        Queue.offerUnsafe(replies, {
          id,
          error: { code: -32601, message: "Unsupported ACP client request" },
        });
      }
    } else if (
      method === "session/update" ||
      method === "_x.ai/session/update"
    ) {
      const update = yield* Effect.result(
        Schema.decodeUnknownEffect(Update)(params),
      );
      if (
        update._tag === "Success" &&
        checkpoint &&
        update.success.sessionId === checkpoint
      ) {
        if (update.success._meta?.isReplay) {
          yield* retain(line, "replay");
          return;
        }
        const decoded = yield* Effect.result(
          Schema.decodeUnknownEffect(SessionUpdate)(update.success.update),
        );
        if (decoded._tag === "Success") {
          const payload = decoded.success;
          const outOfTurn =
            !active &&
            (payload.sessionUpdate === "user_message_chunk" ||
              payload.sessionUpdate === "agent_message_chunk");
          const oversizedUser =
            active &&
            payload.sessionUpdate === "user_message_chunk" &&
            (active.userEmitted ||
              active.userText.length + payload.content.text.length >
                maxMessageLength);
          yield* retain(
            line,
            outOfTurn || oversizedUser ? "unknown" : "decoded",
          );
          if (!outOfTurn && !oversizedUser) {
            yield* events.awaitSpace();
            project(emit, payload, active);
          }
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
      events.awaitSpace().pipe(
        Effect.andThen(
          Effect.sync(() => {
            runtimeEnded = true;
            if (turn) finishTurn(emit, turn, reason);
            prompts.clear();
            durable(emit, { kind: "session.ended", body: { reason } });
          }),
        ),
        Effect.andThen(events.end),
      ),
    ),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        runtimeEnded = true;
        if (exit._tag === "Failure") yield* events.fail(exit.cause);
        yield* transport.failPending(
          processError("channel-ended", "ACP output ended"),
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

  const roundTrip = Effect.fn("acp.roundTrip")(function* (
    method: string,
    params: object,
    timeout: typeof requestTimeout | typeof promptTimeout,
  ) {
    const request = yield* transport.request(method, params);
    return yield* Effect.andThen(request.send(), request.awaitResponse).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(processError("timeout", `ACP ${method} timed out`)),
      }),
    );
  });

  const established = yield* Effect.result(
    establishSession(options, spec, roundTrip).pipe(
      Effect.flatMap((sessionId) =>
        events.open()
          ? Effect.succeed(sessionId)
          : Effect.fail(
              processError(
                "event-overflow",
                "ACP events overflowed before opening the session",
              ),
            ),
      ),
    ),
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
    const began = Deferred.makeUnsafe<Turn | undefined>();
    yield* Effect.forkIn(
      Deferred.await(began).pipe(
        Effect.flatMap((active) =>
          active
            ? rpc.awaitResponse.pipe(
                Effect.timeoutOrElse({
                  duration: promptTimeout,
                  orElse: () =>
                    Effect.sync(() => {
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
              )
            : Effect.void,
        ),
      ),
      scope,
    );
    const sent = yield* Effect.result(
      rpc
        .send(() => {
          const beforeWrite = checkSteer(request);
          if (beforeWrite) return Result.fail(beforeWrite);
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
          durable(emit, { kind: "turn.started", body: {} });
          Deferred.doneUnsafe(began, Effect.succeed(active));
          return Result.succeed(undefined);
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(began, Effect.succeed(undefined));
            }),
          ),
        ),
    );
    if (sent._tag === "Failure")
      return sent.failure instanceof AdapterError
        ? writeOutcome(sent.failure)
        : sent.failure;
    return inDoubt(
      "best-effort",
      "no-receipt",
      "ACP does not record delivery IDs",
    );
  });

  function writeOutcome({ code, message }: AdapterError) {
    if (code === "channel-closed") return closed;
    if (code === "write-queue-timeout") return refused(code, message);
    return inDoubt("unknown", code, message);
  }

  function writeControl<Failure>(
    plan: () => Result.Result<readonly object[], Failure>,
  ) {
    return Effect.suspend(() =>
      sessionClosed || runtimeEnded
        ? Effect.succeed(closed)
        : Effect.match(transport.write(plan), {
            onFailure: (error) =>
              error instanceof AdapterError ? writeOutcome(error) : error,
            onSuccess: () =>
              inDoubt(
                "best-effort",
                "no-control-ack",
                "ACP does not acknowledge this control write",
              ),
          }),
    );
  }

  const interrupt = Effect.fn("acp.interrupt")(
    (request: InterruptRequest): Effect.Effect<ControlOutcome<"turn">> =>
      writeControl<ControlOutcome<"turn">>(() => {
        if (sessionClosed || runtimeEnded) return Result.fail(closed);
        if (!validFence(request.expected) || request.expected.turn !== turn?.id)
          return Result.fail(staleTurn());
        const pendingPrompts = [...prompts].filter(
          ([, prompt]) => prompt.turnId === request.expected.turn,
        );
        for (const [id] of pendingPrompts) prompts.delete(id);
        return Result.succeed([
          ...pendingPrompts.map(([, prompt]) => ({
            id: prompt.id,
            result: { outcome: { outcome: "cancelled" } },
          })),
          { method: "session/cancel", params: { sessionId } },
        ]);
      }),
  );

  const answer = Effect.fn("acp.answer")(function* (
    request: AnswerRequest,
  ): Effect.fn.Return<ControlOutcome<"prompt">> {
    const { prompt_id } = request.expected;
    return yield* writeControl<ControlOutcome<"prompt">>(() => {
      if (sessionClosed || runtimeEnded) return Result.fail(closed);
      const prompt = prompts.get(prompt_id);
      if (!validFence(request.expected) || !prompt)
        return Result.fail({
          status: "stale",
          observed: {
            kind: "prompt",
            run: spec.run,
            prompt_id: [...prompts.keys()].at(-1) ?? null,
          },
        });
      const choice = permissionChoice(
        request.answer,
        prompt.choices,
        prompt.offered,
      );
      if (choice === undefined)
        return Result.fail(
          refused(
            "invalid-option",
            "Answer must select an available ACP permission option",
          ),
        );
      prompts.delete(prompt_id);
      durable(
        emit,
        {
          kind: "prompt.settled",
          body: { prompt_id, by: request.by, answer: request.answer },
        },
        prompt.turnId,
      );
      return Result.succeed([
        {
          id: prompt.id,
          result: {
            outcome:
              choice === null
                ? { outcome: "cancelled" }
                : { outcome: "selected", optionId: choice },
          },
        },
      ]);
    });
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
    events: events.events,
    unsubscribe: events.unsubscribe,
    steer,
    interrupt,
    answer,
    close,
  };
});
