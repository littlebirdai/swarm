import {
  array,
  boolean,
  boundedText,
  count,
  json,
  nonEmptyString,
  nullable,
  object,
  oneOf,
  optional,
  owns,
  parser,
  positiveInteger,
  string,
  tagged,
  EdgeParseError,
  type Reader,
} from "./parse";
import { readV1 } from "./version";
import { claimScope } from "./claims";
import { actor, actorFields, blobFields } from "./inbox";
import { readPromptAnswer, readPromptOpened } from "./prompts";
import { paneInstance } from "./expected";

const blobReference = object(blobFields);
const inlineOutput = object({ inline: json });
const toolOutput = (value: unknown, path: string) =>
  typeof value === "object" && value !== null && owns(value, "inline")
    ? inlineOutput(value, path)
    : blobReference(value, path);

const eventScope = {
  v: readV1,
  ...claimScope,
  at: count,
  source: oneOf("provider", "observed"),
};

const readSignal: Reader<string> = (value, path) => {
  const signal = boundedText(32)(value, path);
  if (!/^SIG[A-Z0-9]+(?:[+-][1-9][0-9]?)?$/.test(signal))
    throw new EdgeParseError("invalid_value", path, "expected a signal name");
  return signal;
};

const terminalOutcome = tagged("kind", {
  exit: object({ kind: oneOf("exit"), code: count }),
  signal: object({
    kind: oneOf("signal"),
    signal: readSignal,
  }),
  replaced: object({ kind: oneOf("replaced") }),
  lost: object({ kind: oneOf("lost") }),
});

function event<K extends string, B>(
  kind: K,
  body: (value: unknown, path: string) => B,
) {
  return object({
    ...eventScope,
    turn: nullable(nonEmptyString),
    seq: positiveInteger,
    kind: oneOf(kind),
    body,
  });
}

export const readCanonicalEvent = tagged("kind", {
  "session.started": event(
    "session.started",
    object({ machine: nonEmptyString, provider: nonEmptyString }),
  ),
  "session.moved": event(
    "session.moved",
    object({ from_machine: nonEmptyString, to_machine: nonEmptyString }),
  ),
  "session.ended": event("session.ended", object({ reason: nonEmptyString })),
  "turn.started": event("turn.started", object({})),
  "turn.ended": event("turn.ended", object({ reason: nonEmptyString })),
  "message.user": event(
    "message.user",
    object({
      text: string,
      delivery_id: optional(nonEmptyString),
      authors: array(actor),
      attachments: optional(array(blobReference)),
    }),
  ),
  "message.assistant": event(
    "message.assistant",
    object({ message_id: nonEmptyString, text: string }),
  ),
  "tool.call": event(
    "tool.call",
    object({ call_id: nonEmptyString, name: nonEmptyString, input: json }),
  ),
  "tool.result": event(
    "tool.result",
    object({ call_id: nonEmptyString, output: toolOutput, is_error: boolean }),
  ),
  "prompt.opened": event("prompt.opened", readPromptOpened),
  "prompt.settled": event(
    "prompt.settled",
    object({ prompt_id: nonEmptyString, by: actor, answer: readPromptAnswer }),
  ),
  "terminal.started": event(
    "terminal.started",
    object({
      pane_instance: paneInstance,
      actor: object({ ...actorFields, id: boundedText(256) }),
      tool_call_id: optional(boundedText(256)),
    }),
  ),
  "terminal.ended": event(
    "terminal.ended",
    object({
      pane_instance: paneInstance,
      started_run: positiveInteger,
      outcome: terminalOutcome,
    }),
  ),
  receipt: event("receipt", object({ delivery_id: nonEmptyString })),
  context: event("context", object({ data: json })),
  usage: event(
    "usage",
    object({
      input_tokens: count,
      output_tokens: count,
      cache_read_tokens: count,
      cache_write_tokens: count,
      model: nonEmptyString,
    }),
  ),
  error: event(
    "error",
    object({ class: nonEmptyString, message: string, retryable: boolean }),
  ),
});

export type CanonicalEvent = ReturnType<typeof readCanonicalEvent>;
export const parseCanonicalEvent = parser(readCanonicalEvent);

const messageDelta = object({
  ...eventScope,
  turn: nonEmptyString,
  kind: oneOf("message.delta"),
  body: object({ message_id: nonEmptyString, offset: count, text: string }),
});
export type MessageDelta = ReturnType<typeof messageDelta>;
export const parseMessageDelta = parser(messageDelta);
