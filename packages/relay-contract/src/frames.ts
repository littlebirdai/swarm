import {
  grantRefusal,
  hub,
  hubResponse,
  machineHub,
  machineHubResponse,
  machineSignal,
  RELAY_MAX_GRANTS_PER_TOKEN,
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
  type Reader,
  RelayParseError,
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
  grant_release: object({
    ...grantRequest,
    type: oneOf("grant_release"),
    hubs: array(hub, 1, RELAY_MAX_GRANTS_PER_TOKEN),
  }),
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
const subscription = { ...v1, type: oneOf("subscription"), hub: hubResponse };

function cursorResponse<const Kind extends string, T>(
  type: Kind,
  cursor: Reader<T>,
) {
  const read = responseObject({
    ...userSignal,
    type: oneOf(type),
    cursor: nullable(cursor),
    ttl_ms: count,
  });
  return (value: unknown, path: string) => {
    const parsed = read(value, path);
    if ((parsed.cursor === null) !== (parsed.ttl_ms === 0)) {
      throw new RelayParseError("invalid_field", `${path}.ttl_ms`);
    }
    return parsed;
  };
}

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
    released: responseObject({ ...grantResponse, status: oneOf("released") }),
    refused: responseObject({
      ...grantResponse,
      status: oneOf("refused"),
      code: grantRefusal,
    }),
  }),
  subscription: tagged("status", {
    subscribed: responseObject({
      ...subscription,
      status: oneOf("subscribed"),
    }),
    denied: responseObject({ ...subscription, status: oneOf("denied") }),
    unsubscribed: responseObject({
      ...subscription,
      status: oneOf("unsubscribed"),
      reason: oneOf("requested", "released", "expired"),
    }),
  }),
  presence: tagged("state", {
    active: responseObject({
      ...presenceResponse,
      ...active,
      ttl_ms: positive,
    }),
    left: responseObject({ ...presenceResponse, ...left, ttl_ms: oneOf(0) }),
  }),
  draft_cursor: cursorResponse("draft_cursor", responseObject(draftCursor)),
  reading_cursor: cursorResponse(
    "reading_cursor",
    responseObject(readingCursor),
  ),
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
