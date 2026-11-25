import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { ConvexProviderWithAuth, useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  act,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { mountWeb } from "../test-helpers/mountWeb";
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

  join() {
    this.events.dispatchEvent(new window.Event("open"));
    this.message({
      type: "hello",
      status: "ok",
      version: 1,
      capabilities: ["presence"],
      connection_id: "viewer",
      ttl_ms: 60_000,
    });
    this.message({ v: 1, type: "subscription", status: "subscribed", hub });
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

const keys = ["VITE_RELAY_PRESENCE", "VITE_RELAY_URL"] as const;
let env: (string | undefined)[];

beforeAll(async () => {
  await import("@codecast/relay-client");
});

beforeEach(() => {
  env = keys.map((key) => process.env[key]);
  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = relayUrl;
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
