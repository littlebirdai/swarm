import { expect, test } from "bun:test";
import type { RelayEvent } from "../src";
import { apply, harness, latestUpdate, subscribed } from "./fake-socket";
import { fakeGrant, presence, second, session } from "./fixtures";

test("gives the handshake a full deadline after a slow token response", async () => {
  const token = Promise.withResolvers<typeof fakeGrant>();
  const { client, advance, sockets } = harness(() => token.promise);
  client.subscribe(session, () => {});
  await advance(4900);
  token.resolve(fakeGrant);
  await advance(0);
  const socket = sockets[0];
  socket.opened();
  await advance(4999);
  expect(socket.closed).toBe(false);
  await advance(1);
  expect(socket.closed).toBe(true);
  client.close();
});

test("backs off before following a changed relay URL", async () => {
  let url = "ws://relay.invalid/relay";
  const { client, open, advance, sockets, requests } = harness(async () => ({
    ...fakeGrant,
    url,
  }));
  client.subscribe(session, () => {});
  const first = await open(2000);
  url = "ws://other.invalid/relay";
  await advance(1000);
  expect(first.closed).toBe(true);
  expect(requests).toHaveLength(2);
  await advance(249);
  expect(sockets).toHaveLength(1);
  await advance(1);
  expect(sockets.at(-1)?.url).toBe(url);
  client.close();
});

test("resets socket backoff only after a healthy interval", async () => {
  const { client, advance, open, sockets } = harness();
  client.subscribe(session, () => {});
  const first = await open();
  first.ended();
  await advance(250);
  const second = await open();
  await advance(5000);
  second.ended();
  await advance(249);
  expect(sockets).toHaveLength(2);
  await advance(1);
  expect(sockets).toHaveLength(3);
  client.close();
});

test("backs off a thrown token batch while established hubs keep working", async () => {
  let unavailable = true;
  const { client, advance, open, requests, sockets } = harness(async (hubs) => {
    if (unavailable && hubs.some((hub) => hub.id === second.id))
      throw new Error("busy");
    return fakeGrant;
  });
  client.subscribe(session, () => {});
  const socket = await open();
  subscribed(socket);
  client.subscribe(second, () => {});
  await advance(0);
  expect(socket.closed).toBe(false);
  client.publish(presence);
  expect(socket.frames.at(-1)).toEqual(presence);
  await advance(249);
  expect(requests).toHaveLength(2);
  unavailable = false;
  await advance(1);
  apply(socket);
  expect(socket.frames.at(-1)).toMatchObject({
    type: "subscribe",
    hub: second,
  });
  expect(sockets).toHaveLength(1);
  client.close();
});

test("retries a temporarily omitted hub and never retries an inaccessible hub", async () => {
  const blocked = { ...session, id: "blocked" };
  const token = Promise.withResolvers<typeof fakeGrant>();
  let calls = 0;
  const { client, open, advance, requests } = harness(() => {
    calls++;
    if (calls === 1) return token.promise;
    if (calls === 2) {
      return Promise.resolve({
        status: "denied",
        omitted: [
          { id: second.id, reason: "unavailable" },
          { id: blocked.id, reason: "inaccessible" },
        ],
      });
    }
    return Promise.resolve(fakeGrant);
  });
  client.subscribe(session, () => {});
  client.subscribe(second, () => {});
  client.subscribe(blocked, () => {});
  token.resolve(fakeGrant);
  const socket = await open();
  await advance(249);
  expect(requests).toHaveLength(2);
  await advance(1);
  expect(requests.at(-1)?.[0]).toEqual([second]);
  apply(socket);
  expect(socket.frames.at(-1)).toMatchObject({
    type: "subscribe",
    hub: second,
  });
  client.close();
});

test("closes when all grants are unused and keeps inaccessible hubs dormant", async () => {
  let allowed = true;
  const { client, open, advance, requests } = harness(async (hubs) => {
    if (allowed) return fakeGrant;
    return {
      ...fakeGrant,
      status: "denied" as const,
      omitted: hubs.map(({ id }) => ({ id, reason: "inaccessible" as const })),
    };
  });
  const leave = client.subscribe(session, () => {});
  const socket = await open(2000);
  allowed = false;
  await advance(1000);
  expect(socket.closed).toBe(true);
  await advance(60_000);
  client.pause();
  client.resume();
  await advance(500);
  expect(requests).toHaveLength(2);
  leave();
  client.close();
});

test.each(["subject_mismatch", "unsupported_grant_version"])(
  "stops after grant refusal %s",
  async (code) => {
    const { client, open, advance, requests } = harness();
    client.subscribe(session, () => {});
    const socket = await open(2000);
    await advance(1000);
    socket.message({
      v: 1,
      type: "grant_result",
      status: "refused",
      request_id: latestUpdate(socket).request_id,
      code,
    });
    await advance(60_000);
    expect(socket.closed).toBe(true);
    expect(requests).toHaveLength(2);
    client.close();
  },
);

test("backs off a denied subscription without repeated requests on the same hub", async () => {
  const { client, open, advance, requests } = harness();
  client.subscribe(session, () => {});
  const socket = await open();
  socket.message({
    v: 1,
    type: "subscription",
    status: "denied",
    hub: session,
  });
  client.subscribe(session, () => {});
  await advance(249);
  expect(socket.frames.filter(({ type }) => type === "subscribe")).toHaveLength(
    1,
  );
  await advance(1);
  expect(socket.frames.filter(({ type }) => type === "subscribe")).toHaveLength(
    2,
  );
  expect(requests).toHaveLength(1);
  client.close();
});

test("unsubscribes at once during a pending token request", async () => {
  const waiting = Promise.withResolvers<typeof fakeGrant>();
  const { client, open } = harness(async (hubs) =>
    hubs.some((hub) => hub.id === second.id) ? waiting.promise : fakeGrant,
  );
  const leave = client.subscribe(session, () => {});
  const socket = await open();
  subscribed(socket);
  client.subscribe(second, () => {});
  leave();
  expect(socket.frames.at(-1)).toMatchObject({
    type: "unsubscribe",
    hub: session,
  });
  expect(socket.closed).toBe(false);
  client.close();
});

test("does not open a socket for an abandoned token batch", async () => {
  const waiting = Promise.withResolvers<typeof fakeGrant>();
  const { client, sockets, advance, requests } = harness((hubs) =>
    hubs[0].id === session.id ? waiting.promise : Promise.resolve(fakeGrant),
  );
  const leave = client.subscribe(session, () => {});
  leave();
  client.subscribe(second, () => {});
  waiting.resolve(fakeGrant);
  await advance(0);
  expect(requests.map(([hubs]) => hubs)).toEqual([[session], [second]]);
  await advance(0);
  expect(sockets).toHaveLength(1);
  client.close();
});

test("flushes a queued publication after an in-place grant renewal", async () => {
  const waiting = Promise.withResolvers<typeof fakeGrant>();
  let calls = 0;
  const { client, open, advance } = harness(async (hubs) =>
    calls++ ? waiting.promise : fakeGrant,
  );
  client.subscribe(session, () => {});
  const socket = await open(2000);
  subscribed(socket);
  await advance(2000);
  client.publish(presence, 5000);
  waiting.resolve(fakeGrant);
  await advance(0);
  apply(socket);
  expect(socket.frames.at(-1)).toEqual(presence);
  client.close();
});

test("holds a publication of a hub that subscribes again during its renewal", async () => {
  const waiting = Promise.withResolvers<typeof fakeGrant>();
  let calls = 0;
  const { client, open, advance } = harness(async () =>
    calls++ ? waiting.promise : fakeGrant,
  );
  const leave = client.subscribe(session, () => {});
  const socket = await open(2000);
  subscribed(socket);
  await advance(2000);
  waiting.resolve(fakeGrant);
  await advance(0);
  leave();
  client.subscribe(session, () => {});
  client.publish(presence, 5000);
  apply(socket);
  expect(socket.frames).not.toContainEqual(presence);
  subscribed(socket);
  expect(socket.frames).toContainEqual(presence);
  client.close();
});

test("uses one timer and ignores backwards clock readings", async () => {
  const { client, open, advance, rewind, clock } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, (event) => events.push(event));
  const socket = await open();
  subscribed(socket);
  socket.message({
    ...presence,
    seq: 1,
    ttl_ms: 100,
    connection_id: "peer",
    user_id: "user",
  });
  expect(clock.timerCount).toBe(1);
  await advance(90);
  socket.message({
    ...presence,
    seq: 2,
    ttl_ms: 100,
    connection_id: "peer",
    user_id: "user",
  });
  rewind(100);
  socket.message({
    ...presence,
    seq: 3,
    ttl_ms: 100,
    connection_id: "peer",
    user_id: "user",
  });
  await advance(99);
  expect(events.map(({ type }) => type)).toEqual([
    "signal",
    "signal",
    "signal",
  ]);
  await advance(1);
  expect(events).toHaveLength(3);
  await advance(100);
  expect(events.at(-1)?.type).toBe("removed");
  client.close();
});

test("finishes cleanup when the socket close throws", async () => {
  const { client, open, sockets } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, (event) => events.push(event));
  const socket = await open();
  subscribed(socket);
  socket.message({
    ...presence,
    seq: 1,
    ttl_ms: 1000,
    connection_id: "peer",
    user_id: "user",
  });
  socket.close = () => {
    throw new Error("transport already closed");
  };
  expect(() => client.pause()).not.toThrow();
  expect(events.at(-1)?.type).toBe("removed");
  client.resume();
  await open();
  expect(sockets).toHaveLength(2);
  client.close();
});

test("skips a handler removed by another handler in the same dispatch", async () => {
  const { client, open } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, () => leave());
  const leave = client.subscribe(session, (event) => events.push(event));
  const socket = await open();
  subscribed(socket);
  socket.message({
    ...presence,
    seq: 1,
    ttl_ms: 1000,
    connection_id: "peer",
    user_id: "user",
  });
  expect(events).toEqual([]);
  client.close();
});

test("gives an in-place grant reply a full deadline after a slow token response", async () => {
  const token = Promise.withResolvers<typeof fakeGrant>();
  let calls = 0;
  const { client, advance, open } = harness(() =>
    calls++ ? token.promise : Promise.resolve(fakeGrant),
  );
  client.subscribe(session, () => {});
  const socket = await open(2000);
  await advance(5900);
  token.resolve(fakeGrant);
  await advance(0);
  await advance(4999);
  expect(socket.closed).toBe(false);
  await advance(1);
  expect(socket.closed).toBe(true);
  client.close();
});

test("accepts a transport without bufferedAmount, message data, or a close code", async () => {
  const { client, advance, open, sockets } = harness();
  client.subscribe(session, () => {});
  const socket = await open();
  subscribed(socket);
  socket.events.dispatchEvent(new Event("message"));
  client.publish(presence);
  expect(socket.frames.at(-1)).toEqual(presence);
  socket.events.dispatchEvent(new Event("close"));
  await advance(250);
  expect(sockets).toHaveLength(2);
  client.close();
});

test("schedules overdue observation expiry without a negative delay", async () => {
  const { client, open, advance, rewind, clock } = harness();
  const events: RelayEvent[] = [];
  client.subscribe(session, (event) => events.push(event));
  const socket = await open();
  subscribed(socket);
  const observed = {
    ...presence,
    seq: 1,
    ttl_ms: 100,
    connection_id: "peer",
    user_id: "user",
  };
  socket.message(observed);
  rewind(-200);
  socket.message({ ...observed, connection_id: "second" });
  expect(clock.deadline).toBe(clock.now());
  await advance(0);
  expect(events.at(-1)).toEqual({ type: "removed", signal: observed });
  client.close();
});
