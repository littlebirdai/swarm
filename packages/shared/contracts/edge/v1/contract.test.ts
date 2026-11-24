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
import deliveryResolution from "./__fixtures__/delivery-resolution.json";
import commandsNext from "./__fixtures__/commands.next.json";
import commandsResult from "./__fixtures__/commands.result.json";
import responseVariants from "./__fixtures__/response-variants.json";
import errors from "./__fixtures__/errors.json";
import inlineToolResult from "./__fixtures__/tool-result-inline.json";

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
  [
    "heartbeat",
    heartbeat,
    edge.parseHeartbeatRequest,
    edge.parseHeartbeatResponse,
  ],
  [
    "policy.get",
    policyGet,
    edge.parsePolicyGetRequest,
    edge.parsePolicyGetResponse,
  ],
  [
    "events.append",
    eventsAppend,
    edge.parseEventsAppendRequest,
    edge.parseEventsAppendResponse,
  ],
  [
    "blobs.put",
    blobsPut,
    edge.parseBlobsPutRequest,
    edge.parseBlobsPutResponse,
  ],
  [
    "permits.next",
    permitsNext,
    edge.parsePermitsNextRequest,
    edge.parsePermitsNextResponse,
  ],
  [
    "delivery.start",
    deliveryStart,
    edge.parseDeliveryStartRequest,
    edge.parseDeliveryStartResponse,
  ],
  [
    "delivery.settle",
    deliverySettle,
    edge.parseDeliverySettleRequest,
    edge.parseDeliverySettleResponse,
  ],
  [
    "commands.next",
    commandsNext,
    edge.parseCommandsNextRequest,
    edge.parseCommandsNextResponse,
  ],
  [
    "commands.result",
    commandsResult,
    edge.parseCommandsResultRequest,
    edge.parseCommandsResultResponse,
  ],
  ["claim", claim, edge.parseClaimRequest, edge.parseClaimResponse],
  ["renew", renew, edge.parseRenewRequest, edge.parseRenewResponse],
  ["release", release, edge.parseReleaseRequest, edge.parseReleaseResponse],
] as const;

const alternateResponses: Partial<
  Record<(typeof verbs)[number][0], readonly unknown[]>
> = responseVariants;

for (const [verb, fixture, parseRequest, parseResponse] of verbs) {
  describe(verb, () => {
    test("preserves the golden request and response", () => {
      expectParsed(parseRequest(fixture.request), fixture.request);
      expectParsed(parseResponse(fixture.response), fixture.response);
      for (const variant of alternateResponses[verb] ?? []) {
        expectParsed(parseResponse(variant), variant);
      }
      for (const error of errors) {
        expectParsed(parseResponse(error), error);
      }
    });

    test("rejects malformed messages and accepts additive response fields", () => {
      expectParseError(parseRequest(null), "invalid_type", "$");
      expectParseError(parseResponse([]), "invalid_type", "$");
      expectParseError(
        parseRequest({ ...fixture.request, extra: 1 }),
        "unknown_field",
        "$.extra",
      );
      expectParsed(
        parseResponse({ ...fixture.response, extra: 1 }),
        fixture.response,
      );
    });

    if (verb !== "hello") {
      test("rejects other wire versions", () => {
        expectParseError(
          parseRequest({ ...fixture.request, v: 2 }),
          "invalid_value",
          "$.v",
        );
        expectParseError(
          parseResponse({ ...fixture.response, v: 2 }),
          "invalid_value",
          "$.v",
        );
      });
    }
  });
}

describe("version negotiation", () => {
  test("selects the highest common version regardless of input order", () => {
    expect(edge.EDGE_PROTOCOL_VERSION).toBe(1);
    expect(edge.negotiateEdgeVersion([1, 3, 2], new Set([1, 2]))).toEqual({
      status: "ok",
      version: 2,
    });
  });

  test("selects N-1 for a daemon one release behind", () => {
    expect(edge.negotiateEdgeVersion([1], new Set([2, 1]))).toEqual({
      status: "ok",
      version: 1,
    });
  });

  test("returns a parsable upgrade response without a shared version", () => {
    const expected: edge.EdgeVersionNegotiation = {
      status: "upgrade_required",
      supported_versions: [3, 2],
    };
    expect(edge.negotiateEdgeVersion([1], new Set([2, 3]))).toEqual(expected);
    expectParsed(edge.parseHelloResponse(expected), expected);
  });

  test("validates versions and nested host capacity", () => {
    expectParseError(
      edge.parseHelloRequest({ ...hello.request, versions: ["1"] }),
      "invalid_type",
      "$.versions[0]",
    );
    const capacity = { ...hello.request.capacity, memory_available_bytes: -1 };
    expectParseError(
      edge.parseHelloRequest({ ...hello.request, capacity }),
      "invalid_value",
      "$.capacity.memory_available_bytes",
    );
  });
});

test("reports server_behind when every offered version is newer", () => {
  expect(edge.negotiateEdgeVersion([4, 3], new Set([1, 2]))).toEqual({
    status: "server_behind",
    supported_versions: [2, 1],
  });
  expect(edge.negotiateEdgeVersion([4, 1], new Set([2, 3])).status).toBe(
    "upgrade_required",
  );
});

test("ignores added policy settings while checking known fields", () => {
  const { policy } = policyGet.response;
  const limits = { ...policy.limits, max_sessions: 50 };
  expectParsed(
    edge.parsePolicyGetResponse({
      ...policyGet.response,
      policy: { ...policy, limits, future_policy: true },
    }),
    policyGet.response,
  );
  expectParseError(
    edge.parsePolicyGetResponse({
      ...policyGet.response,
      policy: { ...policy, limits: { ...limits, max_batch_bytes: "large" } },
    }),
    "invalid_type",
    "$.policy.limits.max_batch_bytes",
  );
});

test("validates the shared backpressure response", () => {
  const [limited] = errors;
  expectParsed(
    edge.parseEdgeErrorResponse({ ...limited, future: true }),
    limited,
  );
  expectParseError(
    edge.parseEdgeErrorResponse({ ...limited, retryable: 1 }),
    "invalid_type",
    "$.retryable",
  );
  expectParseError(
    edge.parsePolicyGetResponse({ ...limited, retry_after_ms: -1 }),
    "invalid_value",
    "$.retry_after_ms",
  );
});

test("preserves retry instructions for an unknown server error code", () => {
  const error = errors.find(({ code }) => code === "not_found")!;
  expectParsed(edge.parseEdgeErrorResponse(error), error);
  expectParsed(edge.parsePolicyGetResponse(error), error);
});

describe("canonical events", () => {
  const [batch] = eventsAppend.request.batches;
  const [first] = batch.events;

  const append = (events: unknown[]) =>
    edge.parseEventsAppendRequest({
      v: 1,
      batches: [{ ...batch, events }],
    });

  test("rejects unknown kinds, absent sequence numbers, and wrong field types", () => {
    expectParseError(
      edge.parseCanonicalEvent({ ...first, kind: "other" }),
      "invalid_value",
      "$.kind",
    );
    const { seq, ...withoutSeq } = first;
    expectParseError(
      edge.parseCanonicalEvent(withoutSeq),
      "missing_field",
      "$.seq",
    );
    expectParseError(
      edge.parseCanonicalEvent({ ...first, seq: String(seq) }),
      "invalid_type",
      "$.seq",
    );
    expectParseError(
      edge.parseCanonicalEvent({ ...first, seq: Number.MAX_SAFE_INTEGER + 1 }),
      "invalid_value",
      "$.seq",
    );
    expectParseError(
      edge.parseCanonicalEvent({ ...first, body: { machine: "local" } }),
      "missing_field",
      "$.body.provider",
    );
    expectParseError(
      edge.parseCanonicalEvent({
        ...first,
        body: { ...first.body, extra: true },
      }),
      "unknown_field",
      "$.body.extra",
    );
  });

  test("preserves the absence of a delivery ID", () => {
    const userEvent = {
      ...first,
      kind: "message.user",
      body: { text: "hello", authors: [] },
    };
    expectParsed(edge.parseCanonicalEvent(userEvent), userEvent);
    expectParseError(
      edge.parseCanonicalEvent({
        ...userEvent,
        body: { ...userEvent.body, delivery_id: null },
      }),
      "invalid_type",
      "$.body.delivery_id",
    );
  });

  test("keeps the relay-only delta out of durable event batches", () => {
    expectParsed(edge.parseMessageDelta(delta), delta);
    expectParseError(
      append([{ ...delta, seq: 1 }]),
      "invalid_value",
      "$.batches[0].events[0].kind",
    );
    expectParseError(
      edge.parseMessageDelta({ ...delta, body: { ...delta.body, offset: -1 } }),
      "invalid_value",
      "$.body.offset",
    );
  });

  test("checks claim scope and event order within an append", () => {
    expectParseError(
      append([{ ...first, run: first.run + 1 }]),
      "invalid_value",
      "$.batches[0].events[0]",
    );
    expectParseError(
      append([{ ...first, session: "another-session" }]),
      "invalid_value",
      "$.batches[0].events[0]",
    );
    expectParseError(
      append([first, first]),
      "invalid_value",
      "$.batches[0].events[1].seq",
    );
    expectParseError(
      append([first, { ...first, seq: first.seq + 2 }]),
      "invalid_value",
      "$.batches[0].events[1].seq",
    );
    expectParseError(append([]), "invalid_value", "$.batches[0].events");
    expectParseError(
      edge.parseEventsAppendRequest({ v: 1, batches: [] }),
      "invalid_value",
      "$.batches",
    );
  });

  test("validates per-group results while ignoring added fields in each result", () => {
    const [response] = responseVariants["events.append"];
    const results = response.results.map((result) => ({
      ...result,
      future: "ignored",
    }));
    expectParsed(
      edge.parseEventsAppendResponse({ ...response, results }),
      response,
    );
    expectParseError(
      edge.parseEventsAppendResponse({
        v: 1,
        results: [{ session: "session-1", status: "gap" }],
      }),
      "missing_field",
      "$.results[0].expected_seq",
    );
  });

  test("distinguishes inline JSON containing blob_id from a blob reference", () => {
    expectParsed(edge.parseCanonicalEvent(inlineToolResult), inlineToolResult);
    expectParseError(
      edge.parseCanonicalEvent({
        ...inlineToolResult,
        body: { ...inlineToolResult.body, output: { blob_id: 5 } },
      }),
      "invalid_type",
      "$.body.output.blob_id",
    );
    expectParseError(
      edge.parseCanonicalEvent({
        ...inlineToolResult,
        body: {
          ...inlineToolResult.body,
          output: { inline: null, blob_id: "blob-1" },
        },
      }),
      "unknown_field",
      "$.body.output.blob_id",
    );
  });

  test("keeps outcomes out of receipt events", () => {
    const receipt = batch.events.find((event) => event.kind === "receipt")!;
    expectParseError(
      edge.parseCanonicalEvent({
        ...receipt,
        body: { ...receipt.body, outcome: "applied" },
      }),
      "unknown_field",
      "$.body.outcome",
    );
  });

  test("validates opaque JSON payloads and blob encoding", () => {
    const output: { cycle?: unknown } = {};
    output.cycle = output;
    expectParseError(
      edge.parseCommandsResultRequest({ ...commandsResult.request, output }),
      "invalid_value",
      "$.output.cycle",
    );
    expectParseError(
      edge.parseCommandsResultRequest({
        ...commandsResult.request,
        output: { raw: Infinity },
      }),
      "invalid_type",
      "$.output.raw",
    );
    expectParseError(
      edge.parseBlobsPutRequest({
        ...blobsPut.request,
        data_base64: "not-base64",
      }),
      "invalid_value",
      "$.data_base64",
    );
    expectParseError(
      edge.parseBlobsPutRequest({ ...blobsPut.request, sha256: "abc" }),
      "invalid_value",
      "$.sha256",
    );
  });
});

describe("permits and claims", () => {
  for (const [label, steps] of Object.entries(deliveryResolution)) {
    test(`records the ${label} resolution of an in-doubt attempt and identifies its replay`, () => {
      for (const { request, response } of steps) {
        expectParsed(edge.parseDeliverySettleRequest(request), request);
        expectParsed(edge.parseDeliverySettleResponse(response), response);
      }
    });
  }

  test("rejects blank evidence and evidence on outcomes that cannot resolve an attempt", () => {
    const correlated = deliveryResolution["correlated delivery"][1].request;
    expectParseError(
      edge.parseDeliverySettleRequest({
        ...correlated,
        resolution_evidence: " \n ",
      }),
      "invalid_value",
      "$.resolution_evidence",
    );
    expectParseError(
      edge.parseDeliverySettleRequest({
        ...correlated,
        outcome: "in_doubt",
      }),
      "invalid_value",
      "$.outcome",
    );
  });

  test("parses an authorized steer permit for an agent sender", () => {
    const permit = { ...permitsNext.response, intent: "steer" };
    expectParsed(edge.parsePermitsNextResponse(permit), permit);
  });

  test("checks sender, effective intent, and outcome", () => {
    const request = deliverySettle.request;
    expectParseError(
      edge.parseDeliverySettleRequest({ ...request, intent: "send" }),
      "invalid_value",
      "$.intent",
    );
    expectParseError(
      edge.parseDeliverySettleRequest({ ...request, outcome: "sent" }),
      "invalid_value",
      "$.outcome",
    );
    expectParseError(
      edge.parseDeliverySettleRequest({
        ...request,
        sender: { ...request.sender, kind: "system" },
      }),
      "invalid_value",
      "$.sender.kind",
    );
  });

  test("distinguishes uncertain effects from failures with a retry decision", () => {
    const request = deliverySettle.request;
    for (const outcome of ["duplicate", "rejected", "in_doubt"]) {
      const settlement = { ...request, outcome };
      expectParsed(edge.parseDeliverySettleRequest(settlement), settlement);
    }
    const failed = { ...request, outcome: "failed" };
    for (const retryable of [true, false]) {
      const settlement = { ...failed, retryable };
      expectParsed(edge.parseDeliverySettleRequest(settlement), settlement);
    }
    expectParseError(
      edge.parseDeliverySettleRequest(failed),
      "missing_field",
      "$.retryable",
    );
    expectParseError(
      edge.parseDeliverySettleRequest({ ...request, retryable: true }),
      "unknown_field",
      "$.retryable",
    );
    const { attempt_id: _attempt, ...withoutAttempt } = request;
    expectParseError(
      edge.parseDeliverySettleRequest(withoutAttempt),
      "missing_field",
      "$.attempt_id",
    );
  });

  test("ignores added response fields in permit input and rejects them in request senders", () => {
    const permit = permitsNext.response;
    const input = permit.input.map((part) => ({ ...part, future: "ignored" }));
    const sender = { ...permit.sender, future: "ignored" };
    expectParsed(
      edge.parsePermitsNextResponse({ ...permit, input, sender }),
      permit,
    );
    expectParseError(
      edge.parseDeliveryStartRequest({ ...deliveryStart.request, sender }),
      "unknown_field",
      "$.sender.future",
    );
    expectParseError(
      edge.parsePermitsNextResponse({
        ...permit,
        input: [{ type: "blob", blob_id: "blob-1" }],
      }),
      "missing_field",
      "$.input[0].content_type",
    );
  });

  test("requires a token on claimed writes", () => {
    const cases = [
      [deliveryStart.request, edge.parseDeliveryStartRequest],
      [deliverySettle.request, edge.parseDeliverySettleRequest],
      [renew.request, edge.parseRenewRequest],
      [release.request, edge.parseReleaseRequest],
    ] as const;
    for (const [request, parse] of cases) {
      const { fencing_token: _token, ...withoutToken } = request;
      expectParseError(parse(withoutToken), "missing_field", "$.fencing_token");
    }
    const [batch] = eventsAppend.request.batches;
    const { fencing_token: _eventToken, ...unfencedBatch } = batch;
    expectParseError(
      edge.parseEventsAppendRequest({ v: 1, batches: [unfencedBatch] }),
      "missing_field",
      "$.batches[0].fencing_token",
    );
    const { fencing_token: _token, ...commandClaim } =
      commandsResult.request.claim;
    expectParseError(
      edge.parseCommandsResultRequest({
        ...commandsResult.request,
        claim: commandClaim,
      }),
      "missing_field",
      "$.claim.fencing_token",
    );
  });

  test("rejects a client-assigned run epoch on claim acquisition", () => {
    expectParseError(
      edge.parseClaimRequest({ ...claim.request, run: 3 }),
      "unknown_field",
      "$.run",
    );
    expectParseError(
      edge.parseClaimResponse({ v: 1, status: "busy" }),
      "missing_field",
      "$.retry_after_ms",
    );
  });

  test("accepts a machine command result without a claim", () => {
    const { claim: _claim, ...result } = commandsResult.request;
    expectParsed(edge.parseCommandsResultRequest(result), result);
  });
});
