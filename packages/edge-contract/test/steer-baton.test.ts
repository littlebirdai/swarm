import { expect, test } from "bun:test";
import * as edge from "@codecast/edge-contract";
import { expectParsed, expectParseError } from "./assertions";
import guarded from "./fixtures/guarded-actions.json";
import hello from "./fixtures/hello.json";
import permitsNext from "./fixtures/permits.next.json";
import takeoverAck from "./fixtures/takeover.ack.json";

const steer = { ...permitsNext.response, ...guarded.steer };

test("hello carries the versioned steer baton capability", () => {
  const request = {
    ...hello.request,
    capabilities: [...hello.request.capabilities, "steer-baton-v1"],
  };
  expect(edge.STEER_BATON_CAPABILITY).toBe("steer-baton-v1");
  expectParsed(edge.parseHelloRequest(request), request);
});

test("a steer permit requires a baton token or an explicit implied right and a turn ID", () => {
  const { baton_token: _token, expected: _expected, ...unguarded } = steer;
  const implied = { ...steer, baton_token: null };
  expectParsed(edge.parsePermitsNextResponse(implied), implied);
  expectParseError(
    edge.parsePermitsNextResponse({ ...unguarded, expected: steer.expected }),
    "missing_field",
    "$.baton_token",
  );
  expectParseError(
    edge.parsePermitsNextResponse({ ...unguarded, baton_token: 17 }),
    "missing_field",
    "$.expected",
  );
  for (const baton_token of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expectParseError(
      edge.parsePermitsNextResponse({ ...steer, baton_token }),
      "invalid_value",
      "$.baton_token",
    );
  expectParseError(
    edge.parsePermitsNextResponse({
      ...steer,
      expected: { kind: "turn", turn: null },
    }),
    "invalid_type",
    "$.expected.turn",
  );
});

test("a parsed steer permits only the turn named by its guard", () => {
  const permit = { ...steer, sender: { kind: "person", id: "user-1" } };
  const parsed = edge.parsePermitsNextResponse(
    JSON.parse(JSON.stringify(permit)),
  );
  expectParsed(parsed, permit);
  if (
    !parsed.ok ||
    parsed.value.status !== "permit" ||
    parsed.value.intent !== "steer"
  )
    throw new Error("Expected a steer permit");
  for (const turn of ["turn-1", "turn-2", null])
    expect(
      edge.matchesExpected(parsed.value.expected, { kind: "turn", turn }),
    ).toBe(turn === "turn-1");
});

test("turn start preserves a person or agent starter and accepts older events", () => {
  const start = {
    v: 1,
    session: "session-1",
    run: 3,
    seq: 4,
    at: 0,
    source: "provider",
    turn: "turn-1",
    kind: "turn.started",
    body: {},
  };
  expectParsed(edge.parseCanonicalEvent(start), start);
  for (const kind of ["person", "agent"]) {
    const event = { ...start, body: { starter: { kind, id: "sender-1" } } };
    expectParsed(edge.parseCanonicalEvent(event), event);
  }
  for (const [starter, field] of [
    [{ kind: "device", id: "sender-1" }, "kind"],
    [{ kind: "person", id: "" }, "id"],
  ] as const)
    expectParseError(
      edge.parseCanonicalEvent({ ...start, body: { starter } }),
      "invalid_value",
      `$.body.starter.${field}`,
    );
  expectParseError(
    edge.parseCanonicalEvent({
      ...start,
      body: { starter: { kind: "person", id: "sender-1", extra: 1 } },
    }),
    "unknown_field",
    "$.body.starter.extra",
  );
  expectParseError(
    edge.parseCanonicalEvent({ ...start, body: { starter: null } }),
    "invalid_type",
    "$.body.starter",
  );
});

test("takeover acknowledgment identifies the exact fence and accepts duplicate and stale outcomes", () => {
  const {
    fence_id: _id,
    baton_token: _token,
    ...unscoped
  } = takeoverAck.request;
  expectParseError(
    edge.parseTakeoverAckRequest({ ...unscoped, baton_token: 17 }),
    "missing_field",
    "$.fence_id",
  );
  expectParseError(
    edge.parseTakeoverAckRequest({ ...unscoped, fence_id: "takeover-1" }),
    "missing_field",
    "$.baton_token",
  );
  expectParseError(
    edge.parseTakeoverAckRequest({ ...takeoverAck.request, baton_token: 0 }),
    "invalid_value",
    "$.baton_token",
  );
  const implied = { ...takeoverAck.request, baton_token: null };
  expectParsed(edge.parseTakeoverAckRequest(implied), implied);
  expectParseError(
    edge.parseTakeoverAckRequest({ ...takeoverAck.request, turn: null }),
    "invalid_type",
    "$.turn",
  );
  for (const status of ["duplicate", "stale"]) {
    const outcome = { v: 1, status };
    expectParsed(edge.parseTakeoverAckResponse(outcome), outcome);
  }
  expectParseError(
    edge.parseTakeoverAckResponse({ v: 1, status: "completed" }),
    "invalid_value",
    "$.status",
  );
});
