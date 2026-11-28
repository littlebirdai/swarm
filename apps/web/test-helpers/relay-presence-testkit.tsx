import { afterEach, beforeAll, beforeEach } from "bun:test";
import type { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useContext, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { RelayPresenceContext } from "../lib/relay-presence-context";

export const relayUrl = "wss://relay.test/relay";
export const hub = { kind: "session", id: "conversation" } as const;
export const ok = {
  status: "ok",
  token: "v1.claims.signature",
  ttl_ms: 60_000,
  omitted: [],
} satisfies FunctionReturnType<typeof api.relayGrants.mint>;
export class RelaySocket {
  private readonly events = new window.EventTarget();
  readonly frames: Record<string, unknown>[] = [];
  closed = false;

  constructor(readonly url: string) {}

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

export function relayMountFixture() {
  const sockets: RelaySocket[] = [];
  class TestSocket extends RelaySocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  const keys = ["VITE_RELAY_URL", "VITE_RELAY_INBOX_LIVENESS"] as const;
  let env: (string | undefined)[];

  beforeAll(async () => {
    await import("@codecast/relay-client");
  });

  beforeEach(() => {
    env = keys.map((key) => process.env[key]);
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

  return { sockets, WebSocket: TestSocket as unknown as typeof WebSocket };
}

export function SessionPresenceReader({ paired }: { paired: boolean }) {
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
