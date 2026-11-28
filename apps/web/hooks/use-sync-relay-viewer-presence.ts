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
  presenceCount: number;
  tokenDeltasCount: number;
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
  const isPresence = channel === "presence";
  const client = isPresence ? presenceClient : tokenDeltaClient;
  const available = isPresence ? presenceAvailable : tokenDeltaAvailable;
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
    if (!isPresence || !activeTarget || !validId) return "";
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
    isPresence && activeTarget && validId && unknownIds.length > 0
      ? { conversation_id: validId, user_ids: unknownIds }
      : "skip",
  );

  useWatchEffect(() => {
    if (
      !isPresence ||
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
  }, [isPresence, activeTarget, validId, identities.data, unknownIds]);

  return {
    channel,
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
  const { channel, available, client, account, validId, target } = state;
  const targetError = Boolean(target.error);
  const targetNull = target.data === null;
  const targetData = target.data;
  const targetViewer =
    targetData && targetData.viewer === account ? targetData.viewer : null;
  const targetHub = targetViewer ? targetData!.hub : null;
  const targetTier = targetViewer ? targetData!.tier : null;

  useWatchEffect(() => {
    if (!available || !validId || !client || !account || !enabled) return;
    const isPresence = channel === "presence";
    if (targetError || targetNull) {
      const store = useInboxStore.getState();
      if (isPresence) {
        store.setRelayViewerStatus(validId, account, "", "unknown");
      } else {
        store.applyRelayTokenDeltaStatus(validId, "disabled");
      }
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
      const sharedEntry: SharedViewerSubscription = {
        presenceCount: isPresence ? 1 : 0,
        tokenDeltasCount: isPresence ? 0 : 1,
        unsubscribe: () => {},
      };
      shared = sharedEntry;
      map.set(subKey, sharedEntry);
      if (isPresence) {
        useInboxStore
          .getState()
          .setRelayViewerStatus(validId, targetViewer, targetHub, "connecting");
      }
      try {
        sharedEntry.unsubscribe = client.subscribe(
          targetHub,
          (event) => {
            const store = useInboxStore.getState();
            if (
              event.type === "signal" &&
              event.signal.type === "token_delta"
            ) {
              if (sharedEntry.tokenDeltasCount > 0) {
                store.applyRelayTokenDeltaSignal(validId, event.signal);
              }
              return;
            }
            if (sharedEntry.presenceCount > 0) {
              store.applyRelayViewerEvent(
                validId,
                targetViewer,
                targetHub,
                event,
                Date.now(),
              );
            }
          },
          (status) => {
            const store = useInboxStore.getState();
            if (sharedEntry.presenceCount > 0) {
              store.setRelayViewerStatus(
                validId,
                targetViewer,
                targetHub,
                status === "unavailable" ? "unknown" : status,
              );
            }
            if (sharedEntry.tokenDeltasCount > 0) {
              store.applyRelayTokenDeltaStatus(validId, status);
            }
          },
          { batchKey: targetTier, terminalUnavailable: true },
        );
      } catch {
        const store = useInboxStore.getState();
        if (sharedEntry.presenceCount > 0) {
          store.setRelayViewerStatus(
            validId,
            targetViewer,
            targetHub,
            "unknown",
          );
        }
        if (sharedEntry.tokenDeltasCount > 0) {
          store.applyRelayTokenDeltaStatus(validId, "unavailable");
        }
      }
    } else if (isPresence) {
      shared.presenceCount += 1;
      if (shared.presenceCount === 1) {
        const currentStatus = client.status(targetHub) ?? "connecting";
        useInboxStore
          .getState()
          .setRelayViewerStatus(
            validId,
            targetViewer,
            targetHub,
            currentStatus === "unavailable" ? "unknown" : currentStatus,
          );
      }
    } else {
      shared.tokenDeltasCount += 1;
    }

    return () => {
      if (isPresence) {
        shared.presenceCount -= 1;
        if (shared.presenceCount === 0) {
          const store = useInboxStore.getState();
          const current = store.relayViewerPresence[validId];
          if (
            current &&
            current.viewer === targetViewer &&
            current.hub === targetHub
          ) {
            store.clearRelayViewerPresence(validId);
          }
        }
      } else {
        shared.tokenDeltasCount -= 1;
        if (shared.tokenDeltasCount === 0) {
          useInboxStore
            .getState()
            .applyRelayTokenDeltaStatus(validId, "disabled");
        }
      }
      if (shared.presenceCount + shared.tokenDeltasCount > 0) return;
      map.delete(subKey);
      shared.unsubscribe();
    };
  }, [
    channel,
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
