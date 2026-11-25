import {
  hub,
  hubResponse,
  machineHub,
  machineHubResponse,
  machineSignal,
  sessionHub,
  sessionHubResponse,
} from "./authorization";
import {
  array,
  count,
  fraction,
  id,
  nullable,
  object,
  oneOf,
  parser,
  positive,
  responseObject,
  string,
  tagged,
} from "./read";

const versions = array(positive, 1, 8);
const capabilities = array(string(/^[a-z][a-z0-9_]{0,31}$/), 0, 16);
const v1 = { v: oneOf(1) };
const session = { ...v1, hub: sessionHub };
const machine = { ...v1, hub: machineHub };
const draftCursor = {
  kind: oneOf("draft"),
  revision: count,
  anchor: count,
  head: count,
};
const readingCursor = {
  kind: oneOf("reading"),
  message_id: id,
  offset: fraction,
};
const cursor = nullable(
  tagged("kind", {
    draft: object(draftCursor),
    reading: object(readingCursor),
  }),
);
const cursorResponse = nullable(
  tagged("kind", {
    draft: responseObject(draftCursor),
    reading: responseObject(readingCursor),
  }),
);

const clientFrame = tagged("type", {
  connect: object({
    type: oneOf("connect"),
    versions,
    capabilities,
    token: string(/^[a-zA-Z0-9_.-]{1,6144}$/),
  }),
  subscribe: object({ ...v1, type: oneOf("subscribe"), hub }),
  unsubscribe: object({ ...v1, type: oneOf("unsubscribe"), hub }),
  presence: object({ ...session, type: oneOf("presence") }),
  cursor: object({ ...session, type: oneOf("cursor"), cursor }),
  baton_heartbeat: object({ ...session, type: oneOf("baton_heartbeat") }),
  session_liveness: object({
    ...session,
    type: oneOf("session_liveness"),
    run: positive,
  }),
  machine_liveness: object({ ...machine, type: oneOf(machineSignal) }),
});

const timedSignal = {
  ...v1,
  connection_id: id,
  seq: positive,
  expires_at_ms: positive,
};
const userSignal = { ...timedSignal, hub: sessionHubResponse, user_id: id };
const relayFrame = tagged("type", {
  hello: tagged("status", {
    ok: responseObject({
      type: oneOf("hello"),
      status: oneOf("ok"),
      version: positive,
      capabilities,
      connection_id: id,
      expires_at_ms: positive,
    }),
    incompatible_version: responseObject({
      type: oneOf("hello"),
      status: oneOf("incompatible_version"),
      supported_versions: versions,
    }),
    unauthorized: responseObject({
      type: oneOf("hello"),
      status: oneOf("unauthorized"),
    }),
  }),
  subscription: responseObject({
    ...v1,
    type: oneOf("subscription"),
    hub: hubResponse,
    status: oneOf("subscribed", "unsubscribed", "denied"),
  }),
  presence: responseObject({ ...userSignal, type: oneOf("presence") }),
  cursor: responseObject({
    ...userSignal,
    type: oneOf("cursor"),
    cursor: cursorResponse,
  }),
  baton_heartbeat: responseObject({
    ...userSignal,
    type: oneOf("baton_heartbeat"),
  }),
  session_liveness: responseObject({
    ...timedSignal,
    hub: sessionHubResponse,
    machine_id: id,
    type: oneOf("session_liveness"),
    run: positive,
  }),
  machine_liveness: responseObject({
    ...timedSignal,
    hub: machineHubResponse,
    type: oneOf(machineSignal),
  }),
});

export type RelayClientFrame = ReturnType<typeof clientFrame>;
export type RelayServerFrame = ReturnType<typeof relayFrame>;
export const parseRelayClientFrame = parser(clientFrame);
export const parseRelayServerFrame = parser(relayFrame);
