import {
  parseRelayClientFrame,
  type RelayClientFrame,
} from "@codecast/relay-contract";
import { createRelayClient, type RelayClientOptions } from "../src";
import { fakeClock, fakeGrant, session } from "./fixtures";

type SocketEvents = {
  open: Event;
  message: Event & { data?: unknown };
  close: Event & { code?: number };
};

class FakeSocket {
  bufferedAmount?: number;
  url = "";
  closed = false;
  frames: RelayClientFrame[] = [];
  events = new EventTarget();

  addEventListener<K extends keyof SocketEvents>(
    type: K,
    handler: (event: SocketEvents[K]) => void,
  ) {
    this.events.addEventListener(type, (event) =>
      handler(event as SocketEvents[K]),
    );
  }

  send(text: string) {
    const parsed = parseRelayClientFrame(text);
    if (!parsed.ok) throw new Error("Invalid client frame");
    this.frames.push(parsed.value);
  }

  close() {
    this.closed = true;
  }

  opened() {
    this.events.dispatchEvent(new Event("open"));
  }

  message(frame: object | string) {
    this.events.dispatchEvent(
      new MessageEvent("message", {
        data: typeof frame === "string" ? frame : JSON.stringify(frame),
      }),
    );
  }

  ended(code = 1006) {
    const event = new Event("close");
    Object.assign(event, { code });
    this.events.dispatchEvent(event);
  }
}

export function harness(getToken?: RelayClientOptions["getToken"], random = 0) {
  const clock = fakeClock();
  let offset = 0;
  const sockets: FakeSocket[] = [];
  const requests: Parameters<RelayClientOptions["getToken"]>[] = [];
  const client = createRelayClient({
    ...clock,
    now: () => clock.now() + offset,
    random: () => random,
    WebSocket: class extends FakeSocket {
      constructor(url: string) {
        super();
        this.url = url;
        sockets.push(this);
      }
    },
    getToken(hubs, signal) {
      requests.push([hubs, signal]);
      return getToken ? getToken(hubs, signal) : Promise.resolve(fakeGrant);
    },
  });
  async function open(
    ttl = 60_000,
    capabilities = [
      "presence",
      "draft_cursor",
      "reading_cursor",
      "baton_heartbeat",
    ],
  ) {
    await clock.advance(0);
    const socket = sockets.at(-1)!;
    socket.opened();
    socket.message({
      type: "hello",
      status: "ok",
      version: 1,
      capabilities,
      connection_id: "local",
      ttl_ms: ttl,
    });
    return socket;
  }
  return {
    ...clock,
    client,
    sockets,
    requests,
    open,
    clock,
    rewind(ms: number) {
      offset -= ms;
    },
  };
}

export function subscribed(
  socket: FakeSocket,
  hub = session as { kind: "session"; id: string },
) {
  socket.message({ v: 1, type: "subscription", status: "subscribed", hub });
}

export function latestUpdate(socket: FakeSocket) {
  const frame = [...socket.frames]
    .reverse()
    .find(({ type }) => type === "grant_update");
  if (frame?.type !== "grant_update") throw new Error("Missing grant update");
  return frame;
}

export function apply(socket: FakeSocket, ttl_ms = 60_000) {
  socket.message({
    v: 1,
    type: "grant_result",
    status: "applied",
    request_id: latestUpdate(socket).request_id,
    ttl_ms,
  });
}
