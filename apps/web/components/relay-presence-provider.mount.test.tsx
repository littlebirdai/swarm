import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { ConvexProviderWithAuth, useConvex } from "convex/react";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { rowHeartbeatAliveAt } from "@codecast/inbox/inboxProjection";
import { SessionCard } from "./inbox/SessionCard";
import { useSyncInboxRelayLiveness } from "../hooks/use-sync-inbox-relay-liveness";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import { webBuilders } from "../test-helpers/builders";
import { measureIndexedDB } from "../perf/measure-indexeddb";
import { replaceGlobals } from "../test-helpers/globals";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import {
  act,
  StrictMode,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { mountWeb } from "../test-helpers/mountWeb";
import { pending } from "../test-helpers/testConvex";
import { useDocPresence } from "../hooks/useDocPresence";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  RelayPresenceContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { RelayPresenceProvider } from "./relay-presence-provider";

const relayUrl = "wss://relay.test/relay";
const hub = { kind: "session", id: "conversation" } as const;
const ok = {
  status: "ok",
  token: "v1.claims.signature",
  ttl_ms: 60_000,
  omitted: [],
} satisfies FunctionReturnType<typeof api.relayGrants.mint>;
const sockets: RelaySocket[] = [];

class RelaySocket {
  private readonly events = new window.EventTarget();
  readonly frames: Record<string, unknown>[] = [];
  closed = false;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.events.addEventListener(type, listener);
  }

  send(text: string) {
    this.frames.push(JSON.parse(text));
  }

  close() {
    this.closed = true;
  }

  message(frame: object) {
    this.events.dispatchEvent(
      new window.MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  join(
    capabilities = ["presence"],
    joined: { kind: "session"; id: string } = hub,
  ) {
    this.events.dispatchEvent(new window.Event("open"));
    this.message({
      type: "hello",
      status: "ok",
      version: 1,
      capabilities,
      connection_id: "viewer",
      ttl_ms: 60_000,
    });
    this.message({
      v: 1,
      type: "subscription",
      status: "subscribed",
      hub: joined,
    });
  }

  fail() {
    this.events.dispatchEvent(new window.CloseEvent("close", { code: 1006 }));
  }

  peer(seq: number, state: "active" | "left", ttl_ms = 0) {
    this.message({
      v: 1,
      type: "presence",
      hub,
      seq,
      state,
      ttl_ms,
      user_id: "peer",
      connection_id: "other",
      in_draft: false,
    });
  }
}

const keys = [
  "VITE_RELAY_PRESENCE",
  "VITE_RELAY_URL",
  "VITE_RELAY_INBOX_LIVENESS",
] as const;
let env: (string | undefined)[];

beforeAll(async () => {
  await import("@codecast/relay-client");
});

beforeEach(() => {
  env = keys.map((key) => process.env[key]);
  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = relayUrl;
  delete process.env.VITE_RELAY_INBOX_LIVENESS;
  sockets.length = 0;
});

afterEach(() => {
  keys.forEach((key, index) => {
    const value = env[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

function Session({ paired }: { paired: boolean }) {
  const client = useContext(RelayPresenceContext);
  const [peer, setPeer] = useState<string>();
  useWatchEffect(() => {
    setPeer(undefined);
    if (!paired) return;
    return client?.subscribe(hub.id, ({ type, signal }) => {
      if (signal.type !== "presence") return;
      setPeer(
        type === "removed" || signal.state === "left"
          ? undefined
          : signal.user_id,
      );
    });
  }, [client, paired]);
  return <output>{peer ?? "Alone"}</output>;
}

function view(paired: boolean) {
  return (
    <RelayPresenceProvider>
      <Session paired={paired} />
      <Session paired={paired} />
    </RelayPresenceProvider>
  );
}

function mountRelay(
  node = view(true),
  {
    reply = ok,
    visibility = { hidden: false, online: true },
    authenticated = true,
  }: {
    reply?: typeof ok | Error | (() => Promise<typeof ok>);
    visibility?: { hidden: boolean; online: boolean };
    authenticated?: boolean;
  } = {},
) {
  return mountWeb(node, {
    authenticated,
    clock: true,
    expectedConsoleErrors:
      reply instanceof Error ? [/relayGrants:mint.*relay unavailable/] : [],
    setup(backend, store) {
      store.currentUser = { _id: "viewer" };
      window.WebSocket = RelaySocket as unknown as typeof WebSocket;
      Object.defineProperty(document, "hidden", {
        get: () => visibility.hidden,
      });
      Object.defineProperty(navigator, "onLine", {
        get: () => visibility.online,
      });
      backend.mutation(api.relayGrants.mint, reply);
    },
  });
}

test.each([
  ["off", relayUrl],
  ["no URL", undefined],
  ["insecure URL", "ws://relay.test/relay"],
  ["username", "wss://viewer@relay.test/relay"],
  ["password", "wss://:secret@relay.test/relay"],
  ["hash", "wss://relay.test/relay#state"],
  ["empty hash", "wss://relay.test/relay#"],
  ["query", "wss://relay.test/relay?token=secret"],
  ["empty query", "wss://relay.test/relay?"],
] as const)(
  "%s leaves both readers silent with zero Convex queries or writes",
  async (config, url) => {
    if (config === "off") delete process.env.VITE_RELAY_PRESENCE;
    if (url === undefined) delete process.env.VITE_RELAY_URL;
    else process.env.VITE_RELAY_URL = url;
    const ui = await mountRelay();
    expect(ui.container.textContent).toBe("AloneAlone");
    expect(ui.backend.queryRequests).toEqual([]);
    expect(ui.backend.writeRequests).toEqual([]);
    expect(sockets).toHaveLength(0);
  },
);

test.each(["localhost", "127.0.0.1", "[::1]"])(
  "allows ws on loopback %s",
  async (host) => {
    const url = `ws://${host}:3001/relay`;
    process.env.VITE_RELAY_URL = url;
    await mountRelay();
    expect(sockets.map((socket) => socket.url)).toEqual([url]);
  },
);

test("the default flag preserves the legacy presence query and heartbeat writes", async () => {
  delete process.env.VITE_RELAY_PRESENCE;
  const docId = "compose:conversation";
  function LegacyPresence() {
    const present = useDocPresence({
      docId,
      draftText: "Draft",
      enabled: true,
      forceBroadcast: true,
    });
    return <output>{present.map((peer) => peer.user_name).join(", ")}</output>;
  }
  const ui = await mountWeb(
    <RelayPresenceProvider>
      <LegacyPresence />
    </RelayPresenceProvider>,
    {
      clock: true,
      authenticated: true,
      setup(backend) {
        backend.set(api.docSync.getPresence, [
          {
            user_id: "peer",
            user_name: "Peer",
            user_color: "#fff",
            user_image: undefined,
            cursor_pos: undefined,
            anchor_pos: undefined,
            draft_text: undefined,
            can_send: undefined,
            anchor: undefined,
            anchor_at: undefined,
            claims: undefined,
            in_draft: undefined,
            updated_at: 1,
          },
        ]);
        backend.mutation(api.docSync.updatePresence, null);
        backend.mutation(api.docSync.removePresence, null);
      },
    },
  );
  expect(ui.container.textContent).toBe("Peer");
  expect(ui.backend.queryRequests).toEqual([
    { name: "docSync:getPresence", args: { doc_id: docId } },
  ]);
  await ui.clock!.advance(3_000);
  await ui.rerender(null);
  const update = {
    name: "docSync:updatePresence",
    args: { doc_id: docId, draft_text: "Draft" },
  };
  expect(ui.backend.mutations).toEqual([
    update,
    update,
    update,
    { name: "docSync:removePresence", args: { doc_id: docId } },
  ]);
});

test("two readers share one grant and socket, and both see arrival, departure, and expiry", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const ui = await mountRelay(view(false));
    expect(ui.backend.writeRequests).toEqual([]);
    await ui.rerender(view(true));
    expect(ui.backend.queryRequests).toEqual([]);
    expect(ui.backend.mutations).toEqual([
      { name: "relayGrants:mint", args: { hubs: [hub] } },
    ]);
    expect(sockets.map(({ url }) => url)).toEqual([relayUrl]);
    const [socket] = sockets;
    await act(() => socket.join());
    expect(socket.frames[0].capabilities).not.toContain("session_liveness");
    expect(socket.frames.filter((frame) => frame.type === "subscribe")).toEqual(
      [{ type: "subscribe", v: 1, hub }],
    );
    await act(() => socket.peer(1, "active", 200));
    expect(ui.container.textContent).toBe("peerpeer");
    await act(() => socket.peer(2, "left"));
    expect(ui.container.textContent).toBe("AloneAlone");
    await act(() => socket.peer(3, "active", 200));
    expect(ui.container.textContent).toBe("peerpeer");
    clock.mockReturnValue(200);
    await ui.clock!.advance(200);
    expect(ui.container.textContent).toBe("AloneAlone");
    await ui.rerender(view(false));
    expect(socket.closed).toBe(true);
  } finally {
    clock.mockRestore();
  }
});

test("the aborted StrictMode mount leaves no visibility listener or socket", async () => {
  const ui = await mountRelay(<></>);
  const mounted: boolean[] = [];
  function MountProbe() {
    useWatchEffect(() => {
      mounted.push(true);
      return () => {
        mounted.push(false);
      };
    }, []);
    return null;
  }
  const add = spyOn(document, "addEventListener");
  const remove = spyOn(document, "removeEventListener");
  try {
    await ui.rerender(
      <StrictMode>
        <MountProbe />
        {view(true)}
      </StrictMode>,
    );
    expect(mounted).toEqual([true, false, true]);
    expect(sockets).toHaveLength(1);
    await ui.rerender(null);
    expect(sockets[0]?.closed).toBe(true);
    const listeners = add.mock.calls.filter(
      ([type]) => type === "visibilitychange",
    );
    expect(listeners).toHaveLength(1);
    expect(
      remove.mock.calls.filter(([type]) => type === "visibilitychange"),
    ).toEqual(listeners);
  } finally {
    remove.mockRestore();
    add.mockRestore();
  }
});

test("the window stays disconnected while hidden or offline and resumes when both clear", async () => {
  const visibility = { hidden: true, online: true };
  const ui = await mountRelay(view(true), { visibility });
  expect(ui.backend.mutations).toEqual([]);
  visibility.hidden = false;
  await act(() => document.dispatchEvent(new window.Event("visibilitychange")));
  expect(sockets).toHaveLength(1);
  const [socket] = sockets;
  await act(() => socket.join());
  await act(() => socket.peer(1, "active", 200));
  expect(ui.container.textContent).toBe("peerpeer");
  visibility.online = false;
  await act(() => window.dispatchEvent(new window.Event("offline")));
  expect(socket.closed).toBe(true);
  expect(ui.container.textContent).toBe("AloneAlone");
  visibility.hidden = true;
  visibility.online = true;
  await act(() => window.dispatchEvent(new window.Event("online")));
  expect(sockets).toHaveLength(1);
  visibility.hidden = false;
  await act(() => document.dispatchEvent(new window.Event("visibilitychange")));
  expect(sockets).toHaveLength(2);
});

test("a lost socket clears both readers", async () => {
  const ui = await mountRelay();
  const [socket] = sockets;
  await act(() => socket.join());
  await act(() => socket.peer(1, "active", 200));
  expect(ui.container.textContent).toBe("peerpeer");
  await act(() => socket.fail());
  expect(ui.container.textContent).toBe("AloneAlone");
});

test("a failed mint leaves both readers silent", async () => {
  const ui = await mountRelay(view(true), {
    reply: new Error("relay unavailable"),
  });
  expect(ui.backend.mutations).toHaveLength(1);
  expect(sockets).toHaveLength(0);
  expect(ui.container.textContent).toBe("AloneAlone");
});

test("an account switch closes the old socket and discards its signals", async () => {
  const ui = await mountRelay();
  const [socket] = sockets;
  await act(() => socket.join());
  await act(() => socket.peer(1, "active", 200));
  expect(ui.container.textContent).toBe("peerpeer");
  await act(() => ui.store.setState({ currentUser: { _id: "second-viewer" } }));
  expect(socket.closed).toBe(true);
  expect(sockets).toHaveLength(2);
  await act(() => socket.peer(2, "active", 200));
  expect(ui.container.textContent).toBe("AloneAlone");
});

const fetchAccessToken = async () => {
  const claims = Buffer.from(JSON.stringify({ iat: 1, exp: 3601 })).toString(
    "base64url",
  );
  return `eyJhbGciOiJIUzI1NiJ9.${claims}.test`;
};

function TestAuth({
  signedIn,
  children,
}: {
  signedIn: boolean;
  children: ReactNode;
}) {
  const client = useConvex();
  return (
    <ConvexProviderWithAuth
      client={client}
      useAuth={() => ({
        isLoading: false,
        isAuthenticated: signedIn,
        fetchAccessToken,
      })}
    >
      {children}
    </ConvexProviderWithAuth>
  );
}

test("sign-out closes a socket even if its consumer does not unsubscribe", async () => {
  function Reader() {
    const client = useContext(RelayPresenceContext);
    useWatchEffect(() => {
      client?.subscribe(hub.id, () => {});
    }, [client]);
    return null;
  }
  const render = (signedIn: boolean) => (
    <TestAuth signedIn={signedIn}>
      <RelayPresenceProvider>
        <Reader />
      </RelayPresenceProvider>
    </TestAuth>
  );
  const ui = await mountRelay(render(true), { authenticated: false });
  expect(sockets).toHaveLength(1);
  const [socket] = sockets;
  await act(() => socket.join());
  await ui.rerender(render(false));
  expect(socket.closed).toBe(true);
});

test("the same account never receives its closed client after an auth flicker", async () => {
  const committed: (RelayPresenceClient | null)[] = [];
  function Reader() {
    const client = useContext(RelayPresenceContext);
    useLayoutEffect(() => {
      committed.push(client);
    });
    useWatchEffect(() => client?.subscribe(hub.id, () => {}), [client]);
    return null;
  }
  const render = (signedIn: boolean) => (
    <TestAuth signedIn={signedIn}>
      <RelayPresenceProvider>
        <Reader />
      </RelayPresenceProvider>
    </TestAuth>
  );
  const ui = await mountRelay(render(true), { authenticated: false });
  const oldClient = committed.at(-1);
  expect(oldClient).toBeTruthy();
  await ui.rerender(render(false));
  expect(sockets[0]?.closed).toBe(true);
  expect(committed.at(-1)).toBeNull();
  committed.length = 0;
  await ui.rerender(render(true));
  expect(committed.includes(oldClient ?? null)).toBe(false);
  expect(committed.at(-1)).toBeTruthy();
  expect(sockets).toHaveLength(2);
});

test("a pending mint cannot open a socket after the account changes", async () => {
  const mint = Promise.withResolvers<typeof ok>();
  const ui = await mountRelay(view(true), { reply: () => mint.promise });
  expect(ui.backend.mutations).toHaveLength(1);
  const state = ui.store.getState();
  const readState = spyOn(ui.store, "getState").mockReturnValue({
    ...state,
    currentUser: null,
  });
  try {
    await act(async () => mint.resolve(ok));
    expect(sockets).toHaveLength(0);
  } finally {
    readState.mockRestore();
  }
});

test("an invalid session ID leaves the consumer mounted and sends no grant", async () => {
  function Reader() {
    const client = useContext(RelayPresenceContext);
    useWatchEffect(
      () => client?.subscribe("invalid session", () => {}),
      [client],
    );
    return <output>{client ? "Ready" : "Alone"}</output>;
  }
  const ui = await mountRelay(
    <RelayPresenceProvider>
      <Reader />
    </RelayPresenceProvider>,
  );
  expect(ui.container.textContent).toBe("Ready");
  expect(ui.backend.mutations).toHaveLength(0);
  expect(sockets).toHaveLength(0);
});

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
      window.WebSocket = RelaySocket as unknown as typeof WebSocket;
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
