import { array, count, nonEmptyString, object, oneOf, parser, positiveInteger, tagged } from "./parse";
import { readV1 } from "./version";

export const daemon = {
  machine: nonEmptyString,
  boot: nonEmptyString,
};
const linkedDaemon = { v: readV1, ...daemon };
const capacity = object({
  memory_total_bytes: count,
  memory_available_bytes: count,
  live_agents: count,
});
const policy = object({
  revision: positiveInteger,
  heartbeat_interval_ms: positiveInteger,
  capabilities: array(nonEmptyString),
});

const helloRequest = object({
  ...daemon,
  versions: array(positiveInteger),
  capabilities: array(nonEmptyString),
  providers: array(object({ name: nonEmptyString, version: nonEmptyString })),
  runtimes: array(object({ host: nonEmptyString, isolation: nonEmptyString })),
  capacity,
});
const helloResponse = tagged("status", {
  ok: object({ status: oneOf("ok"), version: positiveInteger, policy }),
  upgrade_required: object({
    status: oneOf("upgrade_required"),
    supported_versions: array(positiveInteger),
  }),
});
const heartbeatRequest = object({ ...linkedDaemon, capacity });
const heartbeatResponse = object({ v: readV1, policy_revision: positiveInteger });
const policyGetRequest = object(linkedDaemon);
const policyGetResponse = object({ v: readV1, policy });

export type HelloRequest = ReturnType<typeof helloRequest>;
export type HelloResponse = ReturnType<typeof helloResponse>;
export type HeartbeatRequest = ReturnType<typeof heartbeatRequest>;
export type HeartbeatResponse = ReturnType<typeof heartbeatResponse>;
export type PolicyGetRequest = ReturnType<typeof policyGetRequest>;
export type PolicyGetResponse = ReturnType<typeof policyGetResponse>;

export const parseHelloRequest = parser(helloRequest);
export const parseHelloResponse = parser(helloResponse);
export const parseHeartbeatRequest = parser(heartbeatRequest);
export const parseHeartbeatResponse = parser(heartbeatResponse);
export const parsePolicyGetRequest = parser(policyGetRequest);
export const parsePolicyGetResponse = parser(policyGetResponse);
