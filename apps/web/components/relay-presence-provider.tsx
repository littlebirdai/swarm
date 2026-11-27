import type { RelayHubStatus } from "@codecast/relay-client";
import { useConvex, useConvexAuth } from "convex/react";
import { useMemo, useState, type ReactNode } from "react";
import { useIsSyncHost } from "../hooks/use-sync-role";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  RelayPresenceContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { relayPresenceUrl } from "../lib/relay-presence-config";
import { useInboxStore } from "../store/inboxStore";

function ActiveRelayPresence({
  url,
  inboxLiveness,
  children,
}: {
  url: string;
  inboxLiveness: boolean;
  children: ReactNode;
}) {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const viewerId = useInboxStore((store) => store.currentUser?._id);
  const account = isAuthenticated ? viewerId : undefined;
  const scope = useMemo(
    () => (account ? { account, url, convex, inboxLiveness } : null),
    [account, url, convex, inboxLiveness],
  );
  const [connection, setConnection] = useState<{
    scope: NonNullable<typeof scope>;
    client: RelayPresenceClient;
  } | null>(null);

  useWatchEffect(() => {
    if (!scope || typeof window.WebSocket !== "function") return;
    const { account, url, convex, inboxLiveness } = scope;
    const lifetime = new AbortController();
    const load = async () => {
      const { createRelayClient } = await import("@codecast/relay-client");
      if (lifetime.signal.aborted) return;
      const statusListeners = new Map<
        string,
        Set<(status: RelayHubStatus) => void>
      >();
      const viewerFeedCounts = new Map<string, number>();
      const client = createRelayClient({
        getToken: (hubs, signal) =>
          useInboxStore
            .getState()
            .mintRelayGrant(convex, account, url, hubs, signal),
        WebSocket: window.WebSocket,
        sessionLiveness: inboxLiveness,
        onStatus(hub, status) {
          if (hub.kind !== "session") return;
          const listeners = statusListeners.get(hub.id);
          if (!listeners) return;
          for (const listener of [...listeners]) {
            listener(status);
          }
        },
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
          ...(inboxLiveness && { inboxViewer: account }),
          viewerAccount: account,
          subscribe(sessionId, handler, onStatus) {
            let unlisten: (() => void) | undefined;
            if (onStatus) {
              let set = statusListeners.get(sessionId);
              if (!set) {
                set = new Set();
                statusListeners.set(sessionId, set);
              }
              set.add(onStatus);
              unlisten = () => {
                set.delete(onStatus);
                if (set.size === 0) statusListeners.delete(sessionId);
              };
            }
            try {
              const unsubscribe = client.subscribe(
                { kind: "session", id: sessionId },
                handler,
              );
              const current = client.status({ kind: "session", id: sessionId });
              if (onStatus && current !== undefined) onStatus(current);
              return () => {
                unlisten?.();
                unsubscribe();
              };
            } catch {
              unlisten?.();
              return () => {};
            }
          },
          status(sessionId) {
            return client.status({ kind: "session", id: sessionId });
          },
          retainViewerFeed(conversationId, onRelease) {
            viewerFeedCounts.set(
              conversationId,
              (viewerFeedCounts.get(conversationId) ?? 0) + 1,
            );
            return () => {
              const next = (viewerFeedCounts.get(conversationId) ?? 1) - 1;
              if (next > 0) {
                viewerFeedCounts.set(conversationId, next);
                return;
              }
              viewerFeedCounts.delete(conversationId);
              onRelease();
            };
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
  const isSyncHost = useIsSyncHost();
  const url = relayPresenceUrl(
    import.meta.env.VITE_RELAY_PRESENCE,
    import.meta.env.VITE_RELAY_URL,
  );
  return url ? (
    <ActiveRelayPresence
      url={url.href}
      inboxLiveness={
        isSyncHost && import.meta.env.VITE_RELAY_INBOX_LIVENESS === "1"
      }
    >
      {children}
    </ActiveRelayPresence>
  ) : (
    children
  );
}
