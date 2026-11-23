import {
  array, boolean, nonEmptyString, object, oneOf, optional, parser, positiveInteger,
  responseObject, string, tagged,
} from "./parse";
import { readV1 } from "./version";
import { response } from "./response";
import { fence } from "./claims";

const actorFields = { kind: oneOf("person", "agent"), id: nonEmptyString };
export const actor = object(actorFields);
export const blobFields = { blob_id: nonEmptyString };

const delivery = {
  ...fence,
  delivery_id: nonEmptyString,
  attempt_id: nonEmptyString,
  seq: positiveInteger,
  intent: oneOf("steer", "queue"),
};
const requestDelivery = { ...delivery, sender: actor };
const responseDelivery = { ...delivery, sender: responseObject(actorFields) };
const inputPart = tagged("type", {
  text: responseObject({ type: oneOf("text"), text: string }),
  blob: responseObject({ type: oneOf("blob"), ...blobFields, content_type: nonEmptyString }),
});

const permitsNextRequest = object({ v: readV1, ...fence });
const permitsNextResponse = response(tagged("status", {
  permit: responseObject({
    v: readV1,
    status: oneOf("permit"),
    ...responseDelivery,
    state: oneOf("new", "started"),
    input: array(inputPart),
  }),
  empty: responseObject({ v: readV1, status: oneOf("empty") }),
  stale: responseObject({ v: readV1, status: oneOf("stale") }),
}));
const deliveryStartRequest = object({ v: readV1, ...requestDelivery });
const startedAttempt = responseObject({
  v: readV1,
  status: oneOf("started", "already_started"),
  ...responseDelivery,
});
const deliveryStartResponse = response(tagged("status", {
  started: startedAttempt,
  already_started: startedAttempt,
  rejected: responseObject({ v: readV1, status: oneOf("rejected"), reason: nonEmptyString }),
}));

const settlement = { v: readV1, ...requestDelivery, detail: optional(string) };
const settledAttempt = object({
  ...settlement,
  outcome: oneOf("applied", "duplicate", "rejected", "in_doubt"),
});
const deliverySettleRequest = tagged("outcome", {
  applied: settledAttempt,
  duplicate: settledAttempt,
  rejected: settledAttempt,
  in_doubt: settledAttempt,
  failed: object({ ...settlement, outcome: oneOf("failed"), retryable: boolean }),
});
const deliverySettleResponse = response(responseObject({
  v: readV1,
  status: oneOf("recorded", "duplicate", "stale"),
}));

export type PermitsNextRequest = ReturnType<typeof permitsNextRequest>;
export type PermitsNextResponse = ReturnType<typeof permitsNextResponse>;
export type DeliveryStartRequest = ReturnType<typeof deliveryStartRequest>;
export type DeliveryStartResponse = ReturnType<typeof deliveryStartResponse>;
export type DeliverySettleRequest = ReturnType<typeof deliverySettleRequest>;
export type DeliverySettleResponse = ReturnType<typeof deliverySettleResponse>;

export const parsePermitsNextRequest = parser(permitsNextRequest);
export const parsePermitsNextResponse = parser(permitsNextResponse);
export const parseDeliveryStartRequest = parser(deliveryStartRequest);
export const parseDeliveryStartResponse = parser(deliveryStartResponse);
export const parseDeliverySettleRequest = parser(deliverySettleRequest);
export const parseDeliverySettleResponse = parser(deliverySettleResponse);
