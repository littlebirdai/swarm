import { expect, jest, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName } from "convex/server";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  parseRelayServerFrame,
  type RelayGrantClaims,
  type RelayServerFrame,
} from "../../../packages/relay-contract/src/index";
import { startRelayLiveness } from "@codecast/edge-client/relay-liveness";
import { createHmac } from "node:crypto";
import { rowHeartbeatAliveAt } from "@codecast/inbox/inboxProjection";
import { act, useState } from "react";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { SessionCard } from "./inbox/SessionCard";
import { useSyncInboxRelayLiveness } from "../hooks/use-sync-inbox-relay-liveness";
import { type InboxSession } from "../store/inboxStore";
import { webBuilders } from "../test-helpers/builders";
import { replaceGlobals } from "../test-helpers/globals";
import { mountWeb } from "../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
  type RelaySocket,
  SessionPresenceReader as Session,
} from "../test-helpers/relay-presence-testkit";
import { pending } from "../test-helpers/testConvex";
import { RelayPresenceProvider } from "./relay-presence-provider";

const { sockets, WebSocket: TestSocket } = relayMountFixture();

const inboxNow = 1_790_000_000_000;
const inboxRowId = "j7relay".padEnd(32, "0") as Id<"conversations">;
const inboxHub = { kind: "session", id: inboxRowId } as const;
const viewerId = "viewer" as Id<"users">;
const device = "fixture-machine";

const otherRowId = "j7other".padEnd(32, "0") as Id<"conversations">;
const row = (id: string, now = inboxNow) =>
  webBuilders(`relay-inbox-${id}`).session.build({
    _id: id,
    agent_type: "codex",
    agent_status: "idle",
    updated_at: now - 2 * 60 * 60 * 1000,
    owner_device_id: device,
    liveness_lease_end: now + 120_000,
  });

function InboxRelayView({ second = false, first = true, now = inboxNow }) {
  useSyncInboxRelayLiveness();
  const [cards] = useState(() => [row(inboxRowId, now), row(otherRowId, now)]);
  return cards.map((session, index) =>
    (index === 0 ? first : second) ? (
      <SessionCard
        key={session._id}
        session={session}
        isActive={false}
        globalIndex={index}
        sessionLabel={null}
        isFavorite={false}
        onSelect={() => {}}
        onClose={() => {}}
      />
    ) : null,
  );
}

function inboxRelayView(props: Parameters<typeof InboxRelayView>[0] = {}) {
  return (
    <RelayPresenceProvider>
      <InboxRelayView {...props} />
    </RelayPresenceProvider>
  );
}

function mountInboxRelay({
  follower = false,
  now = inboxNow,
  socket = TestSocket,
  grant = ok,
  node = inboxRelayView({ now }),
} = {}) {
  return mountWeb(node, {
    authenticated: true,
    clock: now === inboxNow,
    setup(backend, store) {
      if (now === inboxNow) jest.setSystemTime(now);
      store.currentUser = { _id: viewerId };
      store.syncRole = follower ? "follower" : "host";
      window.WebSocket = socket;
      Object.defineProperty(navigator, "onLine", { value: true });
      store.syncTable("sessions", [row(inboxRowId, now), row(otherRowId, now)]);
      backend.set(api.relayGrants.inboxTargets, {
        viewer: viewerId,
        targets: [{ id: inboxRowId, run: 2, machine: device }],
      });
      backend.mutation(api.relayGrants.mint, grant);
    },
  });
}

const contactDot = (container: Element) =>
  container.querySelector(
    `[data-session-id="${inboxRowId}"] [aria-label="Recent machine contact"]`,
  );

function sendContact(socket: RelaySocket, seq: number, ttl_ms = 15_000) {
  socket.message({
    v: 1,
    hub: inboxHub,
    type: "session_liveness",
    connection_id: "machine-connection",
    ttl_ms,
    seq,
    run: 2,
    machine_id: device,
  });
}

test("the inbox relay flag defaults off", async () => {
  delete process.env.VITE_RELAY_INBOX_LIVENESS;
  const ui = await mountInboxRelay();
  expect(ui.backend.queryRequests).toHaveLength(0);
  expect(ui.backend.writeRequests).toHaveLength(0);
  expect(sockets).toHaveLength(0);
});

test("only current-run relay contact lands and loss falls back to Convex without cache writes", async () => {
  process.env.VITE_RELAY_INBOX_LIVENESS = "1";
  const ui = await mountInboxRelay();
  const [socket] = sockets;
  expect(socket).toBeDefined();
  await act(() => socket.join(["session_liveness"], inboxHub));
  expect(socket.frames[0].capabilities).toContain("session_liveness");
  const indication = () => contactDot(ui.container);
  const row = ui.store.getState().sessions[inboxRowId];

  const { authPrincipal } = await import("../lib/authPrincipal");
  const { cacheStorage, _reopenForTests, setHydrating, writePatchesToIDB } =
    await import("../store/idb-cache");
  const restoreDispatch = replaceGlobals({
    dispatchEvent: window.dispatchEvent.bind(window),
  });
  const principal = spyOn(authPrincipal, "current").mockReturnValue(viewerId);
  const patchSpy = spyOn(cacheStorage, "writePatches");
  try {
    await _reopenForTests({ indexedDB, IDBKeyRange });
    setHydrating(false);
    const writeRow = (value: InboxSession) =>
      writePatchesToIDB(
        [{ op: "replace", path: ["sessions", inboxRowId], value }],
        { sessions: { [inboxRowId]: value }, pending: {} },
      );
    writeRow(row);
    await cacheStorage.flushPersistence();
    expect(patchSpy).toHaveBeenCalled();
    patchSpy.mockClear();

    const signal = (seq: number, run: number, machine_id = device) =>
      socket.message({
        v: 1,
        hub: inboxHub,
        type: "session_liveness",
        connection_id: "machine-connection",
        ttl_ms: 15_000,
        seq,
        run,
        machine_id,
      });
    await act(() => signal(1, 1));
    await act(() => signal(2, 2, "different-machine"));
    expect(indication()).toBeNull();
    await act(() => signal(3, 2));
    expect(indication()).not.toBeNull();
    for (let seq = 4; seq < 10; seq++) await act(() => signal(seq, 2));
    await cacheStorage.flushPersistence();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(ui.store.getState().sessions[inboxRowId]).toBe(row);
    await act(() => signal(10, 1));
    expect(indication()).toBeNull();
    await act(() => signal(11, 2));
    expect(indication()).not.toBeNull();
    await act(() =>
      ui.backend.set(api.relayGrants.inboxTargets, {
        viewer: viewerId,
        targets: [{ id: inboxRowId, run: 3, machine: device }],
      }),
    );
    expect(indication()).toBeNull();
    await act(() =>
      socket.message({
        v: 1,
        type: "subscription",
        status: "subscribed",
        hub: inboxHub,
      }),
    );
    await act(() => signal(12, 2));
    expect(indication()).toBeNull();
    await act(() => signal(13, 3));
    expect(indication()).not.toBeNull();
    expect(
      rowHeartbeatAliveAt(ui.store.getState().sessions[inboxRowId], inboxNow),
    ).toBe(true);

    const setLeaseEnd = (end: number) =>
      act(() =>
        ui.store.getState().applyInboxLivenessPayload("mine", {
          liveness: { [inboxRowId]: { liveness_lease_end: end } },
        }),
      );
    await setLeaseEnd(inboxNow - 1);
    expect(indication()).toBeNull();
    expect(
      rowHeartbeatAliveAt(ui.store.getState().sessions[inboxRowId], inboxNow),
    ).toBe(false);
    await setLeaseEnd(inboxNow + 120_000);
    expect(indication()).not.toBeNull();

    await act(() => socket.fail());
    expect(indication()).toBeNull();
    expect(
      rowHeartbeatAliveAt(ui.store.getState().sessions[inboxRowId], inboxNow),
    ).toBe(true);
    await setLeaseEnd(inboxNow - 1);
    expect(indication()).toBeNull();
    expect(
      rowHeartbeatAliveAt(ui.store.getState().sessions[inboxRowId], inboxNow),
    ).toBe(false);
  } finally {
    patchSpy.mockRestore();
    restoreDispatch();
    principal.mockRestore();
  }
});

test("changing visible cards keeps the first relay watch until the new targets resolve", async () => {
  process.env.VITE_RELAY_INBOX_LIVENESS = "1";
  const ui = await mountInboxRelay();
  const [socket] = sockets;
  await act(() => socket.join(["session_liveness"], inboxHub));
  await act(() => sendContact(socket, 1));
  expect(contactDot(ui.container)).not.toBeNull();
  const writes = ui.backend.mutations.length;
  const frameCount = socket.frames.length;
  await act(() =>
    ui.backend.set(api.relayGrants.inboxTargets, ({ ids }) =>
      ids.includes(otherRowId)
        ? pending
        : {
            viewer: viewerId,
            targets: [{ id: inboxRowId, run: 2, machine: device }],
          },
    ),
  );
  await ui.rerender(inboxRelayView({ second: true }));
  expect(
    ui.backend.queryRequests.some(
      ({ name, args }) =>
        name === getFunctionName(api.relayGrants.inboxTargets) &&
        args !== null &&
        typeof args === "object" &&
        "ids" in args &&
        Array.isArray(args.ids) &&
        args.ids.includes(otherRowId),
    ),
  ).toBe(true);
  expect(contactDot(ui.container)).not.toBeNull();
  expect(socket.closed).toBe(false);
  expect(socket.frames).toHaveLength(frameCount);
  expect(ui.backend.mutations).toHaveLength(writes);

  await ui.rerender(inboxRelayView({ second: true, first: false }));
  expect(ui.store.getState().relayInboxContacts[inboxRowId]).toBeUndefined();
});

test("the real card wakes when its stored lease changes and at both contact deadlines", async () => {
  process.env.VITE_RELAY_INBOX_LIVENESS = "1";
  const ui = await mountInboxRelay();
  const clock = ui.clock!;
  const mono = spyOn(performance, "now").mockImplementation(
    () => Date.now() - inboxNow,
  );
  try {
    const [socket] = sockets;
    await act(() => socket.join(["session_liveness"], inboxHub));
    await act(() => sendContact(socket, 1));
    expect(contactDot(ui.container)).not.toBeNull();
    const setLeaseEnd = (end: number) =>
      act(() =>
        ui.store.getState().applyInboxLivenessPayload("mine", {
          liveness: { [inboxRowId]: { liveness_lease_end: end } },
        }),
      );

    await setLeaseEnd(inboxNow - 1);
    expect(contactDot(ui.container)).toBeNull();
    await setLeaseEnd(inboxNow + 1000);
    expect(contactDot(ui.container)).not.toBeNull();
    await clock.advance(1000);
    expect(contactDot(ui.container)).toBeNull();
    expect(ui.store.getState().relayInboxContacts[inboxRowId]).toBeDefined();

    await setLeaseEnd(inboxNow + 120_000);
    const { setInboxRelayContact, relayInboxContacts } = ui.store.getState();
    await act(() =>
      setInboxRelayContact(inboxRowId, {
        ...relayInboxContacts[inboxRowId]!,
        sequence: 2,
        deadline: 2000,
      }),
    );
    expect(contactDot(ui.container)).not.toBeNull();
    await clock.advance(1000);
    expect(contactDot(ui.container)).toBeNull();
    expect(ui.store.getState().relayInboxContacts[inboxRowId]).toBeDefined();
  } finally {
    mono.mockRestore();
  }
});

test("a follower card records no visibility and its relay skips session liveness", async () => {
  process.env.VITE_RELAY_INBOX_LIVENESS = "1";
  const ui = await mountInboxRelay({
    follower: true,
    node: (
      <RelayPresenceProvider>
        <InboxRelayView />
        <Session paired />
      </RelayPresenceProvider>
    ),
  });
  const [socket] = sockets;
  await act(() => socket.join());
  expect(socket.frames[0].capabilities).toContain("presence");
  expect(socket.frames[0].capabilities).not.toContain("session_liveness");
  expect(ui.store.getState().relayInboxCards).toEqual({});
  expect(ui.backend.queryRequests).toHaveLength(0);
});

test("a machine heartbeat goes through the relay to the inbox card", async () => {
  const key = Buffer.alloc(32, 23);
  const ready = Promise.withResolvers<URL>();
  const server = Bun.spawn(
    [
      process.execPath,
      import.meta.dir + "/../../relay/test/kernel-grant-peer.ts",
    ],
    {
      env: {
        ...process.env,
        RELAY_AUDIENCE: "inbox-test",
        RELAY_HMAC_KEY: key.toString("base64url"),
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: "0",
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
      ipc: (url) => ready.resolve(new URL(String(url))),
    },
  );
  function mint(claims: RelayGrantClaims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const message = `v1.${payload}`;
    const mac = createHmac("sha256", key).update(message).digest("base64url");
    return `${message}.${mac}`;
  }
  const controller = new AbortController();
  let grantSeq = 0;
  type Contact = Extract<RelayServerFrame, { type: "session_liveness" }>;
  const contacts: Array<{ frame: Contact; at: number }> = [];
  const secondHub = { kind: "session", id: otherRowId } as const;
  const subscribed = new Set<string>();
  const socket = class extends WebSocket {
    constructor(url: string | URL) {
      super(url);
      this.addEventListener("message", ({ data }) => {
        const parsed = parseRelayServerFrame(data);
        if (!parsed.ok) return;
        const frame = parsed.value;
        if (frame.type === "subscription" && frame.status === "subscribed")
          subscribed.add(frame.hub.id);
        if (frame.type === "session_liveness")
          contacts.push({ frame, at: performance.now() });
      });
    }
  };
  const ttl = 30_000;
  const issuedAt = Date.now();
  let publisher: ReturnType<typeof startRelayLiveness> | undefined;
  let ui: Awaited<ReturnType<typeof mountInboxRelay>> | undefined;
  try {
    const address = await Promise.race([
      ready.promise,
      server.exited.then((code) => {
        throw new Error(`Relay fixture exited with ${code}`);
      }),
    ]);
    const wsUrl = new URL("/relay", address);
    wsUrl.protocol = "ws:";
    process.env.VITE_RELAY_URL = wsUrl.href;
    process.env.VITE_RELAY_INBOX_LIVENESS = "1";
    const mount = await mountInboxRelay({
      now: issuedAt,
      node: inboxRelayView({ now: issuedAt, second: true }),
      socket,
      grant: {
        ...ok,
        token: mint({
          v: 1,
          audience: "inbox-test",
          subject: { kind: "user", id: viewerId },
          issued_at_ms: issuedAt,
          expires_at_ms: issuedAt + ttl,
          grant_seq: 1,
          grants: [inboxHub, secondHub].map((hub) => ({ ...hub, publish: [] })),
        }),
      },
    });
    ui = mount;
    await act(() =>
      mount.backend.set(api.relayGrants.inboxTargets, {
        viewer: viewerId,
        targets: [inboxHub, secondHub].map(({ id }) => ({
          id,
          run: 2,
          machine: device,
        })),
      }),
    );
    const subscribedBy = performance.now() + 3000;
    while (subscribed.size < 2 && performance.now() < subscribedBy)
      await Bun.sleep(20);
    expect(subscribed.size).toBe(2);
    expect(contactDot(mount.container)).toBeNull();
    const deadline = performance.now() + ttl;
    const leases = (run: number, ids = [inboxRowId]) =>
      ids.map((session) => ({
        session,
        run,
        fencing_token: `fence-${run}`,
        deadline,
      }));
    publisher = startRelayLiveness(
      {
        hello: {
          machine: device,
          boot: "boot",
          capacity: {
            memory_total_bytes: 0,
            memory_available_bytes: 0,
            live_agents: 1,
          },
          providers: [],
          runtimes: [],
        },
        WebSocket: class extends WebSocket {
          constructor() {
            super(wsUrl);
          }
        },
        async transport(operation, request) {
          if (operation === "hello") {
            return {
              status: 200,
              body: {
                status: "ok",
                version: 1,
                policy: {
                  revision: 1,
                  heartbeat_interval_ms: 30_000,
                  uplink_interval_ms: 30_000,
                  limits: {
                    max_batch_events: 32,
                    max_batch_bytes: 100_000,
                    max_blob_bytes: 100_000,
                  },
                  capabilities: ["relay_session_liveness"],
                },
              },
            };
          }
          if (operation !== "relay-grant" || !("sessions" in request))
            throw new Error(`Unexpected Edge request: ${operation}`);
          if (grantSeq === 0)
            expect(request.sessions.map(({ session }) => session)).toEqual([
              inboxRowId,
              otherRowId,
            ]);
          for (const lease of request.sessions)
            expect(lease.fencing_token).toBe(`fence-${lease.run}`);
          const at = Date.now();
          return {
            status: 200,
            body: {
              status: "ok",
              v: 1,
              url: "wss://relay.test/relay",
              ttl_ms: ttl,
              token: mint({
                v: 1,
                audience: "inbox-test",
                subject: { kind: "machine", id: device },
                issued_at_ms: at,
                expires_at_ms: at + ttl,
                grant_seq: ++grantSeq,
                grants: request.sessions.map(({ session, run }) => ({
                  kind: "session",
                  id: session,
                  run,
                  publish: ["session_liveness"],
                })),
              }),
            },
          };
        },
      },
      controller.signal,
      leases(2, [inboxRowId, otherRowId]),
    );
    async function waitForContacts(count: number) {
      await act(async () => {
        const end = performance.now() + 11_000;
        while (contacts.length < count && performance.now() < end)
          await Bun.sleep(20);
      });
      expect(contacts).toHaveLength(count);
    }
    await waitForContacts(2);
    const [first] = contacts;
    expect(contacts.map(({ frame }) => frame.seq)).toEqual([1, 2]);
    expect(contacts.map(({ frame }) => frame.hub.id).sort()).toEqual(
      [inboxRowId, otherRowId].sort(),
    );
    for (const { frame } of contacts) {
      expect(frame.machine_id).toBe(device);
      expect(frame.run).toBe(2);
      expect(frame.ttl_ms).toBeGreaterThan(0);
      expect(frame.ttl_ms).toBeLessThanOrEqual(15_000);
    }
    expect(contactDot(mount.container)).not.toBeNull();
    await waitForContacts(4);
    expect(contacts.map(({ frame }) => frame.seq)).toEqual([1, 2, 3, 4]);
    for (const id of [inboxRowId, otherRowId]) {
      const beats = contacts.filter(({ frame }) => frame.hub.id === id);
      expect(beats).toHaveLength(2);
      const interval = beats[1].at - beats[0].at;
      expect(interval).toBeGreaterThanOrEqual(4_950);
      expect(interval).toBeLessThan(8_000);
      expect(beats[1].frame.connection_id).toBe(first.frame.connection_id);
    }
    await act(() =>
      mount.backend.set(api.relayGrants.inboxTargets, {
        viewer: viewerId,
        targets: [{ id: inboxRowId, run: 3, machine: device }],
      }),
    );
    expect(contactDot(mount.container)).toBeNull();
    publisher.update(leases(3));
    await waitForContacts(5);
    const afterRunChange = contacts[4];
    expect(afterRunChange.frame).toMatchObject({ run: 3, seq: 1 });
    expect(afterRunChange.frame.connection_id).not.toBe(
      first.frame.connection_id,
    );
    expect(contactDot(mount.container)).not.toBeNull();
  } finally {
    controller.abort();
    await publisher?.running.catch(() => {});
    try {
      await ui?.close();
    } finally {
      server.stdin.end();
      await server.exited;
    }
  }
}, 30_000);
