import { expect, test } from "bun:test";
import * as edge from "@codecast/edge-contract";
import { expectParsed, expectParseError } from "./assertions";
import hello from "./fixtures/hello.json";
import variants from "./fixtures/response-variants.json";
import acknowledgment from "./fixtures/takeover.ack.json";

const fence = variants["permits.next"][0]!;

test("hello offers the outbound fence capability on both sides", () => {
  expect(edge.TAKEOVER_FENCE_CAPABILITY).toBe("takeover-fence-v1");
  expect(hello.request.capabilities).toContain(edge.TAKEOVER_FENCE_CAPABILITY);
  expect(hello.response.policy.capabilities).toContain(
    edge.TAKEOVER_FENCE_CAPABILITY,
  );
  expectParsed(edge.parseHelloRequest(hello.request), hello.request);
  expectParsed(edge.parseHelloResponse(hello.response), hello.response);
});

test("a permit poll round-trips the fence and binds its acknowledgment", () => {
  for (const baton_token of [17, null]) {
    const wire = { ...fence, baton_token };
    const parsed = edge.parsePermitsNextResponse(
      JSON.parse(JSON.stringify({ ...wire, future: true })),
    );
    expectParsed(parsed, wire);
    if (!parsed.ok || parsed.value.status !== "takeover_fence")
      throw new Error("Expected a takeover fence");
    const { status: _status, new_baton_token: _new, ...ack } = parsed.value;
    expectParsed(edge.parseTakeoverAckRequest(ack), {
      ...acknowledgment.request,
      baton_token,
    });
  }
});

test("a fence requires the run claim, turn, unique ID, and both baton tokens", () => {
  for (const field of [
    "session",
    "run",
    "fencing_token",
    "turn",
    "fence_id",
    "baton_token",
    "new_baton_token",
  ]) {
    const { [field as keyof typeof fence]: _missing, ...incomplete } = fence;
    expectParseError(
      edge.parsePermitsNextResponse(incomplete),
      "missing_field",
      `$.${field}`,
    );
  }
  for (const [field, value] of [
    ["v", 2],
    ["session", ""],
    ["run", 0],
    ["fencing_token", ""],
    ["turn", ""],
    ["fence_id", ""],
    ["baton_token", -1],
    ["new_baton_token", Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    expectParseError(
      edge.parsePermitsNextResponse({ ...fence, [field]: value }),
      "invalid_value",
      `$.${field}`,
    );
});

test("a fence refuses a non-advancing new baton token", () => {
  for (const new_baton_token of [16, 17])
    expectParseError(
      edge.parsePermitsNextResponse({ ...fence, new_baton_token }),
      "invalid_value",
      "$.new_baton_token",
    );
  expectParseError(
    edge.parsePermitsNextResponse({
      ...fence,
      baton_token: null,
      new_baton_token: 0,
    }),
    "invalid_value",
    "$.new_baton_token",
  );
});
