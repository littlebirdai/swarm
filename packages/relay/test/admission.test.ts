import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import { Clock } from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import { openConnection } from "../src/connection";
import { HubRegistry, Relay } from "../src/index";
import {
  capabilities,
  claims,
  FakeSocket,
  harness,
  peer,
  session,
  token,
} from "./fixtures";

const active = {
  type: "presence",
  v: 1,
  hub: session,
  state: "active",
  in_draft: true,
} as const;
const unavailable = {
  type: "hello",
  status: "unavailable",
  retry_after_ms: 1234,
} as const;

it.effect(
  "bounds unauthenticated sockets separately and reclaims capacity on every handshake end",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay);
        yield* a.subscribe();
        const unverified = new FakeSocket();
        const pending = yield* relay.open(unverified);
        if (!pending) throw new Error("Pre-auth socket denied");
        const excess = new FakeSocket();
        expect(yield* relay.open(excess)).toBeNull();
        expect(excess.events).toEqual([
          unavailable,
          { type: "closed", code: 1013 },
        ]);
        yield* a.send(active);
        expect(a.events.at(-1)).toMatchObject(active);
        yield* TestClock.adjust(500);
        expect(unverified.events.at(-1)).toEqual({
          type: "closed",
          code: 1008,
        });

        for (const end of ["invalid", "disconnect", "valid"] as const) {
          const socket = new FakeSocket();
          const connection = yield* relay.open(socket);
          if (!connection) throw new Error("Pre-auth slot leaked");
          if (end === "invalid") yield* connection.receive("{");
          if (end === "disconnect") yield* connection.disconnected;
          if (end === "valid")
            yield* connection.receive(
              JSON.stringify({
                type: "connect",
                versions: [1],
                capabilities,
                token: token(claims()),
              }),
            );
        }
        expect(yield* relay.open(new FakeSocket())).not.toBeNull();
      }),
      { maxPreAuthConnections: 1 },
    ),
);

it.effect(
  "bounds connections and hub slots by subject and reclaims both after close",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay);
        const same = yield* peer(relay);
        yield* a.subscribe();
        yield* same.subscribe();
        expect(same.events.at(-1)).toMatchObject({
          type: "subscription",
          status: "denied",
        });
        const excess = yield* peer(relay);
        expect(excess.events).toEqual([
          unavailable,
          { type: "closed", code: 1013 },
        ]);
        const machine = yield* peer(
          relay,
          claims({
            subject: { kind: "machine", id: "user-A" },
            grants: [{ ...session, publish: [] }],
          }),
        );
        yield* machine.subscribe();
        expect(machine.events.at(-1)).toMatchObject({ status: "subscribed" });

        yield* a.connection.disconnected;
        yield* same.subscribe();
        expect(same.events.at(-1)).toMatchObject({ status: "subscribed" });
        const replacement = yield* peer(relay);
        expect(replacement.events[0]).toMatchObject({ status: "ok" });
      }),
      { maxConnectionsPerSubject: 2, maxSubscribersPerHub: 2 },
    ),
);

it.effect("closes a failed transport and reclaims its authenticated slot", () =>
  harness(
    Effect.gen(function* () {
      const relay = yield* Relay;
      const a = yield* peer(relay);
      a.socket.failOnNextSend = true;
      yield* a.subscribe();
      yield* TestClock.adjust(0);
      expect(a.events.at(-1)).toEqual({ type: "closed", code: 1006 });
      const replacement = yield* peer(relay);
      expect(replacement.events[0]).toMatchObject({ status: "ok" });
    }),
    { maxConnectionsPerSubject: 1 },
  ),
);

it.effect(
  "refuses wrong-audience tokens, unsupported grants and a non-connect first frame",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const wrongAudience = yield* peer(
          relay,
          claims({ audience: "cell-B" }),
        );
        expect(wrongAudience.events).toEqual([
          { type: "hello", status: "unauthorized" },
          { type: "closed", code: 1008 },
        ]);
        const watcher = yield* peer(relay);
        yield* watcher.send({
          type: "grant_update",
          v: 1,
          request_id: "version",
          token: token({ ...claims(), v: 2 }),
        });
        expect(watcher.events.at(-1)).toMatchObject({
          type: "grant_result",
          status: "refused",
          code: "unsupported_grant_version",
        });

        const socket = new FakeSocket();
        const connection = yield* relay.open(socket);
        if (!connection) throw new Error("Pre-auth socket denied");
        yield* connection.receive(
          JSON.stringify({ type: "subscribe", v: 1, hub: session }),
        );
        expect(socket.events).toEqual([{ type: "closed", code: 1002 }]);
      }),
    ),
);

it.effect(
  "refuses a refresh expired at receipt without advancing the high-water mark",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const a = yield* peer(relay);
        const b = yield* peer(relay);
        yield* b.subscribe();
        a.socket.pauseOnNextSend = true;
        yield* a.subscribe();
        const other = { kind: "session", id: "other" } as const;
        yield* a.refresh(
          claims({
            issued_at_ms: 990,
            grant_seq: 3,
            expires_at_ms: 1000,
            grants: [
              { ...session, publish: [] },
              { ...other, publish: [] },
            ],
          }),
          "expired-at-receipt",
        );
        yield* a.send(active);
        yield* a.subscribe(other);
        yield* a.refresh(
          claims({ issued_at_ms: 1000, grant_seq: 2 }),
          "still-new",
        );
        expect(b.events.at(-1)).toMatchObject(active);
        yield* TestClock.adjust(10);
        yield* a.connection.writable;
        expect(
          a.events.filter((event) => event.type === "grant_result"),
        ).toEqual([
          {
            type: "grant_result",
            v: 1,
            request_id: "expired-at-receipt",
            status: "refused",
            code: "expired",
          },
          {
            type: "grant_result",
            v: 1,
            request_id: "still-new",
            status: "applied",
            ttl_ms: 18990,
          },
        ]);
        expect(a.events).toContainEqual({
          type: "subscription",
          v: 1,
          hub: other,
          status: "denied",
        });
        expect(b.events.at(-1)).toMatchObject(active);
      }),
    ),
);

it.effect("does not emit departure to peers while draining", () =>
  harness(
    Effect.gen(function* () {
      const relay = yield* Relay;
      const a = yield* peer(relay);
      const b = yield* peer(relay);
      yield* a.subscribe();
      yield* b.subscribe();
      yield* a.send(active);
      yield* relay.drain;
      expect(b.events.slice(3)).toEqual([
        unavailable,
        { type: "closed", code: 1012 },
      ]);
    }),
  ),
);

it.effect("retires the deadline as soon as a connection closes", () =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    const registry = yield* HubRegistry;
    const scope = yield* Scope.fork(yield* Effect.scope);
    const unavailable = {
      type: "hello",
      status: "unavailable",
      retry_after_ms: 1234,
    } as const;
    const entry = openConnection(
      new FakeSocket(),
      scope,
      clock,
      registry,
      {
        audience: "cell-A",
        handshakeMs: 500,
        signalTtlMs: 100,
        retryAfterMs: 1234,
        queueCapacity: 8,
        maxConnections: 2,
        maxPreAuthConnections: 2,
        maxConnectionsPerSubject: 2,
        maxHubs: 2,
        maxSubscribersPerHub: 2,
      },
      () => "invalid_token",
      {
        admit: () => true,
        isDraining: () => false,
        deadlineChanged: () => undefined,
      },
      unavailable,
    );
    expect(entry.deadline()).toBe(500);
    yield* entry.connection.disconnected;
    expect(entry.deadline()).toBe(Infinity);
  }).pipe(Effect.provide(HubRegistry.layer(2, 2))),
);

it.effect("drops queued departures when drain begins", () =>
  harness(
    Effect.gen(function* () {
      const relay = yield* Relay;
      const a = yield* peer(relay);
      const b = yield* peer(relay);
      yield* a.subscribe();
      b.socket.pauseOnNextSend = true;
      yield* b.subscribe();
      yield* a.send(active);
      yield* a.send({ type: "unsubscribe", v: 1, hub: session });
      yield* relay.drain;
      yield* b.connection.writable;
      expect(b.events.slice(2)).toEqual([
        unavailable,
        { type: "closed", code: 1012 },
      ]);
    }),
  ),
);
