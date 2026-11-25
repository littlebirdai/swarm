import {
  array,
  id,
  object,
  oneOf,
  parser,
  positive,
  responseObject,
  tagged,
} from "./read";

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

const sessionSignals = [
  "presence",
  "cursor",
  "baton_heartbeat",
  "session_liveness",
] as const;
export const machineSignal = "machine_liveness";

const claims = object({
  audience: id,
  subject: tagged("kind", { user: object(user), machine: machineHub }),
  expires_at_ms: positive,
  grants: array(
    tagged("kind", {
      session: object({
        ...session,
        publish: array(oneOf(...sessionSignals), 0, 4),
      }),
      machine: object({
        ...machine,
        publish: array(oneOf(machineSignal), 0, 1),
      }),
    }),
    1,
    32,
  ),
});

export type RelayGrantClaims = ReturnType<typeof claims>;
export const parseRelayGrantClaims = parser(claims);
