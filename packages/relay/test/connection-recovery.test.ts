import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { Relay } from "../src/index";
import {
  capabilities,
  claims,
  FakeSocket,
  harness,
  peer,
  session,
} from "./fixtures";

const other = { kind: "session", id: "other" } as const;
const active = {
  type: "presence",
  v: 1,
  hub: session,
  state: "active",
  in_draft: true,
} as const;

for (const secondHub of [false, true]) {
  it.effect(
    `keeps a paused renewal past the old deadline with ${secondHub ? "two hubs" : "one hub"}`,
    () =>
      harness(
        Effect.gen(function* () {
          yield* TestClock.setTime(1000);
          const relay = yield* Relay;
          const a = yield* peer(relay, claims({ expires_at_ms: 1010 }));
          if (secondHub)
            yield* a.refresh(
              claims({
                grant_seq: 2,
                grants: [{ ...other, publish: ["presence"] }],
              }),
            );
          a.socket.pauseOnNextSend = true;
          yield* a.subscribe();
          const before = a.events.length;
          yield* a.refresh(
            claims({
              issued_at_ms: 1000,
              grant_seq: 3,
              expires_at_ms: 1100,
              grants: [...claims().grants, { ...other, publish: ["presence"] }],
            }),
            "renew",
          );
          yield* TestClock.adjust(11);
          yield* a.subscribe(other);
          yield* a.send({ ...active, hub: other });
          yield* a.send(active);
          yield* a.connection.writable;
          expect(a.events.slice(before)).toEqual([
            {
              type: "grant_result",
              v: 1,
              request_id: "renew",
              status: "applied",
              ttl_ms: 89,
            },
            { type: "subscription", v: 1, hub: other, status: "subscribed" },
            expect.objectContaining({ type: "presence", hub: other }),
            expect.objectContaining(active),
          ]);
        }),
      ),
  );
}

it.effect(
  "a departure send defect closes only its recipient and frees the subject slot",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const source = yield* peer(relay);
        const recipientClaims = claims({
          subject: { kind: "user", id: "recipient" },
        });
        const recipient = yield* peer(relay, recipientClaims);
        const observer = yield* peer(
          relay,
          claims({ subject: { kind: "user", id: "observer" } }),
        );
        yield* source.subscribe();
        yield* recipient.subscribe();
        yield* observer.subscribe();
        yield* source.send(active);
        recipient.socket.send = () => {
          throw new Error("send defect");
        };
        yield* source.send({ type: "unsubscribe", v: 1, hub: session });
        expect(source.events.at(-1)).toMatchObject({ reason: "requested" });
        expect(observer.events.at(-1)).toMatchObject({
          type: "presence",
          state: "left",
        });
        expect(recipient.events.at(-1)).toEqual({ type: "closed", code: 1006 });
        const replacement = yield* peer(relay, recipientClaims);
        expect(replacement.events[0]).toMatchObject({ status: "ok" });
        const idle = new FakeSocket();
        yield* relay.open(idle);
        yield* TestClock.adjust(500);
        expect(idle.events.at(-1)).toEqual({ type: "closed", code: 1008 });
      }),
      { maxConnectionsPerSubject: 1 },
    ),
);

it.effect(
  "timeout continues after a close defect and reclaims the unauthenticated slot",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const faulty = new FakeSocket();
        faulty.close = () => {
          throw new Error("close defect");
        };
        const idle = new FakeSocket();
        yield* relay.open(faulty);
        yield* relay.open(idle);
        yield* TestClock.adjust(500);
        expect(idle.events.at(-1)).toEqual({ type: "closed", code: 1008 });
        expect(yield* relay.open(new FakeSocket())).not.toBeNull();
        expect(yield* relay.open(new FakeSocket())).not.toBeNull();
      }),
      { maxPreAuthConnections: 2 },
    ),
);

it.effect(
  "drain continues after a send defect and expires a later stalled socket",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const faulty = yield* peer(relay);
        faulty.socket.send = () => {
          throw new Error("drain send defect");
        };
        const stalled = new FakeSocket();
        stalled.pauseOnNextSend = true;
        yield* relay.open(stalled);
        const idle = new FakeSocket();
        yield* relay.open(idle);
        yield* relay.drain;
        expect(faulty.events.at(-1)).toEqual({ type: "closed", code: 1006 });
        expect(idle.events.at(-1)).toEqual({ type: "closed", code: 1012 });
        yield* TestClock.adjust(500);
        expect(stalled.events.at(-1)).toEqual({ type: "closed", code: 1006 });
      }),
    ),
);

it.effect(
  "a verifier defect releases the pre-auth slot and later sockets still time out",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const faulty = new FakeSocket();
        const pending = yield* relay.open(faulty);
        if (!pending) throw new Error("Socket refused");
        yield* pending.receive(
          JSON.stringify({
            type: "connect",
            versions: [1],
            capabilities,
            token: "test.defect",
          }),
        );
        expect(faulty.events).toEqual([{ type: "closed", code: 1006 }]);
        const retry = yield* peer(relay);
        expect(retry.events[0]).toMatchObject({ status: "ok" });
        const idle = new FakeSocket();
        expect(yield* relay.open(idle)).not.toBeNull();
        yield* TestClock.adjust(500);
        expect(idle.events.at(-1)).toEqual({ type: "closed", code: 1008 });
      }),
      { maxPreAuthConnections: 1 },
    ),
);

it.effect(
  "a shorter refresh expires on the new deadline without another message",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const a = yield* peer(yield* Relay, claims({ expires_at_ms: 1100 }));
        yield* a.subscribe();
        yield* TestClock.adjust(1);
        yield* a.refresh(
          claims({ issued_at_ms: 1001, grant_seq: 2, expires_at_ms: 1010 }),
          "shorter",
        );
        const renewed = {
          type: "grant_result",
          v: 1,
          request_id: "shorter",
          status: "applied",
          ttl_ms: 9,
        } as const;
        yield* TestClock.adjust(8);
        expect(a.events.at(-1)).toEqual(renewed);
        yield* TestClock.adjust(1);
        expect(a.events.slice(2)).toEqual([
          renewed,
          {
            type: "subscription",
            v: 1,
            hub: session,
            status: "unsubscribed",
            reason: "expired",
          },
          { type: "closed", code: 1008 },
        ]);
      }),
    ),
);

it.effect(
  "a refusal that throws during open leaves other connections and the next open usable",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const existing = yield* peer(relay);
        yield* existing.subscribe();
        const pending = new FakeSocket();
        const connection = yield* relay.open(pending);
        if (!connection) throw new Error("Expected the pre-auth slot");
        const refused = new FakeSocket();
        refused.send = () => {
          throw new Error("refusal send defect");
        };
        expect(yield* relay.open(refused)).toBeNull();
        expect(refused.events).toEqual([{ type: "closed", code: 1006 }]);
        expect(pending.events).toEqual([]);
        yield* connection.disconnected;
        const next = yield* peer(relay);
        yield* next.subscribe();
        expect(next.events[0]).toMatchObject({ type: "hello", status: "ok" });
        yield* existing.send(active);
        expect(next.events.at(-1)).toMatchObject(active);
      }),
      { maxPreAuthConnections: 1 },
    ),
);

it.effect(
  "closes when an accepted renewal outlives its queued success reply",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const a = yield* peer(relay);
        a.socket.pauseOnNextSend = true;
        yield* a.subscribe();
        yield* a.refresh(
          claims({ issued_at_ms: 1000, grant_seq: 2, expires_at_ms: 1010 }),
        );
        yield* TestClock.adjust(10);
        yield* a.connection.writable;
        expect(a.events.slice(2)).toEqual([{ type: "closed", code: 1008 }]);
      }),
    ),
);
