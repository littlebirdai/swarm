import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { act, useContext, useState } from "react";
import { mountWeb } from "../test-helpers/mountWeb";
import { useDocPresence } from "../hooks/useDocPresence";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { RelayPresenceContext } from "../lib/relay-presence-context";
import { RelayPresenceProvider } from "./relay-presence-provider";

const relayUrl = "wss://relay.test/relay";
const hub = { kind: "session", id: "conversation" } as const;
const ok = {
  status: "ok",
  token: "v1.claims.signature",
  ttl_ms: 60_000,
  omitted: [],
} as const;
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
  paired = true,
  reply: typeof ok | Error = ok,
  visibility = { hidden: false, online: true },
) {
  return mountWeb(view(paired), {
    authenticated: true,
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
      backend.mutation(
        api.relayGrants.mint,
        reply instanceof Error
          ? reply
          : {
              ...reply,
              omitted: [],
            },
      );
    },
  });
}

test.each(["off", "no URL", "insecure URL"])(
  "%s leaves both readers silent with zero Convex queries or writes",
  async (config) => {
    if (config === "off") delete process.env.VITE_RELAY_PRESENCE;
    if (config === "no URL") delete process.env.VITE_RELAY_URL;
    if (config === "insecure URL")
      process.env.VITE_RELAY_URL = "ws://relay.test";
    const ui = await mountRelay();
    expect(ui.container.textContent).toBe("AloneAlone");
    expect(ui.backend.queryRequests).toEqual([]);
    expect(ui.backend.writeRequests).toEqual([]);
    expect(sockets).toEqual([]);
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
    const ui = await mountRelay(false);
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
  const ui = await mountRelay(true, ok, visibility);
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
  const ui = await mountRelay(true, new Error("relay unavailable"));
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
