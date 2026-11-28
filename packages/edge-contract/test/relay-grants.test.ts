import { test } from "bun:test";
import { RELAY_MAX_GRANTS_PER_TOKEN } from "@codecast/relay-contract";
import {
  parseRelayGrantRequest,
  parseRelayGrantResponse,
  type RelayGrantRequest,
  type RelayGrantResponse,
} from "../src";
import { expectParsed, expectParseError } from "./assertions";

const maxSessions = Math.max(1, Math.floor(RELAY_MAX_GRANTS_PER_TOKEN / 2));
const sessions = Array.from({ length: maxSessions + 1 }, (_, index) => ({
  session: `session-${index}`,
  run: 1,
  fencing_token: `fence-${index}`,
}));

test("relay grant requests accept up to half of RELAY_MAX_GRANTS_PER_TOKEN distinct fenced sessions", () => {
  for (const count of [1, maxSessions]) {
    const request: RelayGrantRequest = {
      v: 1,
      sessions: sessions.slice(0, count),
    };
    expectParsed(parseRelayGrantRequest(request), request);
  }
  expectParseError(
    parseRelayGrantRequest({
      v: 1,
      sessions: sessions.slice(0, 1),
      token_deltas: true,
    }),
    "unknown_field",
    "$.token_deltas",
  );
  for (const invalid of [[], sessions, [sessions[0], sessions[0]]]) {
    expectParseError(
      parseRelayGrantRequest({ v: 1, sessions: invalid }),
      "invalid_value",
      "$.sessions",
    );
  }
  expectParseError(
    parseRelayGrantRequest({ v: 1, ...sessions[0] }),
    "unknown_field",
    "$.session",
  );
  expectParseError(
    parseRelayGrantRequest({ v: 1, sessions: [{ ...sessions[0], run: 0 }] }),
    "invalid_value",
    "$.sessions[0].run",
  );
});

test("relay grant responses carry the secure relay endpoint and a positive lifetime", () => {
  const accepted = {
    v: 1,
    status: "ok",
    token: "signed",
    url: "wss://relay.example.test/relay",
    ttl_ms: 30_000,
  } satisfies RelayGrantResponse;
  expectParsed(parseRelayGrantResponse(accepted), accepted);
  for (const url of [
    "ws://relay.example.test/relay",
    "wss://relay.example.test",
    "wss://u:p@relay.example.test/relay",
    `${accepted.url}?`,
    `${accepted.url}#`,
    ` ${accepted.url}`,
    `${accepted.url} `,
  ]) {
    expectParseError(
      parseRelayGrantResponse({ ...accepted, url }),
      "invalid_value",
      "$.url",
    );
  }
  expectParseError(
    parseRelayGrantResponse({ ...accepted, ttl_ms: 0 }),
    "invalid_value",
    "$.ttl_ms",
  );
  for (const status of ["stale", "unavailable", "rate_limited"] as const) {
    const response = { v: 1, status };
    expectParsed(parseRelayGrantResponse(response), response);
  }
  const throttled = {
    v: 1,
    status: "error",
    code: "rate_limited",
    retryable: true,
    retry_after_ms: 60_000,
  } satisfies RelayGrantResponse;
  expectParsed(parseRelayGrantResponse(throttled), throttled);
});
