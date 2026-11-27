import { expect, jest, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName } from "convex/server";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { rowHeartbeatAliveAt } from "@codecast/inbox/inboxProjection";
import { act, useState } from "react";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { SessionCard } from "./inbox/SessionCard";
import { useSyncInboxRelayLiveness } from "../hooks/use-sync-inbox-relay-liveness";
import { type InboxSession } from "../store/inboxStore";
import { webBuilders } from "../test-helpers/builders";
import { measureIndexedDB } from "../perf/measure-indexeddb";
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
const row = (id: string) =>
  webBuilders(`relay-inbox-${id}`).session.build({
    _id: id,
    agent_type: "codex",
    agent_status: "idle",
    updated_at: inboxNow - 2 * 60 * 60 * 1000,
    owner_device_id: device,
    liveness_lease_end: inboxNow + 120_000,
  });

function InboxRelayView({ second = false, first = true }) {
  useSyncInboxRelayLiveness();
  const [cards] = useState(() => [row(inboxRowId), row(otherRowId)]);
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

function mountInboxRelay({ follower = false, node = inboxRelayView() } = {}) {
  return mountWeb(node, {
    authenticated: true,
    clock: true,
    setup(backend, store) {
      jest.setSystemTime(inboxNow);
      store.currentUser = { _id: viewerId };
      store.syncRole = follower ? "follower" : "host";
      window.WebSocket = TestSocket;
      Object.defineProperty(navigator, "onLine", { value: true });
      store.syncTable("sessions", [row(inboxRowId), row(otherRowId)]);
      backend.set(api.relayGrants.inboxTargets, {
        viewer: viewerId,
        targets: [{ id: inboxRowId, run: 2, machine: device }],
      });
      backend.mutation(api.relayGrants.mint, ok);
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
  const { db } = await import("../store/persistence/db");
  const {
    _reopenForTests,
    _resetPersistedShadow,
    flushLivenessWrites,
    setHydrating,
    writePatchesToIDB,
  } = await import("../store/idb-cache");
  const restoreDispatch = replaceGlobals({
    dispatchEvent: window.dispatchEvent.bind(window),
  });
  const principal = spyOn(authPrincipal, "current").mockReturnValue(viewerId);
  try {
    const { writes } = measureIndexedDB(db);
    await _reopenForTests({ indexedDB, IDBKeyRange });
    _resetPersistedShadow();
    setHydrating(false);
    const writeRow = (value: InboxSession) =>
      writePatchesToIDB(
        [{ op: "replace", path: ["sessions", inboxRowId], value }],
        { sessions: { [inboxRowId]: value }, pending: {} },
      );
    writeRow(row);
    await db.table("sessions").get(inboxRowId);
    expect(writes.get("sessions")).toBeGreaterThan(0);
    writes.clear();
    writeRow({
      ...row,
      liveness_lease_end: (row.liveness_lease_end ?? 0) + 1000,
    });
    flushLivenessWrites();
    await db.table("sessions").get(inboxRowId);
    expect(writes.get("sessions")).toBe(1);
    writes.clear();

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
    flushLivenessWrites();
    await db.table("sessions").get(inboxRowId);
    expect(
      [...writes.values()].reduce((total, count) => total + count, 0),
    ).toBe(0);
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
    db.close();
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
