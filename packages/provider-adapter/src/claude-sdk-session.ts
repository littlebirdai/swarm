import { parseCanonicalEvent } from "@codecast/edge-contract";
import type {
  AnswerRequest,
  ControlOutcome,
  DeliveryOutcome,
  InterruptRequest,
  ResumeSpec,
  RunFence,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  describePrompt,
  prepareAnswer,
  reply,
  type PromptDetails,
} from "./claude-sdk-prompts";
import {
  Checkpoint,
  Frame,
  Initialized,
  OpenOptions,
  type Prompt,
} from "./claude-sdk-schema";
import {
  closed,
  inDoubt,
  refused,
  type ProviderAdapterOptions,
} from "./options";
import {
  diagnostic,
  makeProviderEvents,
  pendingPromptLimit,
  type DurablePayload,
} from "./provider-events";
import { promptBlocks } from "./provider-input";
import {
  AdapterError,
  bestEffortReplies,
  ownProviderProcess,
  processError,
  rawFrames,
} from "./provider-process";
import { providerWire, type ProviderFrame } from "./provider-wire";
import { claudeTurns } from "./claude-sdk-turns";

const name = "Claude SDK";
const noReceipt = inDoubt(
  "best-effort",
  "no-receipt",
  "Claude SDK does not record delivery IDs",
);
const noAnswerAck = inDoubt(
  "best-effort",
  "no-control-ack",
  "Claude SDK does not acknowledge the prompt reply",
);
const interruptReply = Schema.Struct({
  still_queued: Schema.Array(Schema.String),
});

type PendingPrompt = {
  turn: string;
  wire: typeof Prompt.Type;
  details: PromptDetails;
};

export const openClaudeSdk = Effect.fn("claude-sdk.open")(function* (
  options: ProviderAdapterOptions,
  spec: StartSpec | ResumeSpec,
  scope: Scope.Closeable,
) {
  const settings = yield* Schema.decodeUnknownEffect(OpenOptions)(
    spec.options ?? {},
    {
      onExcessProperty: "error",
    },
  ).pipe(
    Effect.mapError((cause) =>
      processError("invalid-options", "Invalid Claude SDK options", cause),
    ),
  );
  const resume = "checkpoint" in spec;
  const checkpoint = resume
    ? yield* Schema.decodeUnknownEffect(Checkpoint)(spec.checkpoint).pipe(
        Effect.mapError((cause) =>
          processError(
            "invalid-options",
            "Invalid Claude SDK checkpoint",
            cause,
          ),
        ),
      )
    : crypto.randomUUID();
  const [binary, ...prefix] = options.command ?? ["claude"];
  const env = { ...(options.env ?? process.env) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = "1";
  const transport = yield* ownProviderProcess(
    { ...options, command: undefined, env },
    spec.cwd,
    scope,
    {
      name,
      command: [
        binary,
        ...prefix,
        "--output-format=stream-json",
        "--input-format=stream-json",
        "--verbose",
        "--permission-prompt-tool=stdio",
        `--${resume ? "resume" : "session-id"}=${checkpoint}`,
        `--permission-mode=${settings.permissionMode ?? "default"}`,
        ...(settings.model ? [`--model=${settings.model}`] : []),
        ...(settings.systemPrompt
          ? [`--system-prompt=${settings.systemPrompt}`]
          : []),
        ...(settings.appendSystemPrompt
          ? [`--append-system-prompt=${settings.appendSystemPrompt}`]
          : []),
      ],
    },
  );
  const events = yield* makeProviderEvents(name);
  const incoming = yield* providerWire(transport, scope, name);
  const replies = yield* bestEffortReplies(transport, scope);
  const raw = rawFrames(options, spec);
  const clock = yield* Clock.Clock;
  const prompts = new Map<string, PendingPrompt>();
  let seq = spec.afterSeq;
  let ready = false;
  let sessionClosed = false;

  const envelope = () => ({
    v: 1 as const,
    source: "provider" as const,
    session: spec.session,
    run: spec.run,
    at: clock.currentTimeMillisUnsafe(),
  });

  function durable(payload: DurablePayload, turn: string | null) {
    const stamp = envelope();
    return events
      .awaitSpace()
      .pipe(
        Effect.andThen(
          Effect.sync(() =>
            events.emit({ ...stamp, ...payload, turn, seq: ++seq }),
          ),
        ),
      );
  }

  const turns = claudeTurns(spec.run, checkpoint, durable, () =>
    prompts.clear(),
  );

  type Projection = ReturnType<typeof durable>[];
  const project = (work: Projection) =>
    Effect.forEach(work, (step) => step, { discard: true });

  const receive = Effect.fn("claude-sdk.receive")(function* ({
    line,
    base64Fragment,
  }: ProviderFrame) {
    if (!base64Fragment && !line.trim()) return;
    const parsed = base64Fragment
      ? undefined
      : yield* Effect.result(Schema.decodeUnknownEffect(Frame)(line));
    if (!parsed || parsed._tag === "Failure")
      return {
        work: raw.retain(line, "unknown", base64Fragment),
        acknowledge: Effect.void,
      };

    const frame = parsed.success;
    const work: Projection = [];
    let disposition: "decoded" | "replay" | "unknown" = "decoded";
    let acknowledge: Effect.Effect<unknown> = Effect.void;
    if (frame.type === "control_response") {
      const response = frame.response;
      const id = Number(response.request_id);
      const method =
        String(id) === response.request_id && transport.pendingMethod(id);
      if (method) {
        acknowledge =
          response.subtype === "success"
            ? transport.settle(id, response.response)
            : transport.settle(id, undefined, {
                code: -1,
                message: diagnostic(response.error),
              });
        if (method === "initialize")
          return {
            work: raw
              .retain(line, "decoded")
              .pipe(Effect.andThen(acknowledge), Effect.asVoid),
            acknowledge: Effect.void,
          };
      } else disposition = "replay";
    } else if (!ready) {
      disposition = "replay";
    } else if (frame.type === "control_request") {
      const id = frame.request_id;
      if (!turns.remember(`request:${id}`)) disposition = "replay";
      else {
        const key = `${spec.run}:claude-sdk:${id}`;
        const details = yield* describePrompt(frame, key);
        const turn = turns.active();
        if (!turn || prompts.size >= pendingPromptLimit || !details) {
          acknowledge = Effect.sync(() => {
            Queue.offerUnsafe(
              replies,
              reply(id, {
                behavior: "deny",
                message: "No active turn or supported prompt",
                toolUseID: frame.request.tool_use_id,
              }),
            );
          });
        } else {
          prompts.set(key, { turn, wire: frame, details });
          for (const event of details.events) work.push(durable(event, turn));
        }
      }
    } else if (frame.type === "control_cancel_request") {
      turns.remember(`request:${frame.request_id}`);
      prompts.delete(`${spec.run}:claude-sdk:${frame.request_id}`);
    } else if (!(yield* turns.receive(frame, work))) disposition = "replay";
    return {
      work: raw.retain(line, disposition).pipe(Effect.andThen(project(work))),
      acknowledge,
    };
  });

  yield* incoming.read(receive);
  yield* Effect.forkIn(
    incoming.stopped.pipe(
      Effect.catch((error) =>
        error.code === "channel-ended"
          ? Effect.void
          : Effect.promise(transport.release),
      ),
    ),
    scope,
  );
  yield* Effect.forkIn(
    incoming.projections.pipe(
      Stream.runForEach((work) => work),
      Effect.andThen(Effect.promise(() => transport.exit)),
      Effect.flatMap((reason) => {
        const work: Projection = [];
        turns.finish(reason, work);
        work.push(durable({ kind: "session.ended", body: { reason } }, null));
        return project(work).pipe(Effect.andThen(events.end));
      }),
      Effect.onExit((exit) => {
        sessionClosed = true;
        return exit._tag === "Failure"
          ? incoming
              .stop(processError("channel-ended", "Claude SDK output ended"))
              .pipe(
                Effect.andThen(events.fail(exit.cause)),
                Effect.andThen(Effect.promise(transport.release)),
              )
          : Effect.void;
      }),
      Effect.ignoreCause,
    ),
    scope,
  );
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      sessionClosed = true;
      prompts.clear();
      transport.fence();
    }).pipe(Effect.andThen(events.unsubscribe)),
  );

  function failedAction(error: AdapterError) {
    if (error.code === "channel-closed") return closed;
    if (error.code === "rpc-rejected" || error.code === "write-queue-timeout")
      return refused(error.code, error.message);
    return inDoubt("unknown", error.code, error.message);
  }

  const control = Effect.fn("claude-sdk.control")(function* <E = never>(
    method: "initialize" | "interrupt",
    prepare?: () => Result.Result<void, E>,
  ) {
    const rpc = yield* transport.request(method, {}, (id, subtype) => ({
      type: "control_request",
      request_id: String(id),
      request: { subtype },
    }));
    return yield* rpc
      .send<E | AdapterError>(() => {
        const failure = incoming.error();
        return failure
          ? Result.fail(failure)
          : (prepare?.() ?? Result.succeed(undefined));
      })
      .pipe(
        Effect.andThen(
          rpc.awaitResponse.pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  processError("timeout", `Claude SDK ${method} timed out`),
                ),
            }),
          ),
        ),
        Effect.raceFirst(incoming.stopped),
        Effect.ensuring(rpc.forget),
      );
  });

  const initialized = yield* control("initialize").pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(Initialized)(response).pipe(
        Effect.mapError((cause) =>
          processError(
            "initialize-failed",
            "Invalid Claude SDK initialize response",
            cause,
          ),
        ),
      ),
    ),
  );
  if (initialized.claude_code_version !== options.provider.version)
    return yield* processError(
      "agent-version",
      "Claude SDK reported a different version",
    );
  const failure = incoming.error();
  if (failure) return yield* failure;
  if (!events.open())
    return yield* processError(
      "event-overflow",
      "Claude SDK event stream ended before opening",
    );

  ready = true;

  const validFence = ({ run, fencing_token }: RunFence) =>
    run === spec.run && fencing_token === spec.fencing_token;
  const isClosed = () => sessionClosed || incoming.error() !== undefined;
  function checkTurn(expected: SteerRequest["expected"]) {
    if (isClosed()) return closed;
    const turn = turns.active();
    if (!validFence(expected) || expected.turn !== turn)
      return { status: "stale", observed: { kind: "turn", turn } } as const;
  }

  const steer = Effect.fn("claude-sdk.steer")(function* (
    request: SteerRequest,
  ): Effect.fn.Return<DeliveryOutcome> {
    const preflight = checkTurn(request.expected);
    if (preflight) return preflight;
    if (!request.input.length)
      return refused("empty-input", "Claude SDK prompt is empty");
    const prepared = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) => promptBlocks(request.input, signal, name),
        catch: () =>
          refused("invalid-input", "Could not read Claude SDK prompt input"),
      }),
    );
    if (prepared._tag === "Failure") return prepared.failure;
    const text = prepared.success
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const images = prepared.success.flatMap((part) =>
      part.type === "image"
        ? [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: part.mimeType,
                data: part.data,
              },
            },
          ]
        : [],
    );
    if (!text.trim() && !images.length)
      return refused("empty-input", "Claude SDK prompt is empty");

    const written = yield* Effect.result(
      transport
        .write<DeliveryOutcome>(() => {
          const rejected = checkTurn(request.expected);
          if (rejected) return Result.fail(rejected);
          if (turns.seenDelivery(request.delivery_id))
            return Result.fail(
              inDoubt(
                "unknown",
                "delivery-seen",
                "Claude SDK already attempted this delivery",
              ),
            );
          if (turns.awaitingTurn())
            return Result.fail(
              inDoubt(
                "unknown",
                "turn-pending",
                "Claude SDK has pending input",
              ),
            );
          const uuid = turns.send(request, text);
          return Result.succeed([
            {
              type: "user",
              uuid,
              origin: { kind: "human" },
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: images.length
                  ? [...images, ...(text ? [{ type: "text", text }] : [])]
                  : text,
              },
              ...(turns.active() ? { priority: "next" } : {}),
            },
          ]);
        })
        .pipe(Effect.raceFirst(incoming.stopped)),
    );
    return written._tag === "Success"
      ? noReceipt
      : written.failure instanceof AdapterError
        ? failedAction(written.failure)
        : written.failure;
  });

  const interrupt = Effect.fn("claude-sdk.interrupt")(function* (
    request: InterruptRequest,
  ): Effect.fn.Return<ControlOutcome<"turn">> {
    const preflight = checkTurn(request.expected);
    if (preflight) return preflight;
    const result = yield* Effect.result(
      control<ControlOutcome<"turn">>("interrupt", () => {
        const rejected = checkTurn(request.expected);
        return rejected ? Result.fail(rejected) : Result.succeed(undefined);
      }),
    );
    if (result._tag === "Failure")
      return result.failure instanceof AdapterError
        ? failedAction(result.failure)
        : result.failure;
    const ack = yield* Effect.result(
      Schema.decodeUnknownEffect(interruptReply)(result.success),
    );
    return ack._tag === "Success"
      ? { status: "applied" }
      : inDoubt(
          "unknown",
          "invalid-interrupt",
          "Claude SDK did not confirm interrupt",
        );
  });

  const answer = Effect.fn("claude-sdk.answer")(function* (
    request: AnswerRequest,
  ): Effect.fn.Return<ControlOutcome<"prompt">> {
    if (isClosed()) return closed;
    const { prompt_id } = request.expected;
    const pending = prompts.get(prompt_id);
    const planned =
      pending && validFence(request.expected)
        ? yield* prepareAnswer(pending.wire, pending.details, request.answer)
        : undefined;
    const sent = yield* Deferred.make<boolean>();
    const written = yield* Effect.result(
      transport
        .write<ControlOutcome<"prompt">>(() => {
          if (isClosed()) return Result.fail(closed);
          const prompt = prompts.get(prompt_id);
          if (!prompt || prompt !== pending || !validFence(request.expected))
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
              refused(
                "invalid-answer",
                "Answer does not match the Claude SDK prompt",
              ),
            );
          const settlement = {
            kind: "prompt.settled",
            body: { prompt_id, by: request.by, answer: planned.publicAnswer },
          } as const;
          if (
            !parseCanonicalEvent({
              ...envelope(),
              ...settlement,
              turn: prompt.turn,
              seq: seq + 1,
            }).ok
          )
            return Result.fail(
              refused(
                "invalid-answer",
                "Answer is not a canonical prompt settlement",
              ),
            );
          if (
            !incoming.offer(
              Deferred.await(sent).pipe(
                Effect.flatMap((wrote) =>
                  wrote ? durable(settlement, prompt.turn) : Effect.void,
                ),
              ),
            )
          )
            return Result.fail(
              refused("output-overflow", "Claude SDK event backlog is full"),
            );
          prompts.delete(prompt_id);
          return Result.succeed([
            reply(prompt.wire.request_id, planned.response),
          ]);
        })
        .pipe(
          Effect.raceFirst(incoming.stopped),
          Effect.tap(() => Deferred.succeed(sent, true)),
          Effect.ensuring(Deferred.succeed(sent, false)),
        ),
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
    getCheckpoint: turns.checkpoint,
    getUnknownPayloadCount: raw.getUnknownPayloadCount,
    recoveredReceipts: [],
    events: events.events,
    unsubscribe: events.unsubscribe,
    steer,
    interrupt,
    answer,
    close,
  };
});
