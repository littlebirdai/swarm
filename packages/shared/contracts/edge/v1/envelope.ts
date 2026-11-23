import { array, count, json, nonEmptyString, object, oneOf, optional, parser, positiveInteger, string, tagged } from "./parse";
import { readV1 } from "./version";
import { claimScope } from "./claims";
import { actor, deliveryOutcome } from "./inbox";

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
  })),
  "message.assistant": event("message.assistant", object({ text: string })),
  "tool.call": event("tool.call", object({ call_id: nonEmptyString, name: nonEmptyString, input: json })),
  "tool.result": event("tool.result", object({ call_id: nonEmptyString, output: json })),
  "prompt.opened": event("prompt.opened", object({ prompt_id: nonEmptyString, kind: nonEmptyString })),
  "prompt.settled": event("prompt.settled", object({ prompt_id: nonEmptyString, by: actor, answer: json })),
  receipt: event("receipt", object({ delivery_id: nonEmptyString, outcome: deliveryOutcome })),
  context: event("context", object({ data: json })),
  usage: event("usage", object({ input_tokens: count, output_tokens: count })),
  error: event("error", object({ class: nonEmptyString, message: string })),
});

export type CanonicalEvent = ReturnType<typeof readCanonicalEvent>;
export const parseCanonicalEvent = parser(readCanonicalEvent);

const messageDelta = object({
  ...eventScope,
  turn: nonEmptyString,
  kind: oneOf("message.delta"),
  body: object({ text: string }),
});
export type MessageDelta = ReturnType<typeof messageDelta>;
export const parseMessageDelta = parser(messageDelta);
