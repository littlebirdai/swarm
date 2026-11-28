import { expect } from "bun:test";
import { RELAY_SESSION_LIVENESS_CAPABILITY } from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import {
  parseRelayClientFrame,
  type RelayClientFrame,
} from "@codecast/relay-contract";
import * as Effect from "effect/Effect";
import { Random } from "effect/Random";
import { adjust } from "effect/testing/TestClock";
import helloFixture from "../../edge-contract/test/fixtures/hello.json";
import { makeRelayLiveness } from "../src/relay-liveness-layer";
import { reply, scriptedTransport, type Step } from "./scripted-transport";

const acceptHello = reply({
  ...helloFixture.response,
  policy: {
    ...helloFixture.response.policy,
    capabilities: [RELAY_SESSION_LIVENESS_CAPABILITY],
  },
});
const grant = (ttl_ms = 30_000) =>
  reply({
    v: 1,
    status: "ok",
    url: "wss://relay.test/relay",
    token: String(ttl_ms),
    ttl_ms,
  });

type SocketEvents = {
  open: Event;
  message: MessageEvent;
  close: CloseEvent;
};

function fixture(...responses: Step[]) {
  const { calls, transport } = scriptedTransport(...responses);
  const sockets: Array<{ closed: boolean }> = [];
  const frames: RelayClientFrame[] = [];
  const start = performance.now();
  const lease = (duration: number) => ({
    session: "session",
    run: 2,
    fencing_token: "fence",
    deadline: start + duration,
  });
  const relay = makeRelayLiveness(
    {
      hello: helloFixture.request,
      transport,
      WebSocket: class {
        closed = false;
        private readonly events = new EventTarget();
        constructor() {
          sockets.push(this);
          queueMicrotask(() => this.events.dispatchEvent(new Event("open")));
        }
        addEventListener<K extends keyof SocketEvents>(
          type: K,
          listener: (event: SocketEvents[K]) => void,
        ) {
          this.events.addEventListener(type, (event) =>
            listener(event as SocketEvents[K]),
          );
        }
        close() {
          this.closed = true;
        }
        send(wire: string) {
          const parsed = parseRelayClientFrame(wire);
          if (!parsed.ok) throw new Error("Invalid relay frame");
          const frame = parsed.value;
          frames.push(frame);
          if (frame.type === "connect") {
            this.reply({
              type: "hello",
              status: "ok",
              version: 1,
              capabilities: ["session_liveness"],
              connection_id: "machine-connection",
              ttl_ms: Number(frame.token),
            });
          }
          if (frame.type === "subscribe") {
            this.reply({
              v: 1,
              type: "subscription",
              status: "subscribed",
              hub: frame.hub,
            });
          }
          if (frame.type === "grant_update") {
            this.reply({
              v: 1,
              type: "grant_result",
              request_id: frame.request_id,
              status: "applied",
              ttl_ms: Number(frame.token),
            });
          }
        }
        private reply(frame: object) {
          queueMicrotask(() =>
            this.events.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(frame) }),
            ),
          );
        }
      },
    },
    [lease(6_000)],
  );

  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(relay.layer),
      Effect.provideService(Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => 0,
      }),
    );
  return {
    calls,
    sockets,
    relay,
    lease,
    run,
    publishes: () => frames.filter(({ type }) => type === "session_liveness"),
    operations: () => calls.map(({ operation }) => operation),
  };
}

it.effect(
  "hello without relay liveness negotiates once and stops without minting or dialing",
  () => {
    const unsupported = reply(helloFixture.response);
    const f = fixture(unsupported, unsupported);
    return f.run(
      Effect.gen(function* () {
        yield* adjust(249);
        expect(f.operations()).toEqual(["hello"]);
        yield* adjust(10_000);
        expect(f.operations()).toEqual(["hello"]);
        expect(f.sockets).toHaveLength(0);
      }),
    );
  },
);

for (const status of ["stale", "unavailable", "rate_limited"] as const) {
  it.effect(
    `relay-grant ${status} backs off and retries without dialing early`,
    () => {
      const rejected = reply({ v: 1, status });
      const f = fixture(acceptHello, rejected, rejected, grant());
      return f.run(
        Effect.gen(function* () {
          yield* adjust(249);
          expect(f.operations()).toEqual(["hello", "relay-grant"]);
          expect(f.sockets).toHaveLength(0);
          yield* adjust(1);
          expect(f.operations()).toEqual([
            "hello",
            "relay-grant",
            "relay-grant",
          ]);
          yield* adjust(499);
          expect(f.calls).toHaveLength(3);
          expect(f.sockets).toHaveLength(0);
          yield* adjust(1);
          expect(f.calls).toHaveLength(4);
          expect(f.sockets).toHaveLength(1);
          expect(f.publishes()).toHaveLength(1);
        }),
      );
    },
  );
}

it.effect("relay-grant HTTP 5xx retries on the publisher clock", () => {
  const f = fixture(acceptHello, reply({}, 503), reply({}, 502), grant());
  return f.run(
    Effect.gen(function* () {
      yield* adjust(99);
      expect(f.operations()).toEqual(["hello", "relay-grant"]);
      expect(f.sockets).toHaveLength(0);
      yield* adjust(1);
      expect(f.calls).toHaveLength(3);
      yield* adjust(199);
      expect(f.calls).toHaveLength(3);
      yield* adjust(1);
      expect(f.calls).toHaveLength(4);
      expect(f.publishes()).toHaveLength(1);
    }),
  );
});

it.effect(
  "a lease update keeps publishing through the original expiry on the same connection",
  () => {
    const f = fixture(acceptHello, grant(6_000), grant(13_000));
    return f.run(
      Effect.gen(function* () {
        yield* adjust(2_000);
        expect(f.publishes()).toHaveLength(1);
        f.relay.update([f.lease(16_000)]);
        yield* adjust(8_000);
        expect(f.operations()).toEqual(["hello", "relay-grant", "relay-grant"]);
        expect(f.sockets).toHaveLength(1);
        expect(f.sockets[0].closed).toBe(false);
        expect(f.publishes()).toEqual(
          Array.from({ length: 3 }, () => ({
            v: 1,
            type: "session_liveness",
            hub: { kind: "session", id: "session" },
            run: 2,
          })),
        );
      }),
    );
  },
);
