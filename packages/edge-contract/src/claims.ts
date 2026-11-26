import { RELAY_MAX_GRANTS_PER_TOKEN } from "@codecast/relay-contract";
import {
  array,
  count,
  EdgeParseError,
  nonEmptyString,
  optional,
  object,
  oneOf,
  parser,
  responseObject,
  positiveInteger,
  tagged,
  type Reader,
} from "./parse";
import { readV1 } from "./version";
import { response } from "./response";
import { daemon } from "./link";

const session = nonEmptyString;
export const claimScope = { session, run: positiveInteger };
export const fence = { ...claimScope, fencing_token: nonEmptyString };

const claimRequest = object({
  v: readV1,
  session,
  ...daemon,
  claim_id: nonEmptyString,
});
const claimResponse = response(
  tagged("status", {
    granted: responseObject({
      v: readV1,
      status: oneOf("granted"),
      ...fence,
      lease_ms: positiveInteger,
      last_pane_instance: count,
      last_event_seq: optional(count),
    }),
    busy: responseObject({
      v: readV1,
      status: oneOf("busy"),
      retry_after_ms: count,
    }),
    stale: responseObject({ v: readV1, status: oneOf("stale") }),
  }),
);
const renewRequest = object({ v: readV1, ...fence });
const renewResponse = response(
  tagged("status", {
    renewed: responseObject({
      v: readV1,
      status: oneOf("renewed"),
      lease_ms: positiveInteger,
    }),
    stale: responseObject({ v: readV1, status: oneOf("stale") }),
  }),
);
const releaseRequest = object({ v: readV1, ...fence });
const releaseResponse = response(
  responseObject({ v: readV1, status: oneOf("released", "stale") }),
);

export type ClaimRequest = ReturnType<typeof claimRequest>;
export type ClaimResponse = ReturnType<typeof claimResponse>;
export type RenewRequest = ReturnType<typeof renewRequest>;
export type RenewResponse = ReturnType<typeof renewResponse>;
export type ReleaseRequest = ReturnType<typeof releaseRequest>;
export type ReleaseResponse = ReturnType<typeof releaseResponse>;

export const parseClaimRequest = parser(claimRequest);
export const parseClaimResponse = parser(claimResponse);
export const parseRenewRequest = parser(renewRequest);
export const parseRenewResponse = parser(renewResponse);
export const parseReleaseRequest = parser(releaseRequest);
export const parseReleaseResponse = parser(releaseResponse);

const readRelayGrantSessions = array(object(fence));
const relayGrantRequest = object({
  v: readV1,
  sessions(value, path) {
    if (
      Array.isArray(value) &&
      (value.length === 0 || value.length > RELAY_MAX_GRANTS_PER_TOKEN)
    ) {
      throw new EdgeParseError(
        "invalid_value",
        path,
        "invalid relay grant count",
      );
    }
    const sessions = readRelayGrantSessions(value, path);
    if (
      new Set(sessions.map(({ session }) => session)).size !== sessions.length
    ) {
      throw new EdgeParseError("invalid_value", path, "duplicate session");
    }
    return sessions;
  },
});

export function isRelayGrantUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.pathname === "/relay" &&
      url.origin + url.pathname === value
    );
  } catch {
    return false;
  }
}

const relayGrantUrl: Reader<string> = (value, path) => {
  const url = nonEmptyString(value, path);
  if (!isRelayGrantUrl(url))
    throw new EdgeParseError(
      "invalid_value",
      path,
      "expected a secure relay URL",
    );
  return url;
};

const relayGrantResponse = response(
  tagged("status", {
    ok: responseObject({
      v: readV1,
      status: oneOf("ok"),
      token: nonEmptyString,
      url: relayGrantUrl,
      ttl_ms: positiveInteger,
    }),
    stale: responseObject({ v: readV1, status: oneOf("stale") }),
    unavailable: responseObject({ v: readV1, status: oneOf("unavailable") }),
    rate_limited: responseObject({ v: readV1, status: oneOf("rate_limited") }),
  }),
);

export type RelayGrantRequest = ReturnType<typeof relayGrantRequest>;
export type RelayGrantResponse = ReturnType<typeof relayGrantResponse>;

export const parseRelayGrantRequest = parser(relayGrantRequest);
export const parseRelayGrantResponse = parser(relayGrantResponse);
