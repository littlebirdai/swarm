import { expect, test } from "bun:test";
import {
  negotiateRelayVersion,
  parseRelayClientFrame,
  parseRelayGrantClaims,
  parseRelayServerFrame,
  RELAY_MAX_FRAME_BYTES,
  type RelayClientFrame,
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
const draft = { revision: 3, anchor: 11, head: 4 } as const;
const reading = { message_id: "msg-1", offset: 0.42 } as const;
const timed = {
  v: 1,
  connection_id: "connection-1",
  seq: 1,
  ttl_ms: 4000,
} as const;
const user = { ...timed, hub: session, user_id: "user-1" } as const;
const active = { state: "active", in_draft: true } as const;
const left = { state: "left", in_draft: false } as const;
const grantUpdate = {
  v: 1,
  type: "grant_update",
  request_id: "req-1",
  token: connect.token,
} as const;
const hello = {
  type: "hello",
  status: "ok",
  version: 1,
  capabilities: ["presence"],
  connection_id: timed.connection_id,
  ttl_ms: timed.ttl_ms,
} as const;

test("client frames accept the v1 session and machine signals", () => {
  const frames = [
    { ...connect, versions: [1], capabilities: ["presence"] },
    { v: 1, type: "subscribe", hub: session },
    { v: 1, type: "unsubscribe", hub: machine },
    { v: 1, type: "presence", hub: session, ...active },
    { v: 1, type: "presence", hub: session, ...active, in_draft: false },
    { v: 1, type: "presence", hub: session, ...left },
    { v: 1, type: "draft_cursor", hub: session, cursor: draft },
    { v: 1, type: "reading_cursor", hub: session, cursor: reading },
    { v: 1, type: "draft_cursor", hub: session, cursor: null },
    { v: 1, type: "reading_cursor", hub: session, cursor: null },
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
    { ...user, type: "presence", ...active },
    { ...user, type: "presence", ...left, ttl_ms: 0 },
    { ...user, type: "draft_cursor", cursor: draft },
    { ...user, type: "reading_cursor", cursor: reading },
    { ...user, type: "draft_cursor", cursor: null },
    { ...user, type: "reading_cursor", cursor: null },
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

test("client frames reject credentials, authority, and stored state on display signals", () => {
  const baton = { v: 1, type: "baton_heartbeat", hub: session };
  const cursor = { v: 1, type: "draft_cursor", hub: session, cursor: draft };
  const cases = [
    [{ ...baton, token: connect.token }, "$.token"],
    [{ ...baton, fencing_token: "lease-secret" }, "$.fencing_token"],
    [{ ...baton, ttl_ms: timed.ttl_ms }, "$.ttl_ms"],
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
    type: "draft_cursor",
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
    [{ ...connect, capabilities: ["Presence"] }, "$.capabilities[0]"],
    [{ ...connect, token: "signed.token\n" }, "$.token"],
    [{ type: "subscribe", v: 2, hub: session }, "$.v"],
    [{ type: "presence", v: 1, hub: machine, ...active }, "$.hub.kind"],
    [
      {
        type: "draft_cursor",
        v: 1,
        hub: session,
        cursor: { ...draft, anchor: -1 },
      },
      "$.cursor.anchor",
    ],
    [{ type: "session_liveness", v: 1, hub: session, run: 0 }, "$.run"],
    [
      {
        type: "reading_cursor",
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
    [{ ...hello, ttl_ms: null }, "$.ttl_ms"],
    [
      { ...user, type: "presence", ...active, connection_id: "" },
      "$.connection_id",
    ],
    [
      {
        ...user,
        type: "presence",
        ...active,
        seq: Number.MAX_SAFE_INTEGER + 1,
      },
      "$.seq",
    ],
    [
      {
        ...user,
        type: "reading_cursor",
        cursor: { message_id: "msg-1" },
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
    "cursor",
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
  for (const [character, bytes] of [
    ["é", 2],
    ["€", 3],
    ["😀", 4],
  ] as const) {
    const asciiPadding = "a".repeat(
      RELAY_MAX_FRAME_BYTES - prefix.length - bytes - 2,
    );
    const maxResponse = prefix + asciiPadding + character;
    expect(parseRelayServerFrame(maxResponse + '"}').ok).toBe(true);
    expect(parseRelayServerFrame(maxResponse + 'a"}')).toEqual({
      ok: false,
      error: { code: "too_large", path: "$" },
    });
  }
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

test("negotiation uses the highest common version and permits the previous release", () => {
  expect(negotiateRelayVersion([2, 1])).toBe(1);
  for (const invalid of [2.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(negotiateRelayVersion([1, invalid], [invalid, 1])).toBe(1);
  }
  expect(negotiateRelayVersion([1, 3, 2], [2, 1])).toBe(2);
  expect(negotiateRelayVersion([1], [2, 1])).toBe(1);
  expect(negotiateRelayVersion([3], [2, 1])).toBeNull();
  expect(negotiateRelayVersion([1], [3, 2])).toBeNull();
});

test("grant updates correlate a credential with an acknowledgement or a typed refusal", () => {
  expect(parseRelayClientFrame(JSON.stringify(grantUpdate))).toEqual({
    ok: true,
    value: grantUpdate,
  });
  const { request_id } = grantUpdate;
  const result = { v: 1, type: "grant_result", request_id } as const;
  const responses = [
    { ...result, status: "applied", ttl_ms: 5000 },
    { ...result, status: "refused", code: "subject_mismatch" },
    { ...result, status: "refused", code: "expired" },
    { ...result, status: "refused", code: "hub_limit" },
    { ...result, status: "refused", code: "invalid_token" },
    { ...result, status: "refused", code: "unsupported_grant_version" },
  ] satisfies RelayServerFrame[];
  for (const value of responses) {
    expect(
      parseRelayServerFrame(JSON.stringify({ ...value, token: connect.token })),
    ).toEqual({ ok: true, value });
  }
  expect(
    parseRelayClientFrame(
      JSON.stringify({ ...grantUpdate, token: "a".repeat(6145) }),
    ),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", path: "$.token" },
  });
  expect(
    parseRelayServerFrame(
      JSON.stringify({
        ...result,
        status: "applied",
        request_id: null,
        ttl_ms: 5000,
      }),
    ),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", path: "$.request_id" },
  });
  expect(
    parseRelayServerFrame(
      JSON.stringify({ ...result, status: "refused", code: "new_reason" }),
    ),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", path: "$.code" },
  });
});

test("presence departures carry no draft state or positive lifetime", () => {
  const departure = { ...user, type: "presence", ...left, ttl_ms: 0 };
  for (const [frame, path] of [
    [{ ...departure, in_draft: true }, "$.in_draft"],
    [{ ...departure, ttl_ms: 3 }, "$.ttl_ms"],
    [{ ...departure, ...active }, "$.ttl_ms"],
  ] as const) {
    expect(parseRelayServerFrame(JSON.stringify(frame))).toEqual({
      ok: false,
      error: { code: "invalid_field", path },
    });
  }
});

test("signal and handshake expiry use relative lifetimes", () => {
  const { ttl_ms, ...helloWithoutTtl } = hello;
  const { ttl_ms: ttl, ...userWithoutTtl } = user;
  for (const frame of [
    helloWithoutTtl,
    { ...userWithoutTtl, type: "baton_heartbeat" },
  ]) {
    expect(
      parseRelayServerFrame(
        JSON.stringify({ ...frame, expires_at_ms: 1700000020000 }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "invalid_field", path: "$.ttl_ms" },
    });
  }
  expect(
    parseRelayServerFrame(
      JSON.stringify({ ...helloWithoutTtl, ttl_ms, expires_at_ms: ttl }),
    ),
  ).toEqual({
    ok: true,
    value: { ...hello, capabilities: [...hello.capabilities] },
  });
});

test("unavailable hello carries a non-negative retry delay", () => {
  const unavailable = {
    type: "hello",
    status: "unavailable",
    retry_after_ms: 2500,
  } as const;
  expect(parseRelayServerFrame(JSON.stringify(unavailable))).toEqual({
    ok: true,
    value: unavailable,
  });
  expect(
    parseRelayServerFrame(
      JSON.stringify({ ...unavailable, retry_after_ms: -1 }),
    ),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", path: "$.retry_after_ms" },
  });
});

test("non-text parser input returns a typed failure without coercion", () => {
  for (const parse of [
    parseRelayClientFrame,
    parseRelayServerFrame,
    parseRelayGrantClaims,
  ]) {
    for (const value of [
      null,
      new Uint8Array(),
      42,
      connect,
      { toString: () => JSON.stringify(connect) },
    ]) {
      expect(parse(value)).toEqual({
        ok: false,
        error: { code: "invalid_input", path: "$" },
      });
    }
  }
});
