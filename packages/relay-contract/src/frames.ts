import {
  grantRefusal,
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
  boolean,
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
  token,
} from "./read";

const versions = array(positive, 1, 8);
const capabilities = array(string(/^[a-z][a-z0-9_]{0,31}$/), 0, 16);
const v1 = { v: oneOf(1) };
const session = { ...v1, hub: sessionHub };
const machine = { ...v1, hub: machineHub };
const draftCursor = { revision: count, anchor: count, head: count };
const readingCursor = { message_id: id, offset: fraction };
const presence = { ...session, type: oneOf("presence") };
const active = { state: oneOf("active"), in_draft: boolean };
const left = { state: oneOf("left"), in_draft: oneOf(false) };
const grantRequest = { ...v1, request_id: id };

const clientFrame = tagged("type", {
  connect: object({
    type: oneOf("connect"),
    versions,
    capabilities,
    token,
  }),
  grant_update: object({ ...grantRequest, type: oneOf("grant_update"), token }),
  subscribe: object({ ...v1, type: oneOf("subscribe"), hub }),
  unsubscribe: object({ ...v1, type: oneOf("unsubscribe"), hub }),
  presence: tagged("state", {
    active: object({ ...presence, ...active }),
    left: object({ ...presence, ...left }),
  }),
  draft_cursor: object({
    ...session,
    type: oneOf("draft_cursor"),
    cursor: nullable(object(draftCursor)),
  }),
  reading_cursor: object({
    ...session,
    type: oneOf("reading_cursor"),
    cursor: nullable(object(readingCursor)),
  }),
  baton_heartbeat: object({ ...session, type: oneOf("baton_heartbeat") }),
  session_liveness: object({
    ...session,
    type: oneOf("session_liveness"),
    run: positive,
  }),
  machine_liveness: object({ ...machine, type: oneOf(machineSignal) }),
});

const ordering = { ...v1, connection_id: id, seq: positive };
const presenceResponse = {
  ...ordering,
  hub: sessionHubResponse,
  user_id: id,
  type: oneOf("presence"),
};
const timedSignal = { ...ordering, ttl_ms: positive };
const userSignal = { ...timedSignal, hub: sessionHubResponse, user_id: id };
const grantResponse = { ...grantRequest, type: oneOf("grant_result") };

const relayFrame = tagged("type", {
  hello: tagged("status", {
    ok: responseObject({
      type: oneOf("hello"),
      status: oneOf("ok"),
      version: positive,
      capabilities,
      connection_id: id,
      ttl_ms: positive,
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
    unavailable: responseObject({
      type: oneOf("hello"),
      status: oneOf("unavailable"),
      retry_after_ms: count,
    }),
  }),
  grant_result: tagged("status", {
    applied: responseObject({
      ...grantResponse,
      status: oneOf("applied"),
      ttl_ms: positive,
    }),
    refused: responseObject({
      ...grantResponse,
      status: oneOf("refused"),
      code: grantRefusal,
    }),
  }),
  subscription: responseObject({
    ...v1,
    type: oneOf("subscription"),
    hub: hubResponse,
    status: oneOf("subscribed", "unsubscribed", "denied"),
  }),
  presence: tagged("state", {
    active: responseObject({
      ...presenceResponse,
      ...active,
      ttl_ms: positive,
    }),
    left: responseObject({ ...presenceResponse, ...left, ttl_ms: oneOf(0) }),
  }),
  draft_cursor: responseObject({
    ...userSignal,
    type: oneOf("draft_cursor"),
    cursor: nullable(responseObject(draftCursor)),
  }),
  reading_cursor: responseObject({
    ...userSignal,
    type: oneOf("reading_cursor"),
    cursor: nullable(responseObject(readingCursor)),
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
