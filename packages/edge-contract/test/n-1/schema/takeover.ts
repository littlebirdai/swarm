import { fence } from "./claims";
import {
  EdgeParseError,
  nonEmptyString,
  nullable,
  object,
  oneOf,
  parser,
  positiveInteger,
  responseObject,
} from "./parse";
import { response } from "./response";
import { readV1 } from "./version";

const takeoverFenceFields = {
  v: readV1,
  ...fence,
  fence_id: nonEmptyString,
  turn: nonEmptyString,
  baton_token: nullable(positiveInteger),
};
const takeoverFenceResponse = responseObject({
  ...takeoverFenceFields,
  status: oneOf("takeover_fence"),
  new_baton_token: positiveInteger,
});

export function readTakeoverFence(value: unknown, path: string) {
  const fence = takeoverFenceResponse(value, path);
  if (fence.baton_token !== null && fence.new_baton_token <= fence.baton_token)
    throw new EdgeParseError(
      "invalid_value",
      `${path}.new_baton_token`,
      "expected a token greater than the fenced baton token",
    );
  return fence;
}

const takeoverAckRequest = object(takeoverFenceFields);
const takeoverAckResponse = response(
  responseObject({
    v: readV1,
    status: oneOf("recorded", "duplicate", "stale"),
  }),
);

export type TakeoverFence = ReturnType<typeof readTakeoverFence>;
export type TakeoverAckRequest = ReturnType<typeof takeoverAckRequest>;
export type TakeoverAckResponse = ReturnType<typeof takeoverAckResponse>;

export const parseTakeoverAckRequest = parser(takeoverAckRequest);
export const parseTakeoverAckResponse = parser(takeoverAckResponse);
