import {
  array,
  count,
  nonEmptyString,
  object,
  oneOf,
  parser,
  positiveInteger,
  responseObject,
  tagged,
} from "./parse";
import { readServerBehind, readUpgradeRequired, readV1 } from "./version";
import { response } from "./response";

export const EXPECTED_CAPABILITY = "expected";
export const STEER_BATON_CAPABILITY = "steer-baton-v1";
export const TAKEOVER_FENCE_CAPABILITY = "takeover-fence-v1";

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
const policy = responseObject({
  revision: positiveInteger,
  heartbeat_interval_ms: positiveInteger,
  uplink_interval_ms: positiveInteger,
  limits: responseObject({
    max_batch_events: positiveInteger,
    max_batch_bytes: positiveInteger,
    max_blob_bytes: positiveInteger,
  }),
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
const helloResponse = response(
  tagged("status", {
    ok: responseObject({
      status: oneOf("ok"),
      version: positiveInteger,
      policy,
    }),
    upgrade_required: readUpgradeRequired,
    server_behind: readServerBehind,
  }),
);
const heartbeatRequest = object({ ...linkedDaemon, capacity });
const heartbeatResponse = response(
  responseObject({ v: readV1, policy_revision: positiveInteger }),
);
const policyGetRequest = object(linkedDaemon);
const policyGetResponse = response(responseObject({ v: readV1, policy }));

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
