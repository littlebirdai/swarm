import { expect, test } from "bun:test";
import type { RelayEvent } from "../src";
import { apply, harness, latestUpdate, subscribed } from "./fake-socket";
import { cursor, fakeGrant, presence, second, session } from "./fixtures";

test("opens lazily, keeps same-turn hub switches, and closes after the last unsubscribe", async () => {
  const { client, sockets, open, advance, requests } = harness();
  await advance(100);
  expect(requests).toHaveLength(0);
  const unsubscribe = client.subscribe(session, () => {});
  const other = client.subscribe(session, () => {});
  const socket = await open();
  subscribed(socket);
  expect(socket.frames.map(({ type }) => type)).toEqual([
    "connect",
    "subscribe",
  ]);
  unsubscribe();
  other();
  expect(socket.frames.at(-1)?.type).toBe("unsubscribe");
  const last = client.subscribe(second, () => {});
  await advance(0);
  apply(socket);
  expect(socket.frames).toContainEqual({
    v: 1,
    type: "subscribe",
    hub: second,
  });
  expect(sockets).toEqual([socket]);
  last();
  await advance(0);
  expect(socket.closed).toBe(true);
  await advance(60_000);
  expect(sockets).toHaveLength(1);
});

test("pause and close abort token requests and discard stale completions", async () => {
  const beforePause = Promise.withResolvers<typeof fakeGrant>();
  const afterResume = Promise.withResolvers<typeof fakeGrant>();
  let calls = 0;
  const { client, advance, requests, sockets } = harness(() =>
    calls++ ? afterResume.promise : beforePause.promise,
  );
  client.subscribe(session, () => {});
  client.pause();
  expect(requests[0][1].aborted).toBe(true);
  await advance(10_000);
  expect(requests).toHaveLength(1);
  client.resume();
  beforePause.resolve(fakeGrant);
  await advance(0);
  expect(sockets).toHaveLength(0);
  client.close();
  expect(requests[1][1].aborted).toBe(true);
  afterResume.resolve(fakeGrant);
  await advance(0);
  expect(sockets).toHaveLength(0);
});

test("requests grants in contract-sized batches and correlates refresh replies", async () => {
  const { client, open, advance, requests, sockets } = harness();
  for (let index = 0; index < 256; index++)
    client.subscribe({ ...session, id: String(index) }, () => {});
  const socket = await open();
  await advance(0);
  expect(() => client.subscribe(session, () => {})).toThrow(RangeError);
  expect(requests[0][0]).toEqual([{ ...session, id: "0" }]);
  expect(requests[1][0]).toHaveLength(16);
  const update = latestUpdate(socket);
  socket.message({
    v: 1,
    type: "grant_result",
    status: "applied",
    request_id: "unknown",
    ttl_ms: 60_000,
  });
  expect(socket.frames.filter(({ type }) => type === "subscribe")).toHaveLength(
    1,
  );
  for (let index = 1; index <= 16; index++) {
    socket.message({
      v: 1,
      type: "grant_result",
      status: "applied",
      request_id: latestUpdate(socket).request_id,
      ttl_ms: 60_000,
    });
    await advance(0);
  }
  expect(socket.frames.filter(({ type }) => type === "subscribe")).toHaveLength(
    256,
  );
  expect(Math.max(...requests.map(([hubs]) => hubs.length))).toBe(16);
  expect(sockets).toHaveLength(1);
  client.close();
});

test("isolates handlers, rejects bad or old signals, and expires ordered peer observations", async () => {
  const { client, open, advance, sockets } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, () => {
    throw new Error("handler");
  });
  client.subscribe(session, (event) => events.push(event));
  const socket = await open();
  subscribed(socket);
  function peer<const T extends object>(signal: T) {
    return {
      connection_id: "peer",
      user_id: "user",
      seq: 1,
      ttl_ms: 100,
      ...signal,
    };
  }
  socket.message("{malformed");
  socket.message({ ...peer(presence), connection_id: "invalid id" });
  const draft = peer(cursor);
  const active = peer(presence);
  const another = { ...active, seq: 2, connection_id: "another" };
  socket.message(draft);
  socket.message(active);
  socket.message(another);
  socket.message(active);
  const left = { ...active, state: "left", ttl_ms: 0, seq: 2 } as const;
  socket.message(left);
  socket.message(active);
  const reading = peer({
    ...cursor,
    type: "reading_cursor",
    cursor: { message_id: "message", offset: 0.5 },
  });
  socket.message(reading);
  const clear = { ...reading, cursor: null, ttl_ms: 0, seq: 2 };
  socket.message(clear);
  expect(events).toEqual([
    { type: "signal", signal: draft },
    { type: "signal", signal: active },
    { type: "signal", signal: another },
    { type: "removed", signal: draft },
    { type: "signal", signal: left },
    { type: "signal", signal: reading },
    { type: "signal", signal: clear },
  ]);
  await advance(99);
  expect(events).toHaveLength(7);
  await advance(1);
  expect(events.at(-1)).toEqual({ type: "removed", signal: another });
  socket.message({ ...another, seq: 3 });
  socket.ended();
  expect(events.at(-1)).toEqual({
    type: "removed",
    signal: { ...another, seq: 3 },
  });
  expect(sockets).toHaveLength(1);
  client.close();
});

test("sends only fresh latest cursor and presence after subscription confirmation", async () => {
  const { client, open, advance } = harness();
  client.subscribe(session, () => {});
  const first = await open();
  subscribed(first);
  client.publish(presence, 2000);
  expect(first.frames.at(-1)).toEqual(presence);
  first.ended();
  client.publish({ v: 1, hub: session, type: "baton_heartbeat" }, 2000);
  client.publish(cursor, 2000);
  const latest = { ...cursor, cursor: { revision: 1, anchor: 5, head: 5 } };
  client.publish(latest, 2000);
  client.publish(presence, 200);
  client.publish(
    {
      ...cursor,
      type: "reading_cursor",
      cursor: { message_id: "msg", offset: 0.5 },
    },
    2000,
  );
  client.publish(
    { v: 1, hub: session, type: "reading_cursor", cursor: null },
    2000,
  );
  await advance(250);
  const second = await open();
  expect(second.frames.map(({ type }) => type)).toEqual([
    "connect",
    "subscribe",
  ]);
  subscribed(second);
  expect(second.frames.slice(2)).toEqual([latest]);
  second.ended();
  await advance(500);
  const third = await open();
  subscribed(third);
  expect(third.frames.map(({ type }) => type)).toEqual([
    "connect",
    "subscribe",
  ]);
  client.close();
});

test("caps queued signals and prevents WebSocket send buffer growth", async () => {
  const { client, open, advance } = harness();
  const hubs = Array.from({ length: 256 }, (_, index) => ({
    ...session,
    id: String(index),
  }));
  for (const hub of hubs) {
    client.subscribe(hub, () => {});
    client.publish({ ...presence, hub }, 60_000);
    client.publish({ ...cursor, hub }, 60_000);
  }
  for (const hub of hubs)
    client.publish({ v: 1, type: "baton_heartbeat", hub }, 60_000);
  const socket = await open();
  subscribed(socket, hubs[0]);
  expect(
    socket.frames.filter(
      ({ type }) => type === "presence" || type === "draft_cursor",
    ),
  ).toHaveLength(0);
  for (let index = 1; index <= 16; index++) {
    await advance(0);
    socket.message({
      v: 1,
      type: "grant_result",
      status: "applied",
      request_id: latestUpdate(socket).request_id,
      ttl_ms: 60_000,
    });
  }
  subscribed(socket, hubs[255]);
  expect(socket.frames.slice(-2)).toEqual([
    { ...presence, hub: hubs[255] },
    { ...cursor, hub: hubs[255] },
  ]);
  const length = socket.frames.length;
  socket.bufferedAmount = 32_768;
  client.publish({ ...presence, hub: hubs[255] }, 1000);
  expect(socket.frames).toHaveLength(length);
  expect(socket.closed).toBe(true);
  client.close();
});

test("uses bounded jitter, honors retry-after, and gets a fresh token for policy closes", async () => {
  const { client, sockets, open, requests, advance } = harness(undefined, 0.5);
  client.subscribe(session, () => {});
  const first = await open();
  first.message({ type: "hello", status: "unavailable", retry_after_ms: 4000 });
  client.pause();
  client.resume();
  await advance(3999);
  expect(sockets).toHaveLength(1);
  await advance(1);
  expect(sockets).toHaveLength(2);
  const delays = [750, 1500, 3000, 6000, 11250, 11250];
  for (const delay of delays) {
    const count = sockets.length;
    sockets.at(-1)!.ended(1008);
    await advance(delay - 1);
    expect(sockets).toHaveLength(count);
    await advance(1);
    expect(sockets).toHaveLength(count + 1);
  }
  expect(requests).toHaveLength(8);
  client.close();
});

test.each([1002, 1003, 1009])("stops after protocol close %i", async (code) => {
  const { client, sockets, open, advance } = harness();
  client.subscribe(session, () => {});
  (await open()).ended(code);
  client.pause();
  client.resume();
  await advance(60_000);
  expect(sockets).toHaveLength(1);
  client.close();
});

test("retries a malformed handshake and stops on an incompatible negotiated version", async () => {
  const { client, sockets, advance } = harness();
  client.subscribe(session, () => {});
  await advance(0);
  sockets[0].opened();
  sockets[0].message("{broken");
  expect(sockets[0].closed).toBe(true);
  await advance(250);
  sockets[1].opened();
  sockets[1].message({
    type: "hello",
    status: "ok",
    version: 2,
    capabilities: [],
    connection_id: "wrong",
    ttl_ms: 1000,
  });
  await advance(60_000);
  expect(sockets).toHaveLength(2);
  expect(sockets[1].closed).toBe(true);
  client.close();
});

test("refreshes on the same socket before expiry and retries a refused token", async () => {
  const { client, open, advance, requests, sockets } = harness();
  client.subscribe(session, () => {});
  const socket = await open(2000);
  await advance(999);
  expect(requests).toHaveLength(1);
  await advance(1);
  expect(requests).toHaveLength(2);
  expect(sockets).toHaveLength(1);
  socket.message({
    v: 1,
    type: "grant_result",
    status: "refused",
    code: "stale_token",
    request_id: latestUpdate(socket).request_id,
  });
  await advance(250);
  expect(requests).toHaveLength(3);
  expect(sockets).toHaveLength(2);
  client.close();
});

test("times out a stalled token request and recovers with a fresh request", async () => {
  const stalled = Promise.withResolvers<typeof fakeGrant>();
  let calls = 0;
  const { client, advance, requests, sockets } = harness(() =>
    calls++ ? Promise.resolve(fakeGrant) : stalled.promise,
  );
  client.subscribe(session, () => {});
  await advance(4999);
  expect(requests[0][1].aborted).toBe(false);
  await advance(1);
  expect(requests[0][1].aborted).toBe(true);
  await advance(250);
  stalled.resolve(fakeGrant);
  await advance(0);
  expect(sockets).toHaveLength(1);
  expect(requests).toHaveLength(2);
  client.close();
});

test("bounds handler and peer observation state", async () => {
  const { client, open, advance } = harness();
  const removed: string[] = [];
  client.subscribe(session, ({ type, signal }) => {
    if (type === "removed") removed.push(signal.connection_id);
  });
  const unsubscribes = Array.from({ length: 1023 }, () =>
    client.subscribe(session, () => {}),
  );
  expect(() => client.subscribe(session, () => {})).toThrow(RangeError);
  for (const unsubscribe of unsubscribes) unsubscribe();
  const socket = await open();
  subscribed(socket);
  for (let index = 0; index < 4097; index++) {
    socket.message({
      ...presence,
      seq: 1,
      ttl_ms: 100,
      connection_id: String(index),
      user_id: "user",
    });
  }
  expect(removed).toEqual(["0"]);
  await advance(100);
  expect(removed).toHaveLength(4097);
  client.close();
});

test("clears observations on pause and resubscribes on resume", async () => {
  const { client, open, sockets, advance } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, (event) => events.push(event));
  const socket = await open();
  subscribed(socket);
  socket.message({
    ...presence,
    seq: 1,
    ttl_ms: 300,
    connection_id: "peer",
    user_id: "user",
  });
  client.pause();
  expect(socket.closed).toBe(true);
  expect(events.map(({ type }) => type)).toEqual(["signal", "removed"]);
  await advance(60_000);
  expect(sockets).toHaveLength(1);
  client.resume();
  const resumed = await open();
  expect(sockets).toHaveLength(2);
  expect(resumed.frames.at(-1)).toEqual({
    v: 1,
    type: "subscribe",
    hub: session,
  });
  client.close();
});

test("stops delivery of a signal when an earlier handler pauses the client", async () => {
  const { client, open } = harness();
  const received: RelayEvent[] = [];
  client.subscribe(session, ({ type }) => {
    if (type === "signal") client.pause();
  });
  client.subscribe(session, (event) => {
    received.push(event);
  });
  const socket = await open();
  subscribed(socket);
  socket.message({
    ...presence,
    seq: 1,
    ttl_ms: 300,
    connection_id: "peer",
    user_id: "user",
  });
  expect(received.map(({ type }) => type)).toEqual(["removed"]);
  client.close();
});

test("clears an expired subscription and reattaches it after the outstanding renewal", async () => {
  const { client, open, advance } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, (event) => events.push(event));
  const socket = await open(2000);
  subscribed(socket);
  socket.message({
    ...presence,
    seq: 1,
    ttl_ms: 2000,
    connection_id: "peer",
    user_id: "user",
  });
  await advance(1000);
  socket.message({
    v: 1,
    hub: session,
    type: "subscription",
    status: "unsubscribed",
    reason: "expired",
  });
  expect(events.map(({ type }) => type)).toEqual(["signal", "removed"]);
  client.publish(presence);
  expect(socket.frames.at(-1)?.type).toBe("grant_update");
  socket.message({
    v: 1,
    type: "grant_result",
    status: "applied",
    request_id: latestUpdate(socket).request_id,
    ttl_ms: 2000,
  });
  expect(socket.frames.at(-1)?.type).toBe("subscribe");
  client.close();
});
