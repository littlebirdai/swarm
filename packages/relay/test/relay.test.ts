import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import { RELAY_MAX_FRAME_BYTES } from "@codecast/relay-contract";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { Relay } from "../src/index";
import {
  capabilities,
  claims,
  FakeSocket,
  harness,
  machine,
  peer,
  session,
  userPublish,
} from "./fixtures";

const active = {
  type: "presence",
  v: 1,
  hub: session,
  state: "active",
  in_draft: true,
} as const;
const draft = {
  type: "draft_cursor",
  v: 1,
  hub: session,
  cursor: { revision: 5, anchor: 1, head: 3 },
} as const;
const reading = {
  type: "reading_cursor",
  v: 1,
  hub: session,
  cursor: { message_id: "message-A", offset: 0.42 },
} as const;
const baton = { type: "baton_heartbeat", v: 1, hub: session } as const;
const other = { kind: "session", id: "other" } as const;

it.effect(
  "fans out presence, cursors and baton with stamped sender and ordered clears",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay, claims(), [...capabilities, "unknown"]);
        const b = yield* peer(
          relay,
          claims({ subject: { kind: "user", id: "user-B" } }),
        );
        expect(a.events[0]).toMatchObject({
          type: "hello",
          status: "ok",
          version: 1,
          capabilities,
        });
        yield* a.subscribe();
        yield* b.subscribe();
        yield* a.send(active);
        yield* a.send(draft);
        yield* a.send(reading);
        yield* a.send(baton);
        yield* a.send({ ...draft, cursor: null });
        yield* a.send({ ...active, state: "left", in_draft: false });
        expect(b.events.slice(2)).toEqual([
          expect.objectContaining({
            ...active,
            user_id: "user-A",
            ttl_ms: 100,
          }),
          expect.objectContaining({ ...draft, user_id: "user-A", ttl_ms: 100 }),
          expect.objectContaining({
            ...reading,
            user_id: "user-A",
            ttl_ms: 100,
          }),
          expect.objectContaining({ ...baton, user_id: "user-A", ttl_ms: 100 }),
          expect.objectContaining({ ...draft, cursor: null, ttl_ms: 0 }),
          expect.objectContaining({
            ...active,
            state: "left",
            in_draft: false,
            user_id: "user-A",
            ttl_ms: 0,
          }),
        ]);
        const before = b.events[2];
        const after = b.events.at(-1);
        if (!after || !("seq" in before) || !("seq" in after))
          throw new Error("Signal missing");
        expect(after.connection_id).toBe(before.connection_id);
        expect(after.seq).toBeGreaterThan(before.seq);
        yield* a.connection.disconnected;
        expect(b.events).toHaveLength(8);
      }),
    ),
);

it.effect(
  "checks subscription, grants and both capability sets for machine liveness",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const owner = yield* peer(
          relay,
          claims({
            subject: machine,
            grants: [
              { ...session, publish: ["session_liveness"] },
              { ...machine, publish: ["machine_liveness"] },
            ],
          }),
          capabilities.filter((kind) => kind !== "presence"),
        );
        const watcher = yield* peer(
          relay,
          claims({
            grants: [
              { ...session, publish: [] },
              { ...machine, publish: [] },
            ],
          }),
          ["session_liveness", "machine_liveness", "presence"],
        );
        const run = {
          type: "session_liveness",
          v: 1,
          hub: session,
          run: 4,
        } as const;
        const pulse = { type: "machine_liveness", v: 1, hub: machine } as const;
        yield* watcher.subscribe();
        yield* watcher.subscribe(machine);
        yield* owner.send(run);
        yield* watcher.send(run);
        expect(watcher.events).toHaveLength(3);
        yield* owner.subscribe();
        yield* owner.subscribe(machine);
        yield* owner.send(run);
        yield* owner.send(pulse);
        expect(watcher.events.slice(3)).toEqual([
          expect.objectContaining({ ...run, machine_id: machine.id }),
          expect.objectContaining(pulse),
        ]);
        yield* watcher.refresh(
          claims({
            grant_seq: 2,
            grants: [{ ...session, publish: [...userPublish] }],
          }),
        );
        const ownerCount = owner.events.length;
        yield* watcher.send(active);
        expect(owner.events).toHaveLength(ownerCount);
        const quietUser = yield* peer(relay, claims(), ["draft_cursor"]);
        yield* quietUser.subscribe();
        const watcherCount = watcher.events.length;
        yield* quietUser.send(active);
        expect(watcher.events).toHaveLength(watcherCount);
      }),
    ),
);

it.effect(
  "emits ordered departures on unsubscribe, disconnect and loss of publish permission",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay);
        const b = yield* peer(relay);
        yield* b.subscribe();
        yield* a.subscribe();
        yield* a.send(active);
        yield* a.send({ type: "unsubscribe", v: 1, hub: session });
        yield* a.subscribe();
        yield* a.send(active);
        yield* a.refresh(
          claims({ grant_seq: 2, grants: [{ ...session, publish: [] }] }),
        );
        yield* a.send(active);
        expect(b.events).toHaveLength(6);
        yield* a.refresh(claims({ grant_seq: 3 }));
        yield* a.send(active);
        yield* a.connection.disconnected;
        const events = b.events.slice(2);
        expect(events).toHaveLength(6);
        for (let index = 0; index < events.length; index += 2) {
          const here = events[index];
          const left = events[index + 1];
          expect(left).toMatchObject({
            type: "presence",
            state: "left",
            in_draft: false,
            user_id: "user-A",
            ttl_ms: 0,
          });
          if (!("seq" in here) || !("seq" in left))
            throw new Error("Signal missing");
          expect(left.connection_id).toBe(here.connection_id);
          expect(left.seq).toBeGreaterThan(here.seq);
        }
      }),
    ),
);

it.effect(
  "expires each hub on the clock, sends departure before close and keeps other grants",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const a = yield* peer(relay, claims({ expires_at_ms: 1100 }));
        const b = yield* peer(relay);
        yield* a.refresh(
          claims({
            grant_seq: 2,
            expires_at_ms: 1200,
            grants: [{ ...other, publish: [] }],
          }),
        );
        yield* a.subscribe();
        yield* a.subscribe(other);
        yield* b.subscribe();
        yield* a.send(active);
        yield* TestClock.adjust(99);
        expect(b.events).toHaveLength(3);
        yield* TestClock.adjust(1);
        expect(a.events.at(-1)).toMatchObject({
          type: "subscription",
          hub: session,
          status: "unsubscribed",
          reason: "expired",
        });
        expect(b.events.at(-1)).toMatchObject({
          type: "presence",
          state: "left",
          ttl_ms: 0,
        });
        yield* a.send(active);
        expect(b.events).toHaveLength(4);
        yield* TestClock.adjust(100);
        expect(a.events.slice(-2)).toEqual([
          {
            type: "subscription",
            v: 1,
            hub: other,
            status: "unsubscribed",
            reason: "expired",
          },
          { type: "closed", code: 1008 },
        ]);
      }),
    ),
);

it.effect(
  "applies ordered grant refreshes, releases hubs and refuses stale or foreign updates",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const a = yield* peer(relay, claims({ expires_at_ms: 1100 }));
        const b = yield* peer(relay);
        yield* a.subscribe();
        yield* b.subscribe();
        const newer = claims({
          issued_at_ms: 1001,
          grant_seq: 2,
          expires_at_ms: 1400,
          grants: [
            { ...session, publish: ["presence"] },
            { ...other, publish: [] },
          ],
        });
        yield* a.refresh(newer, "new");
        yield* TestClock.adjust(200);
        yield* a.send(active);
        expect(b.events.at(-1)).toMatchObject({
          type: "presence",
          state: "active",
        });
        yield* a.refresh(claims({ grant_seq: 3 }), "old-issue");
        yield* a.refresh(claims({ issued_at_ms: 1002 }), "old-sequence");
        yield* a.refresh(
          claims({
            ...newer,
            grant_seq: 3,
            subject: { kind: "user", id: "foreign" },
          }),
          "foreign",
        );
        yield* a.refresh(
          claims({ ...newer, grant_seq: 3, audience: "other-cell" }),
          "wrong-audience",
        );
        yield* a.refresh(
          claims({ ...newer, grant_seq: 3, expires_at_ms: 1100 }),
          "expired",
        );
        yield* a.release([session]);
        expect(b.events.at(-1)).toMatchObject({
          type: "presence",
          state: "left",
        });
        yield* a.refresh(newer, "exact");
        yield* a.subscribe(session);
        expect(a.events.at(-1)).toMatchObject({
          type: "subscription",
          status: "denied",
          hub: session,
        });
        yield* a.send(active);
        expect(b.events).toHaveLength(4);
        yield* a.release([other], "release-last");
        expect(
          a.events.filter((event) => event.type === "grant_result"),
        ).toEqual([
          {
            type: "grant_result",
            v: 1,
            status: "applied",
            request_id: "new",
            ttl_ms: 400,
          },
          {
            type: "grant_result",
            v: 1,
            status: "refused",
            request_id: "old-issue",
            code: "stale_token",
          },
          {
            type: "grant_result",
            v: 1,
            status: "refused",
            request_id: "old-sequence",
            code: "stale_token",
          },
          {
            type: "grant_result",
            v: 1,
            status: "refused",
            request_id: "foreign",
            code: "subject_mismatch",
          },
          {
            type: "grant_result",
            v: 1,
            status: "refused",
            request_id: "wrong-audience",
            code: "invalid_token",
          },
          {
            type: "grant_result",
            v: 1,
            status: "refused",
            request_id: "expired",
            code: "expired",
          },
          {
            type: "grant_result",
            v: 1,
            status: "released",
            request_id: "release",
          },
          {
            type: "grant_result",
            v: 1,
            status: "applied",
            request_id: "exact",
            ttl_ms: 200,
          },
          {
            type: "grant_result",
            v: 1,
            status: "released",
            request_id: "release-last",
          },
        ]);
        expect(a.events.at(-1)).toEqual({ type: "closed", code: 1000 });
      }),
    ),
);

it.effect(
  "refuses spoofed sender fields, malformed text, oversized UTF-8 and binary frames",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const watcher = yield* peer(relay);
        yield* watcher.subscribe();
        const cases = [
          {
            input: JSON.stringify({ ...active, user_id: "spoofed" }),
            code: 1002,
          },
          { input: "{", code: 1002 },
          {
            input: JSON.stringify(active) + " ".repeat(RELAY_MAX_FRAME_BYTES),
            code: 1009,
          },
          { input: "é".repeat(RELAY_MAX_FRAME_BYTES / 2 + 1), code: 1009 },
          { input: Buffer.from(JSON.stringify(active)), code: 1003 },
        ];
        for (const { input, code } of cases) {
          const source = yield* peer(relay);
          yield* source.subscribe();
          yield* source.connection.receive(input);
          expect(source.events.at(-1)).toEqual({ type: "closed", code });
        }
        expect(watcher.events).toHaveLength(2);
      }),
    ),
);

it.effect(
  "refuses invalid handshakes, a second connect and an idle handshake",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        for (const [frame, reply, code] of [
          [
            {
              type: "connect",
              versions: [99],
              capabilities,
              token: "test.bad",
            },
            {
              type: "hello",
              status: "incompatible_version",
              supported_versions: [1] as number[],
            },
            1002,
          ],
          [
            { type: "connect", versions: [1], capabilities, token: "test.bad" },
            { type: "hello", status: "unauthorized" },
            1008,
          ],
          [
            {
              type: "connect",
              versions: [1],
              capabilities,
              token: "bad.signature",
            },
            { type: "hello", status: "unauthorized" },
            1008,
          ],
        ] as const) {
          const socket = new FakeSocket();
          const connection = yield* relay.open(socket);
          yield* connection?.receive(JSON.stringify(frame)) ?? Effect.void;
          expect(socket.events).toEqual([reply, { type: "closed", code }]);
        }
        const a = yield* peer(relay);
        yield* a.send({
          type: "connect",
          versions: [1],
          capabilities,
          token: "test.bad",
        });
        expect(a.events.at(-1)).toMatchObject({ type: "closed", code: 1002 });
        const socket = new FakeSocket();
        yield* relay.open(socket);
        yield* TestClock.adjust(500);
        expect(socket.events).toEqual([
          { type: "hello", status: "unauthorized" },
          { type: "closed", code: 1008 },
        ]);
      }),
    ),
);

it.effect(
  "enforces the per-socket grant limit and does not apply a partial update",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const grantChunk = (index: number) =>
          Array.from({ length: 16 }, (_, slot) => ({
            kind: "session" as const,
            id: `hub-${index}-${slot}`,
            publish: [],
          }));
        const a = yield* peer(relay, claims({ grants: grantChunk(0) }));
        for (let index = 1; index < 16; index++) {
          yield* a.refresh(
            claims({ grant_seq: index + 1, grants: grantChunk(index) }),
          );
          expect(a.events.at(-1)).toMatchObject({ status: "applied" });
        }
        const overflowHub = { kind: "session", id: "overflow" } as const;
        const overflow = claims({
          grant_seq: 17,
          grants: [{ ...overflowHub, publish: [] }],
        });
        yield* a.refresh(overflow);
        expect(a.events.at(-1)).toMatchObject({
          status: "refused",
          code: "hub_limit",
        });
        yield* a.subscribe(overflowHub);
        expect(a.events.at(-1)).toMatchObject({ status: "denied" });
        yield* a.release([{ kind: "session", id: "hub-0-0" }]);
        yield* a.refresh(overflow);
        yield* a.subscribe(overflowHub);
        expect(a.events.at(-1)).toMatchObject({ status: "subscribed" });
      }),
    ),
);

it.effect(
  "enforces connection, hub and subscriber bounds and reuses slots",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay);
        const b = yield* peer(
          relay,
          claims({
            grants: [
              { ...session, publish: [] },
              { ...other, publish: [] },
            ],
          }),
        );
        yield* a.subscribe();
        for (const hub of [session, other]) {
          yield* b.subscribe(hub);
          expect(b.events.at(-1)).toMatchObject({ status: "denied", hub });
        }
        const excess = new FakeSocket();
        expect(yield* relay.open(excess)).toBeNull();
        expect(excess.events).toEqual([
          { type: "hello", status: "unavailable", retry_after_ms: 1234 },
          { type: "closed", code: 1013 },
        ]);
        yield* a.connection.disconnected;
        yield* b.subscribe(other);
        expect(b.events.at(-1)).toMatchObject({
          status: "subscribed",
          hub: other,
        });
        const replacement = yield* peer(relay);
        expect(replacement.events[0]).toMatchObject({ status: "ok" });
      }),
      { maxHubs: 1, maxSubscribersPerHub: 1, maxConnections: 2 },
    ),
);

it.effect("coalesces latest signals by ordering key and caps TTL at send", () =>
  harness(
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const relay = yield* Relay;
      const a = yield* peer(relay, claims({ expires_at_ms: 1070 }));
      const b = yield* peer(relay, claims({ expires_at_ms: 1060 }));
      yield* a.subscribe();
      b.socket.pauseOnNextSend = true;
      yield* b.subscribe();
      yield* a.send(active);
      yield* a.send(draft);
      yield* a.send(baton);
      yield* a.send({ ...draft, cursor: { ...draft.cursor, head: 10 } });
      yield* a.send({ ...active, in_draft: false });
      yield* TestClock.adjust(20);
      expect(b.events).toHaveLength(2);
      yield* b.connection.writable;
      expect(b.events.slice(2)).toEqual([
        expect.objectContaining({ type: "baton_heartbeat", ttl_ms: 40 }),
        expect.objectContaining({
          type: "draft_cursor",
          cursor: { ...draft.cursor, head: 10 },
          ttl_ms: 40,
        }),
        expect.objectContaining({
          type: "presence",
          state: "active",
          in_draft: false,
          ttl_ms: 40,
        }),
      ]);
    }),
    { queueCapacity: 3 },
  ),
);

it.effect(
  "drops expired queued signals, never replays to a new subscription and preserves clears",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay);
        const b = yield* peer(relay);
        yield* a.subscribe();
        b.socket.pauseOnNextSend = true;
        yield* b.subscribe();
        yield* a.send(active);
        yield* a.send(draft);
        yield* a.send(reading);
        yield* a.send({ ...draft, cursor: null });
        yield* TestClock.adjust(100);
        yield* b.connection.writable;
        expect(b.events.slice(2)).toEqual([
          expect.objectContaining({
            type: "draft_cursor",
            cursor: null,
            ttl_ms: 0,
          }),
        ]);
        b.socket.pauseOnNextSend = true;
        yield* b.subscribe();
        yield* a.send(baton);
        yield* b.send({ type: "unsubscribe", v: 1, hub: session });
        yield* b.subscribe();
        yield* b.connection.writable;
        expect(b.events.slice(-2)).toEqual([
          expect.objectContaining({
            type: "subscription",
            reason: "requested",
          }),
          expect.objectContaining({
            type: "subscription",
            status: "subscribed",
          }),
        ]);
        expect(
          b.events.filter((event) => event.type === "baton_heartbeat"),
        ).toHaveLength(0);
      }),
    ),
);

it.effect(
  "caps queued TTL at the source deadline and drops traffic when a right is lost",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const a = yield* peer(relay, claims({ expires_at_ms: 1050 }));
        const b = yield* peer(relay);
        yield* a.subscribe();
        b.socket.pauseOnNextSend = true;
        yield* b.subscribe();
        yield* a.send(baton);
        yield* a.send(draft);
        yield* a.refresh(
          claims({
            grant_seq: 2,
            grants: [{ ...session, publish: ["baton_heartbeat"] }],
          }),
        );
        yield* a.refresh(claims({ grant_seq: 3 }));
        yield* TestClock.adjust(20);
        yield* b.connection.writable;
        expect(b.events.slice(2)).toEqual([
          expect.objectContaining({ type: "baton_heartbeat", ttl_ms: 30 }),
        ]);
      }),
    ),
);

it.effect("evicts timed signals before disconnecting on control overflow", () =>
  harness(
    Effect.gen(function* () {
      const relay = yield* Relay;
      const a = yield* peer(relay);
      const b = yield* peer(relay);
      yield* a.subscribe();
      b.socket.pauseOnNextSend = true;
      yield* b.subscribe();
      yield* a.send(active);
      yield* a.send(draft);
      yield* a.send(baton);
      yield* b.subscribe();
      yield* b.connection.writable;
      expect(b.events.slice(2)).toEqual([
        expect.objectContaining({ type: "baton_heartbeat" }),
        expect.objectContaining({ type: "subscription", status: "subscribed" }),
      ]);
      b.socket.pauseOnNextSend = true;
      yield* b.subscribe();
      yield* b.subscribe();
      yield* b.subscribe();
      yield* b.subscribe();
      expect(b.events.at(-1)).toEqual({ type: "closed", code: 1013 });
    }),
    { queueCapacity: 2 },
  ),
);

it.effect(
  "drains established and new connections with a retry delay and bounds stalled closes",
  () =>
    harness(
      Effect.gen(function* () {
        const relay = yield* Relay;
        const a = yield* peer(relay);
        const b = yield* peer(relay);
        b.socket.pauseOnNextSend = true;
        yield* b.subscribe();
        yield* relay.drain;
        expect(yield* relay.isDraining).toBe(true);
        expect(a.events.slice(1)).toEqual([
          { type: "hello", status: "unavailable", retry_after_ms: 1234 },
          { type: "closed", code: 1012 },
        ]);
        const newcomer = new FakeSocket();
        expect(yield* relay.open(newcomer)).toBeNull();
        expect(newcomer.events[0]).toEqual({
          type: "hello",
          status: "unavailable",
          retry_after_ms: 1234,
        });
        yield* TestClock.adjust(500);
        expect(b.events.at(-1)).toEqual({ type: "closed", code: 1006 });
      }),
    ),
);
