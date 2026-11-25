import type { EdgeJson } from "@codecast/edge-contract";
import type { ResumeSpec, StartSpec } from "@codecast/provider-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AdapterError, processError } from "./acp-process";
import type { ProviderAdapterOptions } from "./options";

const identifier = Schema.String.check(Schema.isMinLength(1));
const rpcId = Schema.Union([Schema.Number, Schema.String]);

export const Rpc = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(rpcId),
  method: Schema.optionalKey(identifier),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({ code: Schema.Number, message: Schema.String }),
  ),
});

export const RpcLine = Schema.fromJsonString(Rpc);

export type RpcId = typeof rpcId.Type;

export const Initialize = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  agentInfo: Schema.optionalKey(
    Schema.Struct({ version: Schema.optionalKey(identifier) }),
  ),
  _meta: Schema.optionalKey(
    Schema.Struct({ agentVersion: Schema.optionalKey(identifier) }),
  ),
  agentCapabilities: Schema.optionalKey(
    Schema.Struct({ loadSession: Schema.optionalKey(Schema.Boolean) }),
  ),
});

export const LoadSession = Schema.NullOr(Schema.Struct({}));
export const NewSession = Schema.Struct({ sessionId: identifier });
export const PromptResult = Schema.Struct({ stopReason: identifier });

export const Update = Schema.Struct({
  sessionId: identifier,
  _meta: Schema.optionalKey(
    Schema.Struct({ isReplay: Schema.optionalKey(Schema.Boolean) }),
  ),
  update: Schema.Unknown,
});

const json: Schema.Codec<EdgeJson> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.mutable(Schema.Array(json)),
    Schema.Record(Schema.String, json),
  ]),
);
const chunk = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

export const SessionUpdate = Schema.Union([
  Schema.Struct({
    sessionUpdate: Schema.Literals([
      "user_message_chunk",
      "agent_message_chunk",
    ]),
    content: chunk,
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call"),
    toolCallId: identifier,
    title: identifier,
    rawInput: Schema.optionalKey(json),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call_update"),
    toolCallId: identifier,
    status: Schema.optionalKey(
      Schema.NullOr(
        Schema.Literals(["pending", "in_progress", "completed", "failed"]),
      ),
    ),
    rawOutput: Schema.optionalKey(json),
    content: Schema.optionalKey(Schema.NullOr(Schema.Array(json))),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(json),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("model_changed"),
    model_id: identifier,
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("turn_completed"),
    agent_result: Schema.optionalKey(Schema.String),
  }),
]);

export const Permission = Schema.Struct({
  sessionId: identifier,
  toolCall: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        toolCallId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        title: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  options: Schema.Array(
    Schema.Struct({
      optionId: identifier,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

export const establishSession = Effect.fn("acp.establishSession")(function* (
  options: ProviderAdapterOptions,
  spec: StartSpec | ResumeSpec,
  roundTrip: (
    method: string,
    params: object,
    timeout: "30 seconds" | "1 hour",
  ) => Effect.Effect<unknown, AdapterError>,
) {
  const initialization = yield* roundTrip(
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
    "30 seconds",
  ).pipe(
    Effect.mapError((error) =>
      processError("initialize-failed", error.message, error),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(Initialize)),
    Effect.mapError((error) =>
      error instanceof AdapterError
        ? error
        : processError(
            "protocol-version",
            "Expected ACP protocol version 1",
            error,
          ),
    ),
  );
  const reportedVersion =
    initialization.agentInfo?.version ?? initialization._meta?.agentVersion;
  if (reportedVersion && reportedVersion !== options.provider.version)
    return yield* processError(
      "agent-version",
      "ACP agent reported a different version",
    );

  const setup = {
    cwd: spec.cwd,
    mcpServers: [],
    ...(spec.options === undefined ? {} : { _meta: spec.options }),
  };
  if ("checkpoint" in spec) {
    if (!initialization.agentCapabilities?.loadSession)
      return yield* processError(
        "resume-unsupported",
        "ACP agent did not offer session/load",
      );
    const reply = yield* roundTrip(
      "session/load",
      { ...setup, sessionId: spec.checkpoint },
      "1 hour",
    );
    yield* Schema.decodeUnknownEffect(LoadSession)(reply).pipe(
      Effect.mapError((error) =>
        processError(
          "invalid-load",
          "ACP did not confirm the session load",
          error,
        ),
      ),
    );
    return spec.checkpoint;
  }

  const reply = yield* roundTrip("session/new", setup, "30 seconds");
  const created = yield* Schema.decodeUnknownEffect(NewSession)(reply).pipe(
    Effect.mapError((error) =>
      processError(
        "invalid-session",
        "ACP did not confirm a session ID",
        error,
      ),
    ),
  );
  return created.sessionId;
});
