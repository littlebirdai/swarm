import { expect } from "bun:test";
import { on, once } from "node:events";
import { it } from "@codecast/effect-kit/effect/testing";
import {
  parseRelayServerFrame,
  RELAY_MAX_FRAME_BYTES,
  type RelayHubGrant,
  type RelayServerFrame,
} from "@codecast/relay-contract";
import * as Effect from "effect/Effect";
import WebSocket from "ws";
import { mintTestToken } from "../test/mint-token";
import { BunRelaySocket } from "./bun-relay-socket";
import { readConfig } from "./config";
import { startRelayServer } from "./server";

const key = Buffer.alloc(32, 57);
const config = readConfig({
  RELAY_PORT: "0",
  RELAY_AUDIENCE: "cell-A",
  RELAY_HMAC_KEY: key.toString("base64url"),
  RELAY_QUEUE_CAPACITY: "8",
  RELAY_SIGNAL_TTL_MS: "30000",
});
const hub = { kind: "session", id: "s".repeat(128) } as const;
const subscribe = JSON.stringify({ type: "subscribe", v: 1, hub });
type SessionPublish = Extract<RelayHubGrant, { kind: "session" }>["publish"];

function open(url: URL) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const endpoint = new URL("/relay", url);
      endpoint.protocol = "ws:";
      return new WebSocket(endpoint);
    }),
    (ws) => Effect.sync(() => ws.terminate()),
  ).pipe(Effect.tap((ws) => Effect.promise(() => once(ws, "open"))));
}

function decode(data: unknown) {
  const parsed = parseRelayServerFrame(String(data));
  if (!parsed.ok) throw new Error("Invalid relay frame");
  return parsed.value;
}

function receive(ws: WebSocket) {
  return Effect.promise(async () => decode((await once(ws, "message"))[0]));
}

function grant(id: string, grantSeq: number, publish: SessionPublish) {
  const now = Date.now();
  return mintTestToken(key, {
    v: 1,
    audience: config.audience,
    subject: { kind: "user", id },
    issued_at_ms: now,
    grant_seq: grantSeq,
    expires_at_ms: now + 30_000,
    grants: [{ ...hub, publish }],
  });
}

const authenticate = Effect.fn("authenticate")(function* (
  ws: WebSocket,
  id: string,
  publish: SessionPublish = ["reading_cursor"],
) {
  ws.send(
    JSON.stringify({
      type: "connect",
      versions: [1],
      capabilities: publish,
      token: grant(id, 1, publish),
    }),
  );
  expect(yield* receive(ws)).toMatchObject({ type: "hello", status: "ok" });
  ws.send(subscribe);
  expect(yield* receive(ws)).toMatchObject({
    type: "subscription",
    status: "subscribed",
  });
});

it.effect("a grant result reaches its own socket before its departure", () =>
  Effect.gen(function* () {
    const relay = yield* Effect.acquireRelease(
      Effect.sync(() => startRelayServer(config)),
      (server) => Effect.promise(server.stop),
    );
    const client = yield* open(relay.url);
    yield* authenticate(client, "publisher", ["presence"]);
    client.send(
      JSON.stringify({
        type: "presence",
        v: 1,
        hub,
        state: "active",
        in_draft: true,
      }),
    );
    const active = yield* receive(client);
    if (active.type !== "presence" || active.state !== "active")
      throw new Error("Expected the publisher's active presence");

    const frames = on(client, "message");
    try {
      client.send(
        JSON.stringify({
          type: "grant_update",
          v: 1,
          request_id: "read-only",
          token: grant("publisher", 2, []),
        }),
      );
      const ordered = yield* Effect.promise(async () => [
        decode((await frames.next()).value[0]),
        decode((await frames.next()).value[0]),
      ]);
      expect(ordered).toMatchObject([
        { type: "grant_result", request_id: "read-only", status: "applied" },
        {
          type: "presence",
          state: "left",
          hub,
          connection_id: active.connection_id,
        },
      ]);
    } finally {
      yield* Effect.promise(async () => frames.return?.());
    }
  }),
);

it.effect(
  "waits through partial Bun drains and reports outstanding bytes even after a positive send",
  () =>
    Effect.sync(() => {
      let sent = 23;
      let buffered = 8;
      const raw = {
        sendText: () => sent,
        getBufferedAmount: () => buffered,
        close: () => undefined,
        terminate: () => undefined,
      };
      const socket = new BunRelaySocket(raw);
      expect(socket.send("frame")).toBe("paused");
      buffered = 1;
      expect(BunRelaySocket.isWritable(raw)).toBe(false);
      buffered = 0;
      expect(BunRelaySocket.isWritable(raw)).toBe(true);
      expect(socket.send("frame")).toBe("sent");
      sent = -1;
      expect(socket.send("frame")).toBe("paused");
      sent = 0;
      expect(socket.send("frame")).toBe("closed");
    }),
);

it.effect(
  "enforces the transport payload limit before a fragmented message ends",
  () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireRelease(
        Effect.sync(() => startRelayServer(config)),
        (server) => Effect.promise(server.stop),
      );
      const client = yield* open(relay.url);
      const closed = once(client, "close");
      client.send(" ".repeat(RELAY_MAX_FRAME_BYTES + 1), { fin: false });
      const [code] = yield* Effect.promise(() => closed);
      expect([1006, 1009]).toContain(code);
    }),
  900,
);

it.effect(
  "delivers the latest coalesced cursor when a real slow reader resumes without a close",
  () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireRelease(
        Effect.sync(() => startRelayServer(config)),
        (server) => Effect.promise(server.stop),
      );
      const reader = yield* open(relay.url);
      const writer = yield* open(relay.url);
      yield* authenticate(reader, "reader");
      yield* authenticate(writer, "w".repeat(128));
      reader.pause();

      const total = 32_000;
      const cursor = (index: number) => ({
        type: "reading_cursor",
        v: 1,
        hub,
        cursor: {
          message_id: String(index).padStart(128, "m"),
          offset: index / total,
        },
      });
      const marker = {
        type: "subscribe",
        v: 1,
        hub: { kind: "session", id: "marker" },
      };
      const observed: number[] = [];
      const readerFinished = Promise.withResolvers<number | null>();
      const writerFinished = Promise.withResolvers<void>();
      const onClose = () => readerFinished.resolve(null);
      reader.once("close", onClose);
      reader.on("message", (data) => {
        const parsed = parseRelayServerFrame(String(data));
        if (
          !parsed.ok ||
          parsed.value.type !== "reading_cursor" ||
          !parsed.value.cursor
        )
          return;
        const { seq, cursor: position } = parsed.value;
        observed.push(seq);
        if (position.offset === 1) readerFinished.resolve(seq);
      });
      writer.on("message", (data) => {
        const parsed = parseRelayServerFrame(String(data));
        if (
          parsed.ok &&
          parsed.value.type === "subscription" &&
          parsed.value.hub.id === "marker"
        )
          writerFinished.resolve();
      });
      for (let index = 1; index <= total; index++)
        writer.send(JSON.stringify(cursor(index)));
      writer.send(JSON.stringify(marker));
      yield* Effect.promise(() => writerFinished.promise);
      expect(observed).toHaveLength(0);
      reader.resume();
      const last = yield* Effect.promise(() => readerFinished.promise);
      expect(last).toBe(total);
      expect(reader.readyState).toBe(WebSocket.OPEN);
      expect(observed.length).toBeGreaterThan(1);
      expect(observed.length).toBeLessThan(total);

      reader.send(subscribe);
      const reply: RelayServerFrame = yield* receive(reader);
      expect(reply).toMatchObject({
        type: "subscription",
        status: "subscribed",
      });
      reader.off("close", onClose);
    }),
  8000,
);
