import { describe, expect, test } from "bun:test";
import * as edge from "@codecast/shared/contracts/edge/v1";
import claim from "./__fixtures__/claim.json";
import renew from "./__fixtures__/renew.json";
import release from "./__fixtures__/release.json";
import hello from "./__fixtures__/hello.json";
import heartbeat from "./__fixtures__/heartbeat.json";
import policyGet from "./__fixtures__/policy.get.json";
import eventsAppend from "./__fixtures__/events.append.json";
import blobsPut from "./__fixtures__/blobs.put.json";
import delta from "./__fixtures__/message.delta.json";
import permitsNext from "./__fixtures__/permits.next.json";
import deliveryStart from "./__fixtures__/delivery.start.json";
import deliverySettle from "./__fixtures__/delivery.settle.json";
import commandsNext from "./__fixtures__/commands.next.json";
import commandsResult from "./__fixtures__/commands.result.json";

function expectParsed(result: edge.EdgeParseResult<unknown>, value: unknown) {
  expect(result).toEqual({ ok: true, value });
}

function expectParseError(
  result: edge.EdgeParseResult<unknown>,
  code: edge.EdgeParseErrorCode,
  path: string,
) {
  if (result.ok) throw new Error(`Expected ${code} at ${path}`);
  expect(result.error).toBeInstanceOf(edge.EdgeParseError);
  expect(result.error.code).toBe(code);
  expect(result.error.path).toBe(path);
}

const verbs = [
  ["hello", hello, edge.parseHelloRequest, edge.parseHelloResponse],
  ["heartbeat", heartbeat, edge.parseHeartbeatRequest, edge.parseHeartbeatResponse],
  ["policy.get", policyGet, edge.parsePolicyGetRequest, edge.parsePolicyGetResponse],
  ["events.append", eventsAppend, edge.parseEventsAppendRequest, edge.parseEventsAppendResponse],
  ["blobs.put", blobsPut, edge.parseBlobsPutRequest, edge.parseBlobsPutResponse],
  ["permits.next", permitsNext, edge.parsePermitsNextRequest, edge.parsePermitsNextResponse],
  ["delivery.start", deliveryStart, edge.parseDeliveryStartRequest, edge.parseDeliveryStartResponse],
  ["delivery.settle", deliverySettle, edge.parseDeliverySettleRequest, edge.parseDeliverySettleResponse],
  ["commands.next", commandsNext, edge.parseCommandsNextRequest, edge.parseCommandsNextResponse],
  ["commands.result", commandsResult, edge.parseCommandsResultRequest, edge.parseCommandsResultResponse],
  ["claim", claim, edge.parseClaimRequest, edge.parseClaimResponse],
  ["renew", renew, edge.parseRenewRequest, edge.parseRenewResponse],
  ["release", release, edge.parseReleaseRequest, edge.parseReleaseResponse],
] as const;

for (const [verb, fixture, parseRequest, parseResponse] of verbs) {
  describe(verb, () => {
    test("preserves the golden request and response", () => {
      expectParsed(parseRequest(fixture.request), fixture.request);
      expectParsed(parseResponse(fixture.response), fixture.response);
    });

    test("rejects malformed requests and responses", () => {
      expectParseError(parseRequest(null), "invalid_type", "$");
      expectParseError(parseResponse([]), "invalid_type", "$");
      expectParseError(parseRequest({ ...fixture.request, extra: 1 }), "unknown_field", "$.extra");
      expectParseError(parseResponse({ ...fixture.response, extra: 1 }), "unknown_field", "$.extra");
    });

    if (verb !== "hello") {
      test("rejects other wire versions", () => {
        expectParseError(parseRequest({ ...fixture.request, v: 2 }), "invalid_value", "$.v");
        expectParseError(parseResponse({ ...fixture.response, v: 2 }), "invalid_value", "$.v");
      });
    }
  });
}

describe("version negotiation", () => {
  test("selects the highest common version regardless of input order", () => {
    expect(edge.EDGE_PROTOCOL_VERSION).toBe(1);
    expect(edge.negotiateEdgeVersion([1, 3, 2], new Set([1, 2]))).toEqual({ status: "ok", version: 2 });
  });

  test("selects N-1 for a daemon one release behind", () => {
    expect(edge.negotiateEdgeVersion([1], new Set([2, 1]))).toEqual({ status: "ok", version: 1 });
  });

  test("returns a parsable upgrade response without a shared version", () => {
    const expected: edge.EdgeVersionNegotiation = { status: "upgrade_required", supported_versions: [3, 2] };
    expect(edge.negotiateEdgeVersion([1], new Set([2, 3]))).toEqual(expected);
    expectParsed(edge.parseHelloResponse(expected), expected);
  });

  test("validates versions and nested host capacity", () => {
    expectParseError(edge.parseHelloRequest({ ...hello.request, versions: ["1"] }), "invalid_type", "$.versions[0]");
    const capacity = { ...hello.request.capacity, memory_available_bytes: -1 };
    expectParseError(edge.parseHelloRequest({ ...hello.request, capacity }), "invalid_value", "$.capacity.memory_available_bytes");
  });
});

describe("canonical events", () => {
  const first = eventsAppend.request.events[0];

  test("rejects unknown kinds, absent sequence numbers, and wrong field types", () => {
    expectParseError(edge.parseCanonicalEvent({ ...first, kind: "other" }), "invalid_value", "$.kind");
    const { seq, ...withoutSeq } = first;
    expectParseError(edge.parseCanonicalEvent(withoutSeq), "missing_field", "$.seq");
    expectParseError(edge.parseCanonicalEvent({ ...first, seq: String(seq) }), "invalid_type", "$.seq");
    expectParseError(edge.parseCanonicalEvent({ ...first, seq: Number.MAX_SAFE_INTEGER + 1 }), "invalid_value", "$.seq");
    expectParseError(edge.parseCanonicalEvent({ ...first, body: { machine: "local" } }), "missing_field", "$.body.provider");
    expectParseError(
      edge.parseCanonicalEvent({ ...first, body: { ...first.body, extra: true } }),
      "unknown_field", "$.body.extra",
    );
  });

  test("preserves the absence of a delivery ID", () => {
    const userEvent = { ...first, kind: "message.user", body: { text: "hello", authors: [] } };
    expectParsed(edge.parseCanonicalEvent(userEvent), userEvent);
    expectParseError(
      edge.parseCanonicalEvent({ ...userEvent, body: { ...userEvent.body, delivery_id: null } }),
      "invalid_type", "$.body.delivery_id",
    );
  });

  test("keeps the relay-only delta out of durable event batches", () => {
    expectParsed(edge.parseMessageDelta(delta), delta);
    expectParseError(
      edge.parseEventsAppendRequest({ ...eventsAppend.request, events: [{ ...delta, seq: 1 }] }),
      "invalid_value", "$.events[0].kind",
    );
  });

  test("checks claim scope and event order within an append", () => {
    expectParseError(
      edge.parseEventsAppendRequest({ ...eventsAppend.request, events: [{ ...first, run: first.run + 1 }] }),
      "invalid_value", "$.events[0]",
    );
    expectParseError(
      edge.parseEventsAppendRequest({ ...eventsAppend.request, events: [first, first] }),
      "invalid_value", "$.events[1].seq",
    );
    expectParseError(
      edge.parseEventsAppendRequest({ ...eventsAppend.request, events: [] }),
      "invalid_value", "$.events",
    );
  });

  test("validates opaque JSON payloads and blob encoding", () => {
    const output: { cycle?: unknown } = {};
    output.cycle = output;
    expectParseError(edge.parseCommandsResultRequest({ ...commandsResult.request, output }), "invalid_value", "$.output.cycle");
    expectParseError(
      edge.parseCommandsResultRequest({ ...commandsResult.request, output: { raw: Infinity } }),
      "invalid_type", "$.output.raw",
    );
    expectParseError(
      edge.parseBlobsPutRequest({ ...blobsPut.request, data_base64: "not-base64" }),
      "invalid_value", "$.data_base64",
    );
  });
});

describe("permits and claims", () => {
  test("parses an authorized steer permit for an agent sender", () => {
    const permit = { ...permitsNext.response, intent: "steer" };
    expectParsed(edge.parsePermitsNextResponse(permit), permit);
  });

  test("checks sender, effective intent, and outcome", () => {
    const request = deliverySettle.request;
    expectParseError(edge.parseDeliverySettleRequest({ ...request, intent: "send" }), "invalid_value", "$.intent");
    expectParseError(edge.parseDeliverySettleRequest({ ...request, outcome: "sent" }), "invalid_value", "$.outcome");
    expectParseError(
      edge.parseDeliverySettleRequest({ ...request, sender: { ...request.sender, kind: "system" } }),
      "invalid_value", "$.sender.kind",
    );
  });

  test("requires a token on claimed writes", () => {
    const cases = [
      [eventsAppend.request, edge.parseEventsAppendRequest],
      [deliveryStart.request, edge.parseDeliveryStartRequest],
      [deliverySettle.request, edge.parseDeliverySettleRequest],
      [renew.request, edge.parseRenewRequest],
      [release.request, edge.parseReleaseRequest],
    ] as const;
    for (const [request, parse] of cases) {
      const { fencing_token: _token, ...withoutToken } = request;
      expectParseError(parse(withoutToken), "missing_field", "$.fencing_token");
    }
    const { fencing_token: _token, ...commandClaim } = commandsResult.request.claim;
    expectParseError(
      edge.parseCommandsResultRequest({ ...commandsResult.request, claim: commandClaim }),
      "missing_field", "$.claim.fencing_token",
    );
  });

  test("accepts a machine command result without a claim", () => {
    const { claim: _claim, ...result } = commandsResult.request;
    expectParsed(edge.parseCommandsResultRequest(result), result);
  });
});
