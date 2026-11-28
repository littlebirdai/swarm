import type { ReplicationChannel, ReplicationMessage } from "@platform/engine";
import {
  extractViewScopes,
  isKnownHomeScope,
  type ScopeStoreInput,
} from "./scope-subscription-candidates";
import { SCOPE_SUBSCRIPTION_BUDGET } from "./scope-subscriptions";

type ScopeViewMsg = Extract<ReplicationMessage, { type: "mut" }> & {
  scopeView?: string[];
};

export const SCOPE_PEER_VIEW_REFRESH_MS = 5_000;
export const SCOPE_PEER_VIEW_LEASE_MS = 15_000;

function sanitizePeerViewScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const set = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && isKnownHomeScope(item)) {
      set.add(item);
      if (set.size >= SCOPE_SUBSCRIPTION_BUDGET) break;
    }
  }
  return [...set].sort();
}

export function createScopeViewTransport(opts: {
  selfId: string;
  channel: ReplicationChannel;
  getState: () => ScopeStoreInput & { syncRole?: string };
  subscribe: (listener: (state: any, prev: any) => void) => () => void;
  onPeerView: (peerId: string, scopes: readonly string[]) => void;
  onClearPeerViews: () => void;
  heartbeatMs?: number;
  leaseMs?: number;
}) {
  const heartbeatMs = opts.heartbeatMs ?? SCOPE_PEER_VIEW_REFRESH_MS;
  const leaseMs = opts.leaseMs ?? SCOPE_PEER_VIEW_LEASE_MS;
  let lastSentKey: string | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let pagehideOff: (() => void) | null = null;
  const peerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let isFollowing = false;
  let isHost = false;

  const clearPeerTimer = (peerId: string) => {
    const existing = peerTimers.get(peerId);
    if (existing !== undefined) {
      clearTimeout(existing);
      peerTimers.delete(peerId);
    }
  };

  const clearAllPeerTimers = () => {
    for (const timer of peerTimers.values()) clearTimeout(timer);
    peerTimers.clear();
  };

  const applyPeerView = (peerId: string, scopes: readonly string[]) => {
    clearPeerTimer(peerId);
    if (scopes.length > 0 && leaseMs > 0) {
      peerTimers.set(
        peerId,
        setTimeout(() => {
          peerTimers.delete(peerId);
          opts.onPeerView(peerId, []);
        }, leaseMs),
      );
    }
    opts.onPeerView(peerId, scopes);
  };

  const postLeave = () => {
    opts.channel.post({ type: "leave", from: opts.selfId } as any);
  };

  const sendCurrentView = (force = false) => {
    if (!isFollowing) return;
    const state = opts.getState();
    const scopes = extractViewScopes(state)
      .filter((s) => isKnownHomeScope(s))
      .sort()
      .slice(0, SCOPE_SUBSCRIPTION_BUDGET);
    if (force && scopes.length === 0) return;
    const key = scopes.join("\x1f");
    if (!force && key === lastSentKey) return;
    lastSentKey = key;
    const msg: ScopeViewMsg = {
      type: "mut",
      from: opts.selfId,
      updates: [],
      scopeView: scopes,
    };
    opts.channel.post(msg);
  };

  const channel: ReplicationChannel = {
    post(msg) {
      opts.channel.post(msg);
    },
    onMessage(callback) {
      return opts.channel.onMessage((msg) => {
        if (!msg || typeof msg !== "object") return;
        const raw = msg as unknown as {
          type?: unknown;
          from?: unknown;
          updates?: unknown;
          scopeView?: unknown;
        };
        if (isHost) {
          const fromId =
            typeof raw.from === "string" &&
            raw.from.length > 0 &&
            raw.from !== opts.selfId
              ? raw.from
              : null;
          if (raw.type === "leave") {
            if (fromId) applyPeerView(fromId, []);
            return;
          }
          if (raw.type === "mut" && "scopeView" in raw) {
            if (
              !fromId ||
              !Array.isArray(raw.updates) ||
              raw.scopeView === undefined
            ) {
              return;
            }
            const sanitized = sanitizePeerViewScopes(raw.scopeView);
            if (!sanitized) return;
            applyPeerView(fromId, sanitized);
            if (raw.updates.length === 0) return;
          }
        }
        callback(msg);
      });
    },
  };

  const stopFollowing = (sendClear = true) => {
    if (unsubscribeStore) {
      unsubscribeStore();
      unsubscribeStore = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (pagehideOff) {
      pagehideOff();
      pagehideOff = null;
    }
    if (isFollowing && sendClear) {
      const msg: ScopeViewMsg = {
        type: "mut",
        from: opts.selfId,
        updates: [],
        scopeView: [],
      };
      opts.channel.post(msg);
      postLeave();
    }
    isFollowing = false;
    lastSentKey = null;
  };

  const startFollowing = () => {
    clearAllPeerTimers();
    isHost = false;
    isFollowing = true;
    lastSentKey = null;
    sendCurrentView(false);
    if (!unsubscribeStore) {
      unsubscribeStore = opts.subscribe((state, prev) => {
        if (!isFollowing) return;
        if (
          state.activeTabId === prev.activeTabId &&
          state.tabs === prev.tabs &&
          state.projects === prev.projects &&
          state.tasks === prev.tasks &&
          state.docs === prev.docs &&
          state.docDetails === prev.docDetails &&
          state.plans === prev.plans &&
          state.scopeViewTargets === prev.scopeViewTargets
        ) {
          return;
        }
        sendCurrentView(false);
      });
    }
    if (!refreshTimer && heartbeatMs > 0) {
      refreshTimer = setInterval(() => sendCurrentView(true), heartbeatMs);
    }
    if (!pagehideOff && typeof window !== "undefined") {
      const onPageHide = () => {
        if (isFollowing) postLeave();
      };
      window.addEventListener("pagehide", onPageHide);
      pagehideOff = () => window.removeEventListener("pagehide", onPageHide);
    }
  };

  const startHost = () => {
    stopFollowing(false);
    clearAllPeerTimers();
    isHost = true;
    opts.onClearPeerViews();
  };

  const stop = () => {
    stopFollowing(true);
    clearAllPeerTimers();
    if (isHost) {
      isHost = false;
      opts.onClearPeerViews();
    }
  };

  return {
    channel,
    startFollowing,
    stopFollowing,
    startHost,
    stop,
    sendCurrentView,
  };
}

export function scopeViewTransportFor(
  selfId: string,
  channel: ReplicationChannel,
  store: {
    getState: () => any;
    subscribe: (listener: (state: any, prev: any) => void) => () => void;
  },
) {
  return createScopeViewTransport({
    selfId,
    channel,
    getState: store.getState,
    subscribe: store.subscribe,
    onPeerView: (peerId, scopes) =>
      store.getState().setPeerViewScopes(peerId, scopes),
    onClearPeerViews: () => store.getState().clearPeerViewScopes(),
  });
}
