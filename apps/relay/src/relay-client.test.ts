import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import {
  parseRelayServerFrame,
  type RelayGrantClaims,
  type RelayServerFrame,
} from "@codecast/relay-contract";
import { readConfig } from "./config";
import { startRelayServer } from "./server";
import { mintTestToken } from "../test/mint-token";
import { createRelayClient, type RelayEvent } from "@codecast/relay-client";
import {
  fakeClock,
  presence,
  second,
  session,
} from "../../../packages/relay-client/test/fixtures";

function inbox<T>() {
  const values: T[] = [];
  let changed = Promise.withResolvers<void>();
  return {
    add(value: T) {
      values.push(value);
      changed.resolve();
      changed = Promise.withResolvers<void>();
    },
    async take(predicate: (value: T) => boolean) {
      while (true) {
        const index = values.findIndex(predicate);
        if (index >= 0) return values.splice(index, 1)[0];
        await changed.promise;
      }
    },
  };
}

type FrameInbox = ReturnType<typeof inbox<RelayServerFrame>>;

const key = Buffer.alloc(32, 71);
const config = readConfig({
  RELAY_AUDIENCE: "cell",
  RELAY_HMAC_KEY: key.toString("base64url"),
  RELAY_PORT: "0",
  RELAY_RETRY_AFTER_MS: "2000",
});

function clientFor(id: string, serverUrl: () => URL) {
  const clock = fakeClock();
  const events = inbox<RelayEvent>();
  const sockets = inbox<FrameInbox>();
  let seq = 0;
  let allowed = [session.id as string, second.id as string];
  const client = createRelayClient({
    ...clock,
    random: () => 0,
    WebSocket: class extends WebSocket {
      constructor(url: string) {
        super(url);
        const frames = inbox<RelayServerFrame>();
        this.addEventListener("message", ({ data }) => {
          const parsed = parseRelayServerFrame(data);
          if (parsed.ok) frames.add(parsed.value);
        });
        sockets.add(frames);
      }
    },
    async getToken(hubs) {
      const at = Date.now();
      const claims: RelayGrantClaims = {
        v: 1,
        audience: "cell",
        subject: { kind: "user", id },
        issued_at_ms: at,
        expires_at_ms: at + 60_000,
        grant_seq: ++seq,
        grants: hubs.flatMap((hub) =>
          hub.kind === "session" && allowed.includes(hub.id)
            ? [{ ...hub, publish: ["presence"] }]
            : [],
        ),
      };
      const omitted = hubs
        .filter(({ id }) => !allowed.includes(id))
        .map(({ id }) => ({ id, reason: "inaccessible" as const }));
      if (!claims.grants.length) return { status: "denied", omitted };
      const url = new URL("/relay", serverUrl());
      url.protocol = "ws:";
      return {
        status: "ok",
        url: url.href,
        token: mintTestToken(key, claims),
        omitted,
      };
    },
  });

  return {
    client,
    clock,
    events,
    sockets,
    revoke(hub: typeof session | typeof second) {
      allowed = allowed.filter((id) => id !== hub.id);
    },
    subscribe(hub: typeof session | typeof second) {
      return client.subscribe(hub, events.add);
    },
  };
}

const ready =
  (hub: typeof session | typeof second) => (frame: RelayServerFrame) =>
    frame.type === "subscription" &&
    frame.status === "subscribed" &&
    frame.hub.id === hub.id;

it.effect(
  "real relay delivers presence and departures and releases grants omitted by a renewal",
  () =>
    Effect.promise(async () => {
      const server = startRelayServer(config);
      const alice = clientFor("alice", () => server.url);
      const bob = clientFor("bob", () => server.url);
      try {
        alice.subscribe(session);
        alice.subscribe(second);
        const leave = bob.subscribe(session);
        const receiver = await alice.sockets.take(() => true);
        let sender = await bob.sockets.take(() => true);
        await receiver.take(ready(session));
        await receiver.take(ready(second));
        await sender.take(ready(session));
        bob.client.publish(presence);
        const active = await alice.events.take(() => true);
        expect(active).toMatchObject({
          type: "signal",
          signal: { type: "presence", state: "active", user_id: "bob" },
        });
        leave();
        expect(await alice.events.take(() => true)).toMatchObject({
          type: "signal",
          signal: { type: "presence", state: "left", ttl_ms: 0 },
        });
        bob.subscribe(session);
        sender = await bob.sockets.take(() => true);
        await sender.take(ready(session));
        await alice.clock.advance(54_000);
        bob.client.publish(presence);
        await alice.events.take(() => true);

        alice.revoke(session);
        await alice.clock.advance(1001);
        expect(await alice.events.take(() => true)).toMatchObject({
          type: "removed",
          signal: { hub: session },
        });
        expect(
          await receiver.take(
            (frame) =>
              frame.type === "subscription" && frame.status === "unsubscribed",
          ),
        ).toMatchObject({
          hub: session,
          reason: "released",
        });
        expect(
          await receiver.take(
            (frame) =>
              frame.type === "grant_result" && frame.status === "applied",
          ),
        ).toMatchObject({ ttl_ms: expect.any(Number) });

        const leaveSecond = bob.subscribe(second);
        await sender.take(ready(second));
        bob.client.publish({ ...presence, hub: second });
        expect(await alice.events.take(() => true)).toMatchObject({
          type: "signal",
          signal: { hub: second, state: "active" },
        });
        leaveSecond();
      } finally {
        alice.client.close();
        bob.client.close();
        await server.stop();
      }
    }),
);

it.effect(
  "real relay drain clears display observations and restart restores subscriptions",
  () =>
    Effect.promise(async () => {
      const server = startRelayServer(config);
      let current = server;
      const alice = clientFor("alice", () => current.url);
      const bob = clientFor("bob", () => current.url);
      try {
        alice.subscribe(session);
        bob.subscribe(session);
        const receiver = await alice.sockets.take(() => true);
        const sender = await bob.sockets.take(() => true);
        await receiver.take(ready(session));
        await sender.take(ready(session));
        bob.client.publish(presence);
        const active = await alice.events.take(() => true);
        server.drain();
        const unavailable = (frame: RelayServerFrame) =>
          frame.type === "hello" && frame.status === "unavailable";
        expect(await receiver.take(unavailable)).toMatchObject({
          retry_after_ms: 2000,
        });
        await sender.take(unavailable);
        expect(await alice.events.take(() => true)).toEqual({
          ...active,
          type: "removed",
        });
        await server.stop();
        current = startRelayServer(config);
        await alice.clock.advance(1999);
        expect(alice.clock.deadline).toBe(alice.clock.now() + 1);
        await alice.clock.advance(1);
        await bob.clock.advance(2000);
        const newReceiver = await alice.sockets.take(() => true);
        const newSender = await bob.sockets.take(() => true);
        await newReceiver.take(ready(session));
        await newSender.take(ready(session));
        bob.client.publish({ ...presence, in_draft: true });
        expect(await alice.events.take(() => true)).toMatchObject({
          type: "signal",
          signal: { hub: session, state: "active", in_draft: true },
        });
      } finally {
        alice.client.close();
        bob.client.close();
        await current.stop();
      }
    }),
);
