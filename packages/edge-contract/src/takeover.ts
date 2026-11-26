import { fence } from "./claims";
import {
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

const takeoverAckRequest = object({
  v: readV1,
  ...fence,
  fence_id: nonEmptyString,
  turn: nonEmptyString,
  baton_token: nullable(positiveInteger),
});
const takeoverAckResponse = response(
  responseObject({
    v: readV1,
    status: oneOf("recorded", "duplicate", "stale"),
  }),
);

export type TakeoverAckRequest = ReturnType<typeof takeoverAckRequest>;
export type TakeoverAckResponse = ReturnType<typeof takeoverAckResponse>;

export const parseTakeoverAckRequest = parser(takeoverAckRequest);
export const parseTakeoverAckResponse = parser(takeoverAckResponse);
