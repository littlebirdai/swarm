import { nonEmptyString, object, oneOf, optional, parser, positiveInteger, string, tagged } from "./parse";
import { readV1 } from "./version";
import { fence } from "./claims";

export const actor = object({ kind: oneOf("person", "agent"), id: nonEmptyString });
export const deliveryOutcome = oneOf("applied", "duplicate", "rejected");

const delivery = {
  ...fence,
  delivery_id: nonEmptyString,
  seq: positiveInteger,
  intent: oneOf("steer", "queue"),
  sender: actor,
};

const permitsNextRequest = object({ v: readV1, ...fence });
const permitsNextResponse = tagged("status", {
  permit: object({
    v: readV1,
    status: oneOf("permit"),
    ...delivery,
    text: string,
  }),
  empty: object({ v: readV1, status: oneOf("empty") }),
  stale: object({ v: readV1, status: oneOf("stale") }),
});
const deliveryStartRequest = object({ v: readV1, ...delivery });
const deliveryStartResponse = tagged("status", {
  started: object({ v: readV1, status: oneOf("started"), ...delivery }),
  rejected: object({ v: readV1, status: oneOf("rejected"), reason: nonEmptyString }),
});
const deliverySettleRequest = object({
  v: readV1,
  ...delivery,
  outcome: deliveryOutcome,
  detail: optional(string),
});
const deliverySettleResponse = object({ v: readV1, status: oneOf("recorded", "duplicate", "stale") });

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
