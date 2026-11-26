import * as Schema from "effect/Schema";
import { json } from "./provider-json";

const id = Schema.String.check(Schema.isMinLength(1));
const optional = Schema.optionalKey;
const strings = Schema.Array(Schema.String);
const jsonObject = Schema.Record(Schema.String, json);
export const RpcLine = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: optional(Schema.Literal("2.0")),
    id: optional(Schema.Union([Schema.Number, Schema.String])),
    method: optional(id),
    params: optional(Schema.Unknown),
    result: optional(Schema.Unknown),
    error: optional(
      Schema.Struct({ code: Schema.Number, message: Schema.String }),
    ),
  }),
);

export const Initialize = Schema.Struct({ userAgent: id });
export const OpenOptions = Schema.Struct({
  model: optional(id),
  sandbox: optional(
    Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  ),
  approvalPolicy: optional(
    Schema.Literals(["untrusted", "on-failure", "on-request", "never"]),
  ),
  config: optional(jsonObject),
  baseInstructions: optional(Schema.String),
  developerInstructions: optional(Schema.String),
  ephemeral: optional(Schema.Boolean),
});
const sandbox = Schema.Union([
  Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
  Schema.Struct({
    type: Schema.Literal("readOnly"),
    networkAccess: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("externalSandbox"),
    networkAccess: json,
  }),
  Schema.Struct({
    type: Schema.Literal("workspaceWrite"),
    writableRoots: strings,
    networkAccess: Schema.Boolean,
    excludeTmpdirEnvVar: Schema.Boolean,
    excludeSlashTmp: Schema.Boolean,
  }),
]);
const status = Schema.Struct({ type: id, activeFlags: optional(strings) });
const turn = Schema.Struct({
  id,
  status: Schema.Literals(["inProgress", "completed", "failed", "interrupted"]),
  error: optional(
    Schema.NullOr(
      Schema.Struct({ message: optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
export const ThreadReply = Schema.Struct({
  thread: Schema.Struct({
    id,
    status: optional(status),
    turns: optional(Schema.Array(turn)),
  }),
  sandbox: optional(sandbox),
});
export const TurnReply = Schema.Struct({ turn });
export const SteerReply = Schema.Struct({ turnId: id });
export const InterruptReply = Schema.Struct({});

const userInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("localImage"), path: id }),
]);
const item = Schema.Union([
  Schema.Struct({
    id,
    type: Schema.Literal("userMessage"),
    clientId: optional(Schema.NullOr(id)),
    content: Schema.Array(userInput),
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("agentMessage"),
    text: Schema.String,
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("reasoning"),
    content: strings,
    summary: strings,
  }),
  Schema.Struct({ id, type: Schema.Literal("plan"), text: Schema.String }),
  Schema.Struct({
    id,
    type: Schema.Literal("commandExecution"),
    command: Schema.String,
    cwd: optional(Schema.String),
    status: id,
    aggregatedOutput: optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("fileChange"),
    changes: Schema.mutable(Schema.Array(jsonObject)),
    status: id,
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("mcpToolCall"),
    server: id,
    tool: id,
    arguments: json,
    status: id,
    result: optional(json),
    error: optional(json),
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("dynamicToolCall"),
    tool: id,
    arguments: json,
    status: id,
    contentItems: optional(json),
    success: optional(Schema.NullOr(Schema.Boolean)),
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("collabAgentToolCall"),
    tool: id,
    status: id,
    senderThreadId: id,
    receiverThreadIds: Schema.mutable(strings),
    prompt: optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("webSearch"),
    query: Schema.String,
  }),
  Schema.Struct({ id, type: Schema.Literal("imageView"), path: id }),
  Schema.Struct({
    id,
    type: Schema.Literal("imageGeneration"),
    result: Schema.String,
    status: id,
  }),
  Schema.Struct({ id, type: Schema.Literal("contextCompaction") }),
]);
const turnScope = { threadId: id, turnId: id };
export const Notification = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("thread/started"),
    params: Schema.Struct({ thread: Schema.Struct({ id }) }),
  }),
  Schema.Struct({
    method: Schema.Literal("thread/status/changed"),
    params: Schema.Struct({ threadId: id, status: jsonObject }),
  }),
  Schema.Struct({
    method: Schema.Literal("thread/name/updated"),
    params: Schema.Struct({
      threadId: id,
      threadName: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/started"),
    params: Schema.Struct({ threadId: id, turn }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/completed"),
    params: Schema.Struct({ threadId: id, turn }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/started"),
    params: Schema.Struct({ ...turnScope, item }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/completed"),
    params: Schema.Struct({ ...turnScope, item }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/agentMessage/delta"),
    params: Schema.Struct({ ...turnScope, itemId: id, delta: Schema.String }),
  }),
  Schema.Struct({
    method: Schema.Literals([
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ]),
    params: Schema.Struct({ ...turnScope, itemId: id, delta: Schema.String }),
  }),
  Schema.Struct({
    method: Schema.Literal("serverRequest/resolved"),
    params: Schema.Struct({
      threadId: id,
      requestId: Schema.Union([Schema.Number, Schema.String]),
    }),
  }),
]);

const promptScope = {
  ...turnScope,
  itemId: id,
  reason: optional(Schema.NullOr(Schema.String)),
};
export const Prompt = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("item/commandExecution/requestApproval"),
    params: Schema.Struct({
      ...promptScope,
      command: optional(Schema.NullOr(Schema.String)),
      availableDecisions: optional(Schema.NullOr(Schema.Array(json))),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/fileChange/requestApproval"),
    params: Schema.Struct(promptScope),
  }),
  Schema.Struct({
    method: Schema.Literal("item/permissions/requestApproval"),
    params: Schema.Struct({ ...promptScope, permissions: jsonObject }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/tool/requestUserInput"),
    params: Schema.Struct({
      ...promptScope,
      questions: Schema.Array(
        Schema.Struct({
          id,
          question: Schema.String,
          header: optional(Schema.String),
          isOther: optional(Schema.Boolean),
          isSecret: optional(Schema.Boolean),
          options: optional(
            Schema.NullOr(
              Schema.Array(
                Schema.Struct({
                  label: Schema.String,
                  description: Schema.String,
                }),
              ),
            ),
          ),
        }),
      ),
    }),
  }),
]);

export const QuestionAnswers = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ answers: strings })),
});
export type ThreadItem = typeof item.Type;
export type Input = typeof userInput.Type;
