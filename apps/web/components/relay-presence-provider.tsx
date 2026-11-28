import type {
  RelayHubStatus,
  RelayHubStatusMeta,
  RelaySubscribeOptions,
} from "@codecast/relay-client";
import { useConvex, useConvexAuth } from "convex/react";
import { useMemo, useState, type ReactNode } from "react";
import { useIsSyncHost } from "../hooks/use-sync-role";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  RelayPresenceAvailableContext,
  RelayPresenceContext,
  RelayTokenDeltasAvailableContext,
  RelayTokenDeltasContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { relayEndpointUrl } from "../lib/relay-presence-config";
import { useInboxStore } from "../store/inboxStore";

function ActiveRelayPresence({
  url,
  presence,
  tokenDeltas,
  inboxLiveness,
  children,
}: {
  url: string;
  presence: boolean;
  tokenDeltas: boolean;
  inboxLiveness: boolean;
  children: ReactNode;
}) {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const viewerId = useInboxStore((store) => store.currentUser?._id);
  const account = isAuthenticated ? viewerId : undefined;
  const scope = useMemo(
    () =>
      account ? { account, url, convex, inboxLiveness, tokenDeltas } : null,
    [account, url, convex, inboxLiveness, tokenDeltas],
  );
  const [connection, setConnection] = useState<{
    scope: NonNullable<typeof scope>;
    client: RelayPresenceClient;
  } | null>(null);
  const [failedScope, setFailedScope] = useState<typeof scope | null>(null);

  useWatchEffect(() => {
    if (!scope || typeof window.WebSocket !== "function") return;
    const { account, url, convex, inboxLiveness } = scope;
    const lifetime = new AbortController();
    const load = async () => {
      const { createRelayClient } = await import("@codecast/relay-client");
      if (lifetime.signal.aborted) return;
      const statusListeners = new Map<
        string,
        Set<(status: RelayHubStatus, meta?: RelayHubStatusMeta) => void>
      >();
      const client = createRelayClient({
        getToken: (hubs, signal) =>
          useInboxStore
            .getState()
            .mintRelayGrant(convex, account, url, hubs, signal),
        WebSocket: window.WebSocket,
        sessionLiveness: inboxLiveness,
        tokenDeltas: scope.tokenDeltas,
        onStatus(hub, status, meta) {
          if (hub.kind !== "session") return;
          const listeners = statusListeners.get(hub.id);
          if (!listeners) return;
          for (const listener of [...listeners]) {
            listener(status, meta);
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
          subscribe(
            sessionId,
            handler,
            onStatus,
            options?: RelaySubscribeOptions,
          ) {
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
                options,
              );
              const current = client.status({ kind: "session", id: sessionId });
              if (onStatus && current !== undefined) onStatus(current);
              return () => {
                unlisten?.();
                unsubscribe();
              };
            } catch {
              onStatus?.("unavailable");
              unlisten?.();
              return () => {};
            }
          },
          status(sessionId) {
            return client.status({ kind: "session", id: sessionId });
          },
          publish: client.publish,
        },
      });
    };
    void load().catch(() => {
      if (!lifetime.signal.aborted) setFailedScope(scope);
    });
    return () => {
      lifetime.abort();
      setConnection(null);
    };
  }, [scope]);

  const available = Boolean(
    scope && typeof window.WebSocket === "function" && failedScope !== scope,
  );
  const client =
    scope && connection?.scope === scope ? connection.client : null;
  return (
    <RelayPresenceAvailableContext value={presence && available}>
      <RelayPresenceContext value={presence ? client : null}>
        <RelayTokenDeltasAvailableContext value={tokenDeltas && available}>
          <RelayTokenDeltasContext value={tokenDeltas ? client : null}>
            {children}
          </RelayTokenDeltasContext>
        </RelayTokenDeltasAvailableContext>
      </RelayPresenceContext>
    </RelayPresenceAvailableContext>
  );
}

export function RelayPresenceProvider({ children }: { children: ReactNode }) {
  const isSyncHost = useIsSyncHost();
  const presence = import.meta.env.VITE_RELAY_PRESENCE === "1";
  const tokenDeltas = import.meta.env.VITE_RELAY_TOKEN_DELTAS === "1";
  const url = relayEndpointUrl(
    import.meta.env.VITE_RELAY_URL,
    import.meta.env.VITE_RELAY_PRESENCE,
    import.meta.env.VITE_RELAY_TOKEN_DELTAS,
  );
  return url ? (
    <ActiveRelayPresence
      url={url.href}
      presence={presence}
      tokenDeltas={tokenDeltas}
      inboxLiveness={
        presence &&
        isSyncHost &&
        import.meta.env.VITE_RELAY_INBOX_LIVENESS === "1"
      }
    >
      {children}
    </ActiveRelayPresence>
  ) : (
    children
  );
}
