import {
  array, boolean, count, json, nonEmptyString, object, oneOf, optional, owns, parser,
  positiveInteger, string, tagged, type Reader, type EdgeJson,
} from "./parse";
import { readV1 } from "./version";
import { claimScope } from "./claims";
import { actor, blobFields } from "./inbox";

const blobReference = object(blobFields);
const toolOutput: Reader<EdgeJson> = (value, path) => (
  typeof value === "object" && value !== null && owns(value, "blob_id")
    ? blobReference(value, path)
    : json(value, path)
);

const eventScope = {
  v: readV1,
  ...claimScope,
  at: count,
  source: oneOf("provider", "observed"),
};

function event<K extends string, B>(kind: K, body: (value: unknown, path: string) => B) {
  return object({
    ...eventScope,
    turn: (value, path) => value === null ? null : nonEmptyString(value, path),
    seq: positiveInteger,
    kind: oneOf(kind),
    body,
  });
}

export const readCanonicalEvent = tagged("kind", {
  "session.started": event("session.started", object({ machine: nonEmptyString, provider: nonEmptyString })),
  "session.moved": event("session.moved", object({ from_machine: nonEmptyString, to_machine: nonEmptyString })),
  "session.ended": event("session.ended", object({ reason: nonEmptyString })),
  "turn.started": event("turn.started", object({})),
  "turn.ended": event("turn.ended", object({ reason: nonEmptyString })),
  "message.user": event("message.user", object({
    text: string,
    delivery_id: optional(nonEmptyString),
    authors: array(actor),
    attachments: optional(array(blobReference)),
  })),
  "message.assistant": event("message.assistant", object({ message_id: nonEmptyString, text: string })),
  "tool.call": event("tool.call", object({ call_id: nonEmptyString, name: nonEmptyString, input: json })),
  "tool.result": event("tool.result", object({ call_id: nonEmptyString, output: toolOutput, is_error: boolean })),
  "prompt.opened": event("prompt.opened", object({ prompt_id: nonEmptyString, kind: nonEmptyString })),
  "prompt.settled": event("prompt.settled", object({ prompt_id: nonEmptyString, by: actor, answer: json })),
  receipt: event("receipt", object({ delivery_id: nonEmptyString })),
  context: event("context", object({ data: json })),
  usage: event("usage", object({
    input_tokens: count,
    output_tokens: count,
    cache_read_tokens: count,
    cache_write_tokens: count,
    model: nonEmptyString,
  })),
  error: event("error", object({ class: nonEmptyString, message: string, retryable: boolean })),
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
