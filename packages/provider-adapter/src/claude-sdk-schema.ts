import * as Schema from "effect/Schema";
import { json } from "./provider-json";

const id = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.isMaxLength(256),
);
const uuid = Schema.String.check(
  Schema.isPattern(
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu,
  ),
);
export const Checkpoint = uuid;

export const OpenOptions = Schema.Struct({
  model: Schema.optional(id),
  permissionMode: Schema.optional(
    Schema.Literals(["default", "acceptEdits", "plan", "dontAsk"]),
  ),
  systemPrompt: Schema.optional(Schema.String),
  appendSystemPrompt: Schema.optional(Schema.String),
});

const input = Schema.Record(Schema.String, json);

const block = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool_use"), id, name: id, input }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    tool_use_id: id,
    content: Schema.optional(json),
    is_error: Schema.optional(Schema.Boolean),
  }),
]);

const scoped = { session_id: uuid, uuid: id };
const commandIds = { user_message_uuids: Schema.optional(Schema.Array(uuid)) };

export const Prompt = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: id,
  request: Schema.Struct({
    subtype: Schema.Literal("can_use_tool"),
    tool_name: id,
    tool_use_id: id,
    input,
    description: Schema.optional(Schema.String),
  }),
});

export const Questions = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: id,
      header: Schema.optional(Schema.String),
      multiSelect: Schema.optional(Schema.Boolean),
      options: Schema.Array(
        Schema.Struct({
          label: id,
          description: Schema.optional(Schema.String),
        }),
      ),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});

const Response = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Union([
    Schema.Struct({
      subtype: Schema.Literal("success"),
      request_id: id,
      response: Schema.optional(json),
    }),
    Schema.Struct({
      subtype: Schema.Literal("error"),
      request_id: id,
      error: Schema.String,
    }),
  ]),
});

export const Initialized = Schema.Struct({ claude_code_version: id });

const frame = Schema.Union([
  Response,
  Prompt,
  Schema.Struct({
    type: Schema.Literal("control_cancel_request"),
    request_id: id,
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    ...scoped,
    subtype: Schema.Literal("init"),
    ...commandIds,
    model: Schema.optional(id),
    permissionMode: Schema.optional(id),
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    ...scoped,
    subtype: Schema.Literal("session_state_changed"),
    state: Schema.Literals(["running", "idle", "requires_action"]),
  }),
  Schema.Struct({
    type: Schema.Literal("conversation_reset"),
    ...scoped,
  }),
  Schema.Struct({
    type: Schema.Literal("command_lifecycle"),
    ...scoped,
    command_uuid: uuid,
    state: Schema.Literals(["queued", "started", "completed", "cancelled"]),
  }),
  Schema.Struct({
    type: Schema.Literals(["assistant", "user"]),
    ...scoped,
    message: Schema.Struct({
      content: Schema.Union([Schema.String, Schema.Array(json)]),
    }),
    error: Schema.optional(id),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    ...scoped,
    ...commandIds,
    user_message_uuid: Schema.optional(Schema.NullOr(uuid)),
    subtype: id,
    is_error: Schema.Boolean,
    result: Schema.optional(Schema.String),
    errors: Schema.optional(Schema.Array(Schema.String)),
    terminal_reason: Schema.optional(Schema.NullOr(id)),
  }),
]);

export const Frame = Schema.fromJsonString(frame);
export const ContentBlock = block;
