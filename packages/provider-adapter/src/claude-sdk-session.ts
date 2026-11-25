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
  UnhandledRequest,
  OpenOptions,
  type Prompt,
} from "./claude-sdk-schema";
import { inDoubt, refused, type ProviderAdapterOptions } from "./options";
import { diagnostic, pendingPromptLimit } from "./provider-events";
import { promptBlocks } from "./provider-input";
import {
  AdapterError,
  ownProviderProcess,
  processError,
  rawFrames,
} from "./provider-process";
import type { ProviderFrame } from "./provider-wire";
import { failedAction, project, providerSession } from "./provider-session";
import { claudeTurns } from "./claude-sdk-turns";

const name = "Claude SDK";
const noReceipt = inDoubt(
  "best-effort",
  "no-receipt",
  "Claude SDK does not record delivery IDs",
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
      framing: "stream-json",
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
  const {
    events,
    incoming,
    start,
    establish,
    awaitReply,
    durable,
    checkTurn,
    close,
    answer: makeAnswer,
    respond,
  } = yield* providerSession(spec, transport, scope, name);
  const raw = rawFrames(options, spec);
  const prompts = new Map<string, PendingPrompt>();
  let ready = false;

  const turns = claudeTurns(spec.run, checkpoint, durable, () =>
    prompts.clear(),
  );

  type Projection = ReturnType<typeof durable>[];
  const rejectRequest = (request_id: string, error: string) =>
    respond({
      type: "control_response",
      response: { subtype: "error", request_id, error },
    });
  const receive = Effect.fn("claude-sdk.receive")(function* ({
    line,
    base64Fragment,
  }: ProviderFrame) {
    const parsed = base64Fragment
      ? undefined
      : yield* Effect.result(Schema.decodeUnknownEffect(Frame)(line));
    if (!parsed || parsed._tag === "Failure") {
      const unhandled = base64Fragment
        ? undefined
        : yield* Effect.result(
            Schema.decodeUnknownEffect(UnhandledRequest)(line),
          );
      return {
        work: raw.retain(line, "unknown", base64Fragment),
        acknowledge:
          unhandled?._tag === "Success"
            ? rejectRequest(
                unhandled.success.request_id,
                "Unsupported Claude SDK request",
              )
            : Effect.void,
      };
    }

    const frame = parsed.success;
    const work: Projection = [];
    let disposition: "decoded" | "replay" | "unknown" = "decoded";
    let acknowledge: Effect.Effect<unknown> = Effect.void;
    if (frame.type === "control_response") {
      const response = frame.response;
      const id = Number(response.request_id);
      const method =
        String(id) === response.request_id && transport.pendingMethod(id);
      if (!method) disposition = "replay";
      else if (response.subtype === "error")
        acknowledge = transport.settle(id, undefined, {
          code: -1,
          message: diagnostic(response.error),
        });
      else {
        const valid =
          method === "initialize"
            ? yield* Effect.result(
                Schema.decodeUnknownEffect(Initialized)(response.response),
              )
            : yield* Effect.result(
                Schema.decodeUnknownEffect(interruptReply)(response.response),
              );
        let error: AdapterError | undefined;
        if (valid._tag === "Failure") {
          disposition = "unknown";
          error =
            method === "initialize"
              ? processError(
                  "initialize-failed",
                  "Invalid Claude SDK initialize response",
                )
              : processError(
                  "invalid-interrupt",
                  "Claude SDK did not confirm interrupt",
                );
        } else if ("claude_code_version" in valid.success) {
          if (valid.success.claude_code_version === options.provider.version)
            ready = true;
          else
            error = processError(
              "agent-version",
              "Claude SDK reported a different version",
            );
        }
        acknowledge = transport.settle(id, response.response, error);
      }
    } else if (!ready) {
      disposition = "replay";
    } else if (frame.type === "control_request") {
      const id = frame.request_id;
      if (!turns.remember(`request:${id}`)) disposition = "replay";
      else {
        const key = `${spec.run}:claude-sdk:${id}`;
        const details = yield* describePrompt(frame, key);
        const turn = turns.active();
        if (!details) {
          disposition = "unknown";
          acknowledge = rejectRequest(id, "Invalid Claude SDK prompt");
        } else if (!turn || prompts.size >= pendingPromptLimit) {
          if (!turn) disposition = "replay";
          acknowledge = rejectRequest(id, "No active turn or prompt capacity");
        } else {
          prompts.set(key, { turn, wire: frame, details });
          for (const event of details.events) work.push(durable(event, turn));
        }
      }
    } else if (frame.type === "control_cancel_request") {
      turns.remember(`request:${frame.request_id}`);
      if (!prompts.delete(`${spec.run}:claude-sdk:${frame.request_id}`))
        disposition = "replay";
    } else if (!(yield* turns.receive(frame, work))) disposition = "replay";
    return {
      work: raw.retain(line, disposition).pipe(Effect.andThen(project(work))),
      acknowledge,
    };
  });

  const projector = yield* start(receive, (reason) => {
    const work: Projection = [];
    turns.finish(reason, work);
    return project(work);
  });

  const control = Effect.fn("claude-sdk.control")(function* <E = never>(
    method: "initialize" | "interrupt",
    prepare?: () => Result.Result<void, E>,
  ) {
    const rpc = yield* transport.request(method, {}, (id, subtype) => ({
      type: "control_request",
      request_id: String(id),
      request: { subtype },
    }));
    return yield* awaitReply(rpc, method, prepare);
  });
  yield* establish(projector, control("initialize"));

  const steer = Effect.fn("claude-sdk.steer")(function* (
    request: SteerRequest,
  ): Effect.fn.Return<DeliveryOutcome> {
    const preflight = checkTurn(request.expected, turns.active());
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
          const rejected = checkTurn(request.expected, turns.active());
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
    const preflight = checkTurn(request.expected, turns.active());
    if (preflight) return preflight;
    const result = yield* Effect.result(
      control<ControlOutcome<"turn">>("interrupt", () => {
        const rejected = checkTurn(request.expected, turns.active());
        return rejected ? Result.fail(rejected) : Result.succeed(undefined);
      }),
    );
    if (result._tag === "Failure")
      return result.failure instanceof AdapterError
        ? failedAction(result.failure)
        : result.failure;
    return { status: "applied" };
  });

  const answer = makeAnswer(prompts, (prompt, answer) =>
    prepareAnswer(prompt.wire, prompt.details, answer).pipe(
      Effect.map(
        (planned) =>
          planned && {
            wire: reply(prompt.wire.request_id, planned.response),
            publicAnswer: planned.publicAnswer,
          },
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
