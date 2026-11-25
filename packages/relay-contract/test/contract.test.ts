import { expect, test } from "bun:test";
import {
  negotiateRelayVersion,
  parseRelayClientFrame,
  parseRelayGrantClaims,
  parseRelayServerFrame,
  RELAY_MAX_FRAME_BYTES,
  type RelayClientFrame,
  type RelayGrantClaims,
  type RelayServerFrame,
} from "../src";

const session = { kind: "session", id: "session-1" } as const;
const machine = { kind: "machine", id: "machine-1" } as const;
const connect = {
  type: "connect",
  versions: [1],
  capabilities: ["presence"],
  token: "signed.token",
} as const;
const draft = { kind: "draft", revision: 3, anchor: 11, head: 4 } as const;
const reading = { kind: "reading", message_id: "msg-1", offset: 0.42 } as const;
const timed = {
  v: 1,
  connection_id: "connection-1",
  seq: 1,
  expires_at_ms: 1700000020000,
} as const;
const user = { ...timed, hub: session, user_id: "user-1" } as const;
const hello = {
  type: "hello",
  status: "ok",
  version: 1,
  capabilities: ["presence"],
  connection_id: timed.connection_id,
  expires_at_ms: timed.expires_at_ms,
} as const;

test("client frames accept the v1 session and machine signals", () => {
  const frames = [
    { ...connect, versions: [1], capabilities: ["presence"] },
    { v: 1, type: "subscribe", hub: session },
    { v: 1, type: "unsubscribe", hub: machine },
    { v: 1, type: "presence", hub: session },
    { v: 1, type: "cursor", hub: session, cursor: draft },
    { v: 1, type: "cursor", hub: session, cursor: reading },
    { v: 1, type: "cursor", hub: session, cursor: null },
    { v: 1, type: "baton_heartbeat", hub: session },
    { v: 1, type: "session_liveness", hub: session, run: 2 },
    { v: 1, type: "machine_liveness", hub: machine },
  ] satisfies RelayClientFrame[];
  for (const frame of frames) {
    expect(parseRelayClientFrame(JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  }
});

test("relay frames carry the negotiated connection, signal expiry, and ordering keys", () => {
  const frames = [
    { ...hello, capabilities: ["presence"] },
    { type: "hello", status: "incompatible_version", supported_versions: [1] },
    { type: "hello", status: "unauthorized" },
    { v: 1, type: "subscription", hub: session, status: "subscribed" },
    { v: 1, type: "subscription", hub: session, status: "denied" },
    { v: 1, type: "subscription", hub: machine, status: "unsubscribed" },
    { ...user, type: "presence" },
    { ...user, type: "cursor", cursor: draft },
    { ...user, type: "cursor", cursor: reading },
    { ...user, type: "cursor", cursor: null },
    { ...user, type: "baton_heartbeat" },
    {
      ...timed,
      hub: session,
      machine_id: machine.id,
      type: "session_liveness",
      run: 2,
    },
    { ...timed, hub: machine, type: "machine_liveness" },
  ] satisfies RelayServerFrame[];
  for (const frame of frames) {
    expect(parseRelayServerFrame(JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  }
});

test("client frames reject credentials, authority, and stored state outside connect", () => {
  const baton = { v: 1, type: "baton_heartbeat", hub: session };
  const cursor = { v: 1, type: "cursor", hub: session, cursor: draft };
  const cases = [
    [{ ...baton, token: connect.token }, "$.token"],
    [{ ...baton, fencing_token: "lease-secret" }, "$.fencing_token"],
    [{ ...baton, expires_at_ms: timed.expires_at_ms }, "$.expires_at_ms"],
    [{ ...baton, user_id: user.user_id }, "$.user_id"],
    [{ ...baton, claim: {} }, "$.claim"],
    [{ ...cursor, cursor: { ...draft, text: "draft" } }, "$.cursor.text"],
    [{ ...baton, hub: { ...session, workspace: "team:1" } }, "$.hub.workspace"],
  ] as const;
  for (const [frame, path] of cases) {
    expect(parseRelayClientFrame(JSON.stringify(frame))).toEqual({
      ok: false,
      error: { code: "unknown_field", path },
    });
  }
});

test("relay responses project known fields at each level", () => {
  const frame = {
    ...user,
    type: "cursor",
    cursor: draft,
  } satisfies RelayServerFrame;
  const extended = {
    ...frame,
    token: connect.token,
    hub: { ...session, routing: "team:1" },
    cursor: { ...draft, text: "draft" },
    ["__proto__"]: { injected: true },
  };
  expect(parseRelayServerFrame(JSON.stringify(extended))).toEqual({
    ok: true,
    value: frame,
  });
});

test("parsers reject malformed fields and wrong hub or protocol versions", () => {
  const invalidClients = [
    [[], "$"],
    [{}, "$.type"],
    [{ ...connect, versions: [] }, "$.versions"],
    [{ ...connect, capabilities: [1337] }, "$.capabilities[0]"],
    [{ ...connect, token: "signed.token\n" }, "$.token"],
    [{ type: "subscribe", v: 2, hub: session }, "$.v"],
    [{ type: "presence", v: 1, hub: machine }, "$.hub.kind"],
    [
      { type: "cursor", v: 1, hub: session, cursor: { ...draft, anchor: -1 } },
      "$.cursor.anchor",
    ],
    [{ type: "session_liveness", v: 1, hub: session, run: 0 }, "$.run"],
    [
      {
        type: "cursor",
        v: 1,
        hub: session,
        cursor: { ...reading, offset: 1.01 },
      },
      "$.cursor.offset",
    ],
    [{ type: "machine_liveness", v: 1, hub: session }, "$.hub.kind"],
  ] as const;
  for (const [frame, path] of invalidClients) {
    expect(parseRelayClientFrame(JSON.stringify(frame))).toEqual({
      ok: false,
      error: { code: "invalid_field", path },
    });
  }
  const invalidResponses = [
    [{ ...hello, version: 0 }, "$.version"],
    [{ ...hello, expires_at_ms: null }, "$.expires_at_ms"],
    [{ ...user, type: "presence", connection_id: "" }, "$.connection_id"],
    [{ ...user, type: "presence", seq: Number.MAX_SAFE_INTEGER + 1 }, "$.seq"],
    [
      {
        ...user,
        type: "cursor",
        cursor: { kind: "reading", message_id: "msg-1" },
      },
      "$.cursor.offset",
    ],
  ] as const;
  for (const [frame, path] of invalidResponses) {
    expect(parseRelayServerFrame(JSON.stringify(frame))).toEqual({
      ok: false,
      error: { code: "invalid_field", path },
    });
  }
  expect(parseRelayClientFrame("{")).toEqual({
    ok: false,
    error: { code: "invalid_json", path: "$" },
  });
});

test("parsers reject unknown variants including later relay streams", () => {
  for (const type of [
    "message.delta",
    "terminal_frame",
    "permit_ready",
    "constructor",
  ]) {
    const wire = JSON.stringify({ type, v: 1 });
    const unknown = {
      ok: false,
      error: { code: "unknown_kind", path: "$.type" },
    } as const;
    expect(parseRelayClientFrame(wire)).toEqual(unknown);
    expect(parseRelayServerFrame(wire)).toEqual(unknown);
  }
  expect(
    parseRelayServerFrame(JSON.stringify({ ...hello, status: "pending" })),
  ).toEqual({
    ok: false,
    error: { code: "unknown_kind", path: "$.status" },
  });
});

test("parsers enforce field bounds and the encoded byte cap before JSON decoding", () => {
  const client = JSON.stringify(connect);
  const maxClient = client.padEnd(RELAY_MAX_FRAME_BYTES);
  expect(parseRelayClientFrame(maxClient).ok).toBe(true);
  expect(parseRelayClientFrame(maxClient + "x")).toEqual({
    ok: false,
    error: { code: "too_large", path: "$" },
  });
  const prefix = JSON.stringify(hello).slice(0, -1) + ',"future":"';
  const maxResponse =
    prefix +
    "😀".repeat(Math.floor((RELAY_MAX_FRAME_BYTES - prefix.length - 2) / 4));
  expect(parseRelayServerFrame(maxResponse + '"}').ok).toBe(true);
  expect(parseRelayServerFrame(maxResponse + '😀"}')).toEqual({
    ok: false,
    error: { code: "too_large", path: "$" },
  });
  for (const [frame, path] of [
    [{ ...connect, token: "a".repeat(6145) }, "$.token"],
    [
      { ...connect, versions: Array.from({ length: 9 }, () => 1) },
      "$.versions",
    ],
    [
      {
        ...connect,
        capabilities: Array.from({ length: 17 }, () => "presence"),
      },
      "$.capabilities",
    ],
    [
      { v: 1, type: "subscribe", hub: { ...session, id: "a".repeat(129) } },
      "$.hub.id",
    ],
  ] as const) {
    expect(parseRelayClientFrame(JSON.stringify(frame))).toEqual({
      ok: false,
      error: { code: "invalid_field", path },
    });
  }
});

test("authorization claims bind expiry, relay audience and publish rights to named hubs", () => {
  const claims = {
    audience: "cell-1",
    subject: machine,
    expires_at_ms: timed.expires_at_ms,
    grants: [
      { ...machine, publish: ["machine_liveness"] },
      { ...session, publish: [] },
    ],
  } satisfies RelayGrantClaims;
  expect(parseRelayGrantClaims(JSON.stringify(claims))).toEqual({
    ok: true,
    value: claims,
  });
  const invalid = [
    [{ ...claims, audience: null }, "$.audience", "invalid_field"],
    [{ ...claims, expires_at_ms: 0 }, "$.expires_at_ms", "invalid_field"],
    [{ ...claims, grants: [] }, "$.grants", "invalid_field"],
    [
      { ...claims, grants: [{ ...machine, publish: ["presence"] }] },
      "$.grants[0].publish[0]",
      "invalid_field",
    ],
    [
      { ...claims, grants: [{ ...session, publish: [], team_id: "team-1" }] },
      "$.grants[0].team_id",
      "unknown_field",
    ],
  ] as const;
  for (const [payload, path, code] of invalid) {
    expect(parseRelayGrantClaims(JSON.stringify(payload))).toEqual({
      ok: false,
      error: { code, path },
    });
  }
});

test("negotiation uses the highest common version and permits the previous release", () => {
  expect(negotiateRelayVersion([2, 1])).toBe(1);
  expect(negotiateRelayVersion([1, 3, 2], [2, 1])).toBe(2);
  expect(negotiateRelayVersion([1], [2, 1])).toBe(1);
  expect(negotiateRelayVersion([3], [2, 1])).toBeNull();
  expect(negotiateRelayVersion([1], [3, 2])).toBeNull();
});
