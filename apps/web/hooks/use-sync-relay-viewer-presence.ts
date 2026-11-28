import { api } from "@codecast/convex/convex/_generated/api";
import { useContext, useMemo } from "react";
import { teamMembersOf } from "../lib/activeTeam";
import { isConvexId } from "../lib/entityLinks";
import {
  RelayPresenceAvailableContext,
  RelayPresenceContext,
  RelayTokenDeltasAvailableContext,
  RelayTokenDeltasContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { useInboxStore } from "../store/inboxStore";
import { relayViewerUnknownIds } from "../store/relay-viewer-presence-slice";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

type SharedViewerSubscription = {
  count: number;
  unsubscribe: () => void;
};

const viewerSubscriptions = new WeakMap<
  RelayPresenceClient,
  Map<string, SharedViewerSubscription>
>();

export function composeConversationId(docId: string): string | null {
  if (!docId.startsWith("compose:")) return null;
  const id = docId.slice("compose:".length);
  return isConvexId(id) ? id : null;
}

export function useRelayViewerTargetState(
  conversationId: string | null | undefined,
  enabled: boolean,
  channel: "presence" | "tokenDeltas" = "presence",
) {
  const presenceClient = useContext(RelayPresenceContext);
  const presenceAvailable = useContext(RelayPresenceAvailableContext);
  const tokenDeltaClient = useContext(RelayTokenDeltasContext);
  const tokenDeltaAvailable = useContext(RelayTokenDeltasAvailableContext);
  const client = channel === "tokenDeltas" ? tokenDeltaClient : presenceClient;
  const available =
    channel === "tokenDeltas" ? tokenDeltaAvailable : presenceAvailable;
  const validId =
    conversationId && isConvexId(conversationId) ? conversationId : null;
  const account = client?.viewerAccount;
  const shouldQuery = Boolean(
    available && enabled && client && account && validId,
  );

  const target = useQueryNoThrow(
    api.relayGrants.viewerTarget,
    shouldQuery && validId ? { conversation_id: validId } : "skip",
  );

  const activeTarget =
    available &&
    enabled &&
    client &&
    account &&
    validId &&
    target.data?.viewer === account
      ? target.data
      : null;

  const unknownSig = useInboxStore((state) => {
    if (!activeTarget || !validId) return "";
    return relayViewerUnknownIds(
      state.relayViewerPresence[validId],
      teamMembersOf(state),
    ).join(",");
  });

  const unknownIds = useMemo(
    () => (unknownSig ? unknownSig.split(",") : []),
    [unknownSig],
  );

  const identities = useQueryNoThrow(
    api.relayGrants.viewerIdentities,
    activeTarget && validId && unknownIds.length > 0
      ? { conversation_id: validId, user_ids: unknownIds }
      : "skip",
  );

  useWatchEffect(() => {
    if (
      !activeTarget ||
      !validId ||
      !identities.data ||
      unknownIds.length === 0
    )
      return;
    useInboxStore
      .getState()
      .setRelayViewerIdentities(
        validId,
        activeTarget.viewer,
        unknownIds,
        identities.data,
      );
  }, [activeTarget, validId, identities.data, unknownIds]);

  return {
    available,
    client,
    account,
    validId,
    target,
    activeTarget,
    disabled:
      available &&
      Boolean(client && account && validId && enabled) &&
      (Boolean(target.error) || target.data === null),
  };
}

export function useSubscribeRelayViewer(
  state: ReturnType<typeof useRelayViewerTargetState>,
  enabled: boolean,
) {
  const { available, client, account, validId, target } = state;
  const targetError = Boolean(target.error);
  const targetNull = target.data === null;
  const targetData = target.data;
  const targetViewer =
    targetData && targetData.viewer === account ? targetData.viewer : null;
  const targetHub = targetViewer ? targetData!.hub : null;
  const targetTier = targetViewer ? targetData!.tier : null;

  useWatchEffect(() => {
    if (!available || !validId || !client || !account || !enabled) return;
    if (targetError || targetNull) {
      const store = useInboxStore.getState();
      store.setRelayViewerStatus(validId, account, "", "disabled");
      store.applyRelayTokenDeltaStatus(validId, "disabled");
      return;
    }
    if (!targetViewer || !targetHub || !targetTier) return;
    let map = viewerSubscriptions.get(client);
    if (!map) {
      map = new Map();
      viewerSubscriptions.set(client, map);
    }
    const subKey = `${validId}\0${targetViewer}\0${targetHub}\0${targetTier}`;
    let shared = map.get(subKey);
    if (!shared) {
      useInboxStore
        .getState()
        .setRelayViewerStatus(validId, targetViewer, targetHub, "connecting");
      let unsubscribe = () => {};
      try {
        unsubscribe = client.subscribe(
          targetHub,
          (event) => {
            const store = useInboxStore.getState();
            if (
              event.type === "signal" &&
              event.signal.type === "token_delta"
            ) {
              store.applyRelayTokenDeltaSignal(validId, event.signal);
              return;
            }
            store.applyRelayViewerEvent(
              validId,
              targetViewer,
              targetHub,
              event,
              Date.now(),
            );
          },
          (status, meta) => {
            const mapped =
              status === "unavailable"
                ? meta?.terminal
                  ? "disabled"
                  : "unknown"
                : status;
            const store = useInboxStore.getState();
            store.setRelayViewerStatus(
              validId,
              targetViewer,
              targetHub,
              mapped,
            );
            store.applyRelayTokenDeltaStatus(validId, status);
          },
          { batchKey: targetTier, terminalUnavailable: true },
        );
      } catch {
        const store = useInboxStore.getState();
        store.setRelayViewerStatus(validId, targetViewer, targetHub, "unknown");
        store.applyRelayTokenDeltaStatus(validId, "unavailable");
      }
      shared = { count: 0, unsubscribe };
      map.set(subKey, shared);
    }
    shared.count += 1;
    return () => {
      shared.count -= 1;
      if (shared.count > 0) return;
      map.delete(subKey);
      shared.unsubscribe();
      const store = useInboxStore.getState();
      store.applyRelayTokenDeltaStatus(validId, "disabled");
      const current = store.relayViewerPresence[validId];
      if (
        current &&
        current.viewer === targetViewer &&
        current.hub === targetHub
      ) {
        store.clearRelayViewerPresence(validId);
      }
    };
  }, [
    available,
    client,
    account,
    validId,
    enabled,
    targetError,
    targetNull,
    targetViewer,
    targetHub,
    targetTier,
  ]);
}

export function useSyncRelayViewerPresence(
  conversationId: string | null | undefined,
  enabled: boolean,
) {
  const state = useRelayViewerTargetState(conversationId, enabled);
  useSubscribeRelayViewer(state, enabled);
  return {
    available: state.available,
    client: state.client,
    target: state.activeTarget,
    disabled: state.disabled,
  };
}

export function useSyncRelayTokenDeltas(
  conversationId: string | null | undefined,
  enabled: boolean,
) {
  const state = useRelayViewerTargetState(
    conversationId,
    enabled,
    "tokenDeltas",
  );
  useSubscribeRelayViewer(state, enabled);
}
