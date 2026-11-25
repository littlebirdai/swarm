import { api } from "@codecast/convex/convex/_generated/api";
import { useConvex, useConvexAuth } from "convex/react";
import { useMemo, useState, type ReactNode } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  RelayPresenceContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { relayPresenceUrl } from "../lib/relay-presence-config";
import { useInboxStore } from "../store/inboxStore";

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
  const scope = useMemo(
    () => (account ? { account, url, convex } : null),
    [account, url, convex],
  );
  const [connection, setConnection] = useState<{
    scope: NonNullable<typeof scope>;
    client: RelayPresenceClient;
  } | null>(null);

  useWatchEffect(() => {
    if (!scope || typeof window.WebSocket !== "function") return;
    const { account, url, convex } = scope;
    const lifetime = new AbortController();
    const load = async () => {
      const { createRelayClient } = await import("@codecast/relay-client");
      if (lifetime.signal.aborted) return;
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
      lifetime.signal.addEventListener(
        "abort",
        () => {
          document.removeEventListener("visibilitychange", sync);
          window.removeEventListener("online", sync);
          window.removeEventListener("offline", sync);
          client.close();
        },
        { once: true },
      );
      setConnection({
        scope,
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
    };
    void load().catch(() => {});
    return () => {
      lifetime.abort();
      setConnection(null);
    };
  }, [scope]);

  const client =
    scope && connection?.scope === scope ? connection.client : null;
  return <RelayPresenceContext value={client}>{children}</RelayPresenceContext>;
}

export function RelayPresenceProvider({ children }: { children: ReactNode }) {
  const url = relayPresenceUrl(
    import.meta.env.VITE_RELAY_PRESENCE,
    import.meta.env.VITE_RELAY_URL,
  );
  return url ? (
    <ActiveRelayPresence url={url.href}>{children}</ActiveRelayPresence>
  ) : (
    children
  );
}
