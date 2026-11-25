import {
  array,
  id,
  object,
  oneOf,
  parser,
  positive,
  RelayParseError,
  responseObject,
  tagged,
} from "./read";

export const RELAY_GRANT_VERSION = 1;
export const RELAY_MAX_GRANTS_PER_TOKEN = 16;
export const RELAY_MAX_HUBS_PER_CONNECTION = 256;

const session = { kind: oneOf("session"), id };
const machine = { kind: oneOf("machine"), id };
const user = { kind: oneOf("user"), id };

export const sessionHub = object(session);
export const machineHub = object(machine);
export const hub = tagged("kind", { session: sessionHub, machine: machineHub });
export const sessionHubResponse = responseObject(session);
export const machineHubResponse = responseObject(machine);
export const hubResponse = tagged("kind", {
  session: sessionHubResponse,
  machine: machineHubResponse,
});

const userSignals = [
  "presence",
  "draft_cursor",
  "reading_cursor",
  "baton_heartbeat",
] as const;
const sessionLiveness = "session_liveness";
export const machineSignal = "machine_liveness";

const claims = object({
  v: oneOf(1),
  audience: id,
  subject: tagged("kind", { user: object(user), machine: machineHub }),
  expires_at_ms: positive,
  grants: array(
    tagged("kind", {
      session: object({
        ...session,
        publish: array(
          oneOf(...userSignals, sessionLiveness),
          0,
          userSignals.length,
        ),
      }),
      machine: object({
        ...machine,
        publish: array(oneOf(machineSignal), 0, 1),
      }),
    }),
    1,
    RELAY_MAX_GRANTS_PER_TOKEN,
  ),
});

export type RelayGrantClaims = ReturnType<typeof claims>;
export type RelayHubGrant = RelayGrantClaims["grants"][number] & {
  expires_at_ms: number;
};

export const parseRelayGrantClaims = parser((value, path) => {
  const parsed = claims(value, path);
  const { subject } = parsed;
  const hubs = new Set<string>();
  for (const [index, grant] of parsed.grants.entries()) {
    const grantPath = `${path}.grants[${index}]`;
    const key = hubKey(grant);
    if (hubs.has(key)) throw new RelayParseError("invalid_field", grantPath);
    hubs.add(key);
    let allowed: readonly string[] = [];
    if (grant.kind === "session") {
      allowed = subject.kind === "machine" ? [sessionLiveness] : userSignals;
    } else if (subject.kind === "machine" && subject.id === grant.id) {
      allowed = [machineSignal];
    }
    const publish = new Set<string>();
    for (const [index, signal] of grant.publish.entries()) {
      const signalPath = `${grantPath}.publish[${index}]`;
      if (publish.has(signal) || !allowed.includes(signal)) {
        throw new RelayParseError("invalid_field", signalPath);
      }
      publish.add(signal);
    }
  }
  return parsed;
});

function hubKey(hub: { kind: "session" | "machine"; id: string }): string {
  return `${hub.kind}:${hub.id}`;
}

const grantRefusals = ["expired", "subject_mismatch", "hub_limit"] as const;
type GrantRefusal = (typeof grantRefusals)[number];
export const grantRefusal = oneOf(
  ...grantRefusals,
  "invalid_token",
  "unsupported_grant_version",
);

export type RelayGrantUpdate =
  | { status: "applied"; grants: RelayHubGrant[] }
  | { status: "refused"; code: GrantRefusal };

export function applyRelayGrantClaims(
  subject: RelayGrantClaims["subject"],
  current: readonly RelayHubGrant[],
  verifiedClaims: RelayGrantClaims,
  nowMs: number,
): RelayGrantUpdate {
  if (
    verifiedClaims.subject.kind !== subject.kind ||
    verifiedClaims.subject.id !== subject.id
  ) {
    return { status: "refused", code: "subject_mismatch" };
  }
  if (verifiedClaims.expires_at_ms <= nowMs)
    return { status: "refused", code: "expired" };

  const grants = new Map<string, RelayHubGrant>();
  for (const grant of current) {
    if (grant.expires_at_ms > nowMs) grants.set(hubKey(grant), grant);
  }
  for (const grant of verifiedClaims.grants) {
    grants.set(hubKey(grant), {
      ...grant,
      expires_at_ms: verifiedClaims.expires_at_ms,
    });
  }
  if (grants.size > RELAY_MAX_HUBS_PER_CONNECTION)
    return { status: "refused", code: "hub_limit" };
  return { status: "applied", grants: [...grants.values()] };
}
