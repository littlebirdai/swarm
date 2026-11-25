import { api } from "@codecast/convex/convex/_generated/api";
import { createRelayClient } from "@codecast/relay-client";
import { useConvex, useConvexAuth } from "convex/react";
import { useState, type ReactNode } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  RelayPresenceContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { useInboxStore } from "../store/inboxStore";

function configuredRelayUrl(): string | null {
  const address = import.meta.env.VITE_RELAY_URL;
  if (import.meta.env.VITE_RELAY_PRESENCE !== "1" || !address) return null;
  try {
    const url = new URL(address);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "wss:") return url.href;
    if (
      url.protocol === "ws:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return url.href;
  } catch {
    return null;
  }
  return null;
}

function ActiveRelayPresence({
  url,
  children,
}: {
  url: string;
  children: ReactNode;
}) {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const viewerId = useInboxStore((store) => store.currentUser?._id);
  const account = isAuthenticated ? viewerId : undefined;
  const [connection, setConnection] = useState<{
    account: string;
    url: string;
    convex: typeof convex;
    client: RelayPresenceClient;
  } | null>(null);

  useWatchEffect(() => {
    if (!account || typeof window.WebSocket !== "function") return;
    const client = createRelayClient({
      async getToken(hubs, signal) {
        if (
          signal.aborted ||
          useInboxStore.getState().currentUser?._id !== account
        )
          return { status: "unauthenticated" };
        try {
          const result = await convex.mutation(api.relayGrants.mint, {
            hubs: hubs.flatMap((hub) =>
              hub.kind === "session" ? [{ kind: hub.kind, id: hub.id }] : [],
            ),
          });
          if (
            signal.aborted ||
            useInboxStore.getState().currentUser?._id !== account
          )
            return { status: "unauthenticated" };
          return result.status === "ok" ? { ...result, url } : result;
        } catch {
          return { status: "unavailable" };
        }
      },
      WebSocket: window.WebSocket,
      now: () => performance.now(),
      setTimer(callback, delayMs) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
      random: Math.random,
    });
    const sync = () => {
      if (document.hidden || !navigator.onLine) client.pause();
      else client.resume();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    setConnection({
      account,
      url,
      convex,
      client: {
        subscribe(sessionId, handler) {
          try {
            return client.subscribe(
              { kind: "session", id: sessionId },
              handler,
            );
          } catch {
            return () => {};
          }
        },
        publish: client.publish,
      },
    });
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      client.close();
    };
  }, [account, url, convex]);

  const client =
    account === connection?.account &&
    url === connection?.url &&
    convex === connection?.convex
      ? connection.client
      : null;
  return <RelayPresenceContext value={client}>{children}</RelayPresenceContext>;
}

export function RelayPresenceProvider({ children }: { children: ReactNode }) {
  const url = configuredRelayUrl();
  return url ? (
    <ActiveRelayPresence url={url}>{children}</ActiveRelayPresence>
  ) : (
    children
  );
}
