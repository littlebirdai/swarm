import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as current from "../src";
import * as previous from "./n-1/schema";

type WireObject = Record<string, unknown>;
type WirePair = { request: WireObject; response: WireObject };
type ParseResult = { ok: boolean; value?: unknown; error?: unknown };
type Parser = (value: unknown) => ParseResult;

const N1_DIR = join(import.meta.dir, "n-1");
const FIXTURES_DIR = join(N1_DIR, "fixtures");
const CURRENT_FIXTURES_DIR = join(import.meta.dir, "fixtures");

const THREE_STEP_GUIDANCE =
  "Make breaking contract changes in three steps: " +
  "(1) expand — add the new field or verb while keeping the N-1 field or verb accepted and emitted; " +
  "(2) migrate — deploy the server and wait until machines and clients upgrade past N-1; " +
  "(3) contract — refresh the N-1 baseline when cutting the next release, then remove the old N-1 field or verb.";

const VERB_PARSERS = [
  ["hello", "parseHelloRequest", "parseHelloResponse", true],
  ["heartbeat", "parseHeartbeatRequest", "parseHeartbeatResponse", true],
  ["policy.get", "parsePolicyGetRequest", "parsePolicyGetResponse", true],
  ["claim", "parseClaimRequest", "parseClaimResponse", true],
  ["renew", "parseRenewRequest", "parseRenewResponse", true],
  ["release", "parseReleaseRequest", "parseReleaseResponse", true],
  ["relay-grant", "parseRelayGrantRequest", "parseRelayGrantResponse", true],
  ["permits.next", "parsePermitsNextRequest", "parsePermitsNextResponse", true],
  [
    "delivery.start",
    "parseDeliveryStartRequest",
    "parseDeliveryStartResponse",
    true,
  ],
  [
    "delivery.settle",
    "parseDeliverySettleRequest",
    "parseDeliverySettleResponse",
    true,
  ],
  ["takeover.ack", "parseTakeoverAckRequest", "parseTakeoverAckResponse", true],
  [
    "commands.next",
    "parseCommandsNextRequest",
    "parseCommandsNextResponse",
    true,
  ],
  [
    "commands.result",
    "parseCommandsResultRequest",
    "parseCommandsResultResponse",
    true,
  ],
  [
    "events.append",
    "parseEventsAppendRequest",
    "parseEventsAppendResponse",
    true,
  ],
  ["blobs.put", "parseBlobsPutRequest", "parseBlobsPutResponse", true],
  [
    "transcripts.append",
    "parseTranscriptAppendRequest",
    "parseTranscriptAppendResponse",
    false,
  ],
] as const;

function failBreaking(detail: string): never {
  throw new Error(
    `Breaking change to N-1 edge contract: ${detail}\n${THREE_STEP_GUIDANCE}`,
  );
}

function getParser(
  contract: Record<string, unknown>,
  name: string,
  verb: string,
): Parser {
  const fn = contract[name];
  if (typeof fn !== "function") {
    failBreaking(`missing parser ${name} for N-1 verb "${verb}".`);
  }
  return fn as Parser;
}

function assertMatchesN1(parse: Parser, wire: unknown, label: string): unknown {
  const result = parse(wire);
  if (!result.ok) {
    failBreaking(`${label} failed to decode (${String(result.error)}).`);
  }
  if (!Bun.deepEquals(result.value, wire, true)) {
    failBreaking(
      `${label} dropped or altered N-1 fields: expected ${JSON.stringify(wire)}, got ${JSON.stringify(result.value)}.`,
    );
  }
  return result.value;
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function dirHashes(dir: string): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const sub of ["schema", "fixtures"]) {
    const files = (await readdir(join(dir, sub))).sort();
    for (const file of files) {
      const rel = `${sub}/${file}`;
      const bytes = await readFile(join(dir, rel));
      entries.push([
        rel,
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      ]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

export async function assertEdgeBackwardCompatible(
  contract: Record<string, unknown>,
  fixturesDir = FIXTURES_DIR,
): Promise<void> {
  const variants = await loadJson<Record<string, WireObject[]>>(
    join(fixturesDir, "response-variants.json"),
  );
  const errors = await loadJson<WireObject[]>(join(fixturesDir, "errors.json"));

  for (const [
    verb,
    requestName,
    responseName,
    acceptsEdgeError,
  ] of VERB_PARSERS) {
    const parseRequest = getParser(contract, requestName, verb);
    const parseResponse = getParser(contract, responseName, verb);
    const wire = await loadJson<WirePair>(join(fixturesDir, `${verb}.json`));
    assertMatchesN1(parseRequest, wire.request, `${verb} request`);
    assertMatchesN1(parseResponse, wire.response, `${verb} response`);
    for (const [index, variant] of (variants[verb] ?? []).entries()) {
      assertMatchesN1(
        parseResponse,
        variant,
        `${verb} response variant[${index}]`,
      );
    }
    if (acceptsEdgeError) {
      for (const [index, error] of errors.entries()) {
        assertMatchesN1(parseResponse, error, `${verb} error[${index}]`);
      }
    }
  }

  const blobsGet = await loadJson<{
    request: WireObject;
    not_found: WireObject;
  }>(join(fixturesDir, "blobs.get.json"));
  const parseBlobsGetRequest = getParser(
    contract,
    "parseBlobsGetRequest",
    "blobs.get",
  );
  const parseEdgeErrorResponse = getParser(
    contract,
    "parseEdgeErrorResponse",
    "error",
  );
  assertMatchesN1(parseBlobsGetRequest, blobsGet.request, "blobs.get request");
  assertMatchesN1(
    parseEdgeErrorResponse,
    blobsGet.not_found,
    "blobs.get not_found error",
  );

  const parseCanonicalEvent = getParser(
    contract,
    "parseCanonicalEvent",
    "canonical-event",
  );
  for (const file of ["prompt.opened", "tool-result-inline"]) {
    const event = await loadJson<WireObject>(join(fixturesDir, `${file}.json`));
    assertMatchesN1(parseCanonicalEvent, event, file);
  }

  const parseMessageDelta = getParser(
    contract,
    "parseMessageDelta",
    "message.delta",
  );
  const delta = await loadJson<WireObject>(
    join(fixturesDir, "message.delta.json"),
  );
  assertMatchesN1(parseMessageDelta, delta, "message.delta");

  const resolutions = await loadJson<Record<string, WirePair[]>>(
    join(fixturesDir, "delivery-resolution.json"),
  );
  const parseDeliverySettleRequest = getParser(
    contract,
    "parseDeliverySettleRequest",
    "delivery.settle",
  );
  const parseDeliverySettleResponse = getParser(
    contract,
    "parseDeliverySettleResponse",
    "delivery.settle",
  );
  for (const [label, steps] of Object.entries(resolutions)) {
    for (const [index, step] of steps.entries()) {
      assertMatchesN1(
        parseDeliverySettleRequest,
        step.request,
        `delivery-resolution ${label}[${index}] request`,
      );
      assertMatchesN1(
        parseDeliverySettleResponse,
        step.response,
        `delivery-resolution ${label}[${index}] response`,
      );
    }
  }

  const guarded = await loadJson<{
    steer: WireObject;
    stale_steer: WireObject;
    commands: WireObject[];
    stale_commands: WireObject[];
  }>(join(fixturesDir, "guarded-actions.json"));
  const permit = await loadJson<WirePair>(
    join(fixturesDir, "permits.next.json"),
  );
  const next = await loadJson<WirePair>(
    join(fixturesDir, "commands.next.json"),
  );
  const settle = await loadJson<WirePair>(
    join(fixturesDir, "delivery.settle.json"),
  );
  const result = await loadJson<WirePair>(
    join(fixturesDir, "commands.result.json"),
  );

  assertMatchesN1(
    getParser(contract, "parsePermitsNextResponse", "permits.next"),
    { ...permit.response, ...guarded.steer },
    "guarded steer permit",
  );
  assertMatchesN1(
    parseDeliverySettleRequest,
    { ...settle.request, ...guarded.stale_steer },
    "guarded stale steer",
  );
  const parseCommandsNextResponse = getParser(
    contract,
    "parseCommandsNextResponse",
    "commands.next",
  );
  for (const [index, fields] of guarded.commands.entries()) {
    assertMatchesN1(
      parseCommandsNextResponse,
      { ...next.response, ...fields },
      `guarded command[${index}]`,
    );
  }
  const { output: _output, ...commandResultBase } = result.request;
  const parseCommandsResultRequest = getParser(
    contract,
    "parseCommandsResultRequest",
    "commands.result",
  );
  for (const [index, fields] of guarded.stale_commands.entries()) {
    assertMatchesN1(
      parseCommandsResultRequest,
      { ...commandResultBase, ...fields },
      `guarded stale command[${index}]`,
    );
  }
}

describe("edge contract N-1 compatibility guard", () => {
  test("frozen N-1 baseline manifest matches every committed schema and fixture file", async () => {
    const manifest = await loadJson<{
      revision: string | null;
      hashes: Record<string, string>;
    }>(join(N1_DIR, "manifest.json"));
    expect(await dirHashes(N1_DIR)).toEqual(manifest.hashes);
  });

  test("current edge-contract preserves all N-1 verbs, fields, and variants", async () => {
    await assertEdgeBackwardCompatible(current);
  });

  test("frozen N-1 decoders accept current fixture responses with additive fields", async () => {
    const variants = await loadJson<Record<string, WireObject[]>>(
      join(CURRENT_FIXTURES_DIR, "response-variants.json"),
    );
    const errors = await loadJson<WireObject[]>(
      join(CURRENT_FIXTURES_DIR, "errors.json"),
    );
    for (const [
      verb,
      _requestName,
      responseName,
      acceptsEdgeError,
    ] of VERB_PARSERS) {
      const parseResponse = getParser(
        previous as unknown as Record<string, unknown>,
        responseName,
        verb,
      );
      const wire = await loadJson<WirePair>(
        join(CURRENT_FIXTURES_DIR, `${verb}.json`),
      );
      for (const value of [
        wire.response,
        ...(variants[verb] ?? []),
        ...(acceptsEdgeError ? errors : []),
      ]) {
        const parsed = parseResponse({ ...value, future_additive_field: 1 });
        expect(parsed.ok, `${verb} N-1 response decode`).toBe(true);
        expect(parsed.value).toEqual(value);
      }
    }
  });

  test("guard fails with expand/migrate/contract guidance when a verb or field is removed or renamed", async () => {
    const missingVerb = { ...current, parseHeartbeatRequest: undefined };
    await expect(assertEdgeBackwardCompatible(missingVerb)).rejects.toThrow(
      /expand[\s\S]*migrate[\s\S]*contract/i,
    );

    const rejectedField = {
      ...current,
      parseClaimRequest: (value: unknown) => {
        const record = value as WireObject;
        if ("claim_id" in record) {
          return { ok: false, error: "unknown_field $.claim_id" };
        }
        return current.parseClaimRequest(value);
      },
    };
    await expect(assertEdgeBackwardCompatible(rejectedField)).rejects.toThrow(
      /expand[\s\S]*migrate[\s\S]*contract/i,
    );

    const droppedResponseField = {
      ...current,
      parseHeartbeatResponse: (value: unknown) => {
        const parsed = current.parseHeartbeatResponse(value);
        if (!parsed.ok) return parsed;
        const { policy_revision: _dropped, ...rest } = parsed.value as Record<
          string,
          unknown
        >;
        return { ok: true, value: rest };
      },
    };
    await expect(
      assertEdgeBackwardCompatible(droppedResponseField),
    ).rejects.toThrow(/expand[\s\S]*migrate[\s\S]*contract/i);
  });
});
