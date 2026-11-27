import { api } from "@codecast/convex/convex/_generated/api";
import { useContext, useMemo } from "react";
import { teamMembersOf } from "../lib/activeTeam";
import { isConvexId } from "../lib/entityLinks";
import { relayPresenceUrl } from "../lib/relay-presence-config";
import { RelayPresenceContext } from "../lib/relay-presence-context";
import { useInboxStore } from "../store/inboxStore";
import { relayViewerUnknownIds } from "../store/relay-viewer-presence-slice";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

export function isRelayViewerPresenceConfigured(): boolean {
  return (
    relayPresenceUrl(
      import.meta.env.VITE_RELAY_PRESENCE,
      import.meta.env.VITE_RELAY_URL,
    ) !== null
  );
}

export function composeConversationId(docId: string): string | null {
  if (!docId.startsWith("compose:")) return null;
  const id = docId.slice("compose:".length);
  return isConvexId(id) ? id : null;
}

export function useRelayViewerTargetState(
  conversationId: string | null | undefined,
  enabled: boolean,
) {
  const client = useContext(RelayPresenceContext);
  const configured = isRelayViewerPresenceConfigured();
  const validId =
    conversationId && isConvexId(conversationId) ? conversationId : null;
  const account = client?.viewerAccount;
  const shouldQuery = Boolean(
    configured && enabled && client && account && validId,
  );

  const target = useQueryNoThrow(
    api.relayGrants.viewerTarget,
    shouldQuery && validId ? { conversation_id: validId } : "skip",
  );

  const activeTarget =
    enabled && client && account && validId && target.data?.viewer === account
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
    configured,
    client,
    account,
    validId,
    target,
    activeTarget,
    disabled:
      configured &&
      Boolean(client && account && validId && enabled) &&
      (Boolean(target.error) || target.data === null),
  };
}

export function useSubscribeRelayViewer(
  state: ReturnType<typeof useRelayViewerTargetState>,
  enabled: boolean,
) {
  const { client, account, validId, target } = state;

  useWatchEffect(() => {
    if (!validId || !client || !account || !enabled) return;
    const releaseFeed = client.retainViewerFeed?.(validId, () => {
      useInboxStore.getState().clearRelayViewerPresence(validId);
    });
    return () => {
      if (releaseFeed) releaseFeed();
      else useInboxStore.getState().clearRelayViewerPresence(validId);
    };
  }, [client, account, validId, enabled]);

  useWatchEffect(() => {
    if (!validId || !client || !account || !enabled) return;
    if (target.error || target.data === null) {
      useInboxStore
        .getState()
        .setRelayViewerStatus(validId, account, "", "disabled");
      return;
    }
    const info = target.data;
    if (!info || info.viewer !== account) return;
    const { viewer, hub } = info;
    const store = useInboxStore.getState();
    store.setRelayViewerStatus(validId, viewer, hub, "connecting");
    return client.subscribe(
      hub,
      (event) => {
        useInboxStore
          .getState()
          .applyRelayViewerEvent(validId, viewer, hub, event, Date.now());
      },
      (status) => {
        useInboxStore
          .getState()
          .setRelayViewerStatus(
            validId,
            viewer,
            hub,
            status === "unavailable" ? "unknown" : status,
          );
      },
    );
  }, [client, account, validId, enabled, target.data, target.error]);
}

export function useSyncRelayViewerPresence(
  conversationId: string | null | undefined,
  enabled: boolean,
) {
  const state = useRelayViewerTargetState(conversationId, enabled);
  useSubscribeRelayViewer(state, enabled);
  return {
    configured: state.configured,
    client: state.client,
    target: state.activeTarget,
    disabled: state.disabled,
  };
}
