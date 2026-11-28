import type { ReplicationChannel, ReplicationMessage } from "@platform/engine";
import {
  extractViewScopes,
  type ScopeStoreInput,
} from "./scope-subscription-candidates";
import { clientScopeSubscriptionsEnabled } from "./scope-subscriptions";

type ScopeViewMsg = Extract<ReplicationMessage, { type: "mut" }> & {
  scopeView?: string[];
};

export function createScopeViewTransport(opts: {
  selfId: string;
  channel: ReplicationChannel;
  getState: () => ScopeStoreInput & { syncRole?: string };
  subscribe: (listener: (state: any, prev: any) => void) => () => void;
  onPeerView: (peerId: string, scopes: readonly string[]) => void;
  onClearPeerViews: () => void;
}) {
  let lastSentKey: string | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let isFollowing = false;
  let isHost = false;

  const sendCurrentView = () => {
    if (!clientScopeSubscriptionsEnabled() || !isFollowing) return;
    const scopes = extractViewScopes(opts.getState()).sort();
    const key = scopes.join("\x1f");
    if (key === lastSentKey) return;
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
        const raw = msg as ScopeViewMsg & { from?: string };
        if (
          isHost &&
          clientScopeSubscriptionsEnabled() &&
          raw.type === "mut" &&
          Array.isArray(raw.scopeView)
        ) {
          opts.onPeerView(raw.from, raw.scopeView);
          if (raw.updates.length === 0) return;
        }
        if (
          isHost &&
          clientScopeSubscriptionsEnabled() &&
          (raw as any).type === "leave" &&
          typeof raw.from === "string"
        ) {
          opts.onPeerView(raw.from, []);
          return;
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
    if (isFollowing && sendClear && clientScopeSubscriptionsEnabled()) {
      const msg: ScopeViewMsg = {
        type: "mut",
        from: opts.selfId,
        updates: [],
        scopeView: [],
      };
      opts.channel.post(msg);
    }
    isFollowing = false;
    lastSentKey = null;
  };

  const startFollowing = () => {
    if (!clientScopeSubscriptionsEnabled()) return;
    isHost = false;
    isFollowing = true;
    lastSentKey = null;
    sendCurrentView();
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
          state.plans === prev.plans
        ) {
          return;
        }
        sendCurrentView();
      });
    }
  };

  const startHost = () => {
    stopFollowing(false);
    isHost = true;
    opts.onClearPeerViews();
  };

  const stop = () => {
    stopFollowing(true);
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
  return clientScopeSubscriptionsEnabled()
    ? createScopeViewTransport({
        selfId,
        channel,
        getState: store.getState,
        subscribe: store.subscribe,
        onPeerView: (peerId, scopes) =>
          store.getState().setPeerViewScopes(peerId, scopes),
        onClearPeerViews: () => store.getState().clearPeerViewScopes(),
      })
    : undefined;
}
