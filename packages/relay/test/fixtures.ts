import type {
  RelayClientFrame,
  RelayGrantClaims,
  RelayHub,
} from "@codecast/relay-contract";
import {
  parseRelayServerFrame,
  type RelayServerFrame,
} from "@codecast/relay-contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Relay,
  TokenVerifier,
  type RelayOptions,
  type RelaySocket,
} from "../src/index";

export const session = { kind: "session", id: "session-A" } as const;
export const machine = { kind: "machine", id: "machine-A" } as const;

export const userPublish = [
  "presence",
  "draft_cursor",
  "reading_cursor",
  "baton_heartbeat",
] as const;
export const capabilities = [
  ...userPublish,
  "session_liveness",
  "machine_liveness",
];

export function claims(
  overrides: Partial<RelayGrantClaims> = {},
): RelayGrantClaims {
  return {
    v: 1,
    audience: "cell-A",
    subject: { kind: "user", id: "user-A" },
    issued_at_ms: 1,
    grant_seq: 1,
    expires_at_ms: 20_000,
    grants: [{ ...session, publish: [...userPublish] }],
    ...overrides,
  };
}

export function harness<A, E, R>(
  body: Effect.Effect<A, E, R>,
  options: Partial<RelayOptions> = {},
) {
  return body.pipe(
    Effect.provide(
      Relay.layer({
        audience: "cell-A",
        handshakeMs: 500,
        signalTtlMs: 100,
        retryAfterMs: 1234,
        queueCapacity: 8,
        maxConnections: 2048,
        maxHubs: 2048,
        maxSubscribersPerHub: 256,
        ...options,
      }).pipe(
        Layer.provide(
          Layer.effect(
            TokenVerifier,
            Effect.succeed(
              TokenVerifier.of({
                verify: (token) => {
                  if (!token.startsWith("test.")) return null;
                  return Buffer.from(token.slice(5), "base64url").toString(
                    "utf8",
                  );
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

export function token(value: RelayGrantClaims): string {
  return `test.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export class FakeSocket implements RelaySocket {
  readonly events: Array<RelayServerFrame | { type: "closed"; code: number }> =
    [];
  pauseOnNextSend = false;

  send = (text: string) => {
    const parsed = parseRelayServerFrame(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    this.events.push(parsed.value);
    if (this.pauseOnNextSend) {
      this.pauseOnNextSend = false;
      return "paused" as const;
    }
    return "sent" as const;
  };

  close = (code: number) => {
    this.events.push({ type: "closed", code });
  };

  terminate = () => this.close(1006);
}

export const peer = Effect.fn("peer")(function* (
  relay: Relay["Service"],
  value: RelayGrantClaims = claims(),
  offered: string[] = capabilities,
  socket: FakeSocket = new FakeSocket(),
) {
  const connection = yield* relay.open(socket);
  if (!connection) throw new Error("Connection refused");
  const send = (frame: RelayClientFrame) =>
    connection.receive(JSON.stringify(frame));
  yield* send({
    type: "connect",
    versions: [1, 99],
    capabilities: offered,
    token: token(value),
  });
  return {
    connection,
    socket,
    send,
    subscribe: (hub: RelayHub = session) =>
      send({ type: "subscribe", v: 1, hub }),
    refresh: (next: RelayGrantClaims, request_id = "refresh") =>
      send({ type: "grant_update", v: 1, request_id, token: token(next) }),
    release: (hubs: RelayHub[], request_id = "release") =>
      send({ type: "grant_release", v: 1, request_id, hubs }),
    events: socket.events,
  };
});
