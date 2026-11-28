import { useContext, useMemo, useRef, useState } from "react";
import { useConversationIdentityRow } from "../../hooks/useLiveIdentityRow";
import { useSyncRelayTokenDeltas } from "../../hooks/use-sync-relay-viewer-presence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { RelayTokenDeltasAvailableContext } from "../../lib/relay-presence-context";
import { renderAssistantBody } from "../../lib/renderAssistantBody";
import { useInboxStore } from "../../store/inboxStore";
import {
  selectVisibleRelayTokenStreams,
  type RelayTokenStreamEntry,
} from "../../store/relay-token-deltas-slice";
import { AgentSpeaker } from "../identity/AgentSpeaker";
import { isProducingAgentStatus } from "../workingStatus";

export type RelayStreamingRepliesProps = {
  conversationId: string;
  messages: ReadonlyArray<{ message_uuid?: string; role?: string }>;
  agentStatus?: string | null;
};

function useThrottledByFrame(
  value: readonly RelayTokenStreamEntry[],
): readonly RelayTokenStreamEntry[] {
  const [rendered, setRendered] = useState(value);
  const latestRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useWatchEffect(() => {
    latestRef.current = value;
    if (value === rendered) return;
    if (value.length === 0) {
      if (
        frameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      setRendered(value);
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      setRendered(value);
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setRendered(latestRef.current);
    });
  }, [value, rendered]);

  useWatchEffect(() => {
    return () => {
      if (
        frameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  return value.length === 0 ? value : rendered;
}

function ActiveRelayStreamingReplies({
  conversationId,
  messages,
  agentStatus,
}: RelayStreamingRepliesProps) {
  useSyncRelayTokenDeltas(conversationId, true);

  const streamState = useInboxStore(
    (state) => state.relayTokenDeltas[conversationId],
  );
  const pruneRelayTokenStreams = useInboxStore(
    (state) => state.pruneRelayTokenStreams,
  );
  const applyRelayTokenDeltaStatus = useInboxStore(
    (state) => state.applyRelayTokenDeltaStatus,
  );
  const identityRow = useConversationIdentityRow(conversationId);

  const turnOpen = isProducingAgentStatus(agentStatus);
  const lastTurnStateRef = useRef({ conversationId, turnOpen });
  const [turnBaseline, setTurnBaseline] = useState<{
    key: string;
    uuids: ReadonlySet<string>;
  } | null>(null);

  const durableAssistantUuids = useMemo(() => {
    const set = new Set<string>();
    for (const msg of messages) {
      if (msg.message_uuid && msg.role !== "user") {
        set.add(msg.message_uuid);
      }
    }
    return set;
  }, [messages]);

  const currentTurnKey = streamState
    ? `${conversationId}\0${streamState.run}\0${streamState.activeTurn}`
    : null;

  const baselineUuids = useMemo(() => {
    if (currentTurnKey && turnBaseline?.key === currentTurnKey) {
      return turnBaseline.uuids;
    }
    return durableAssistantUuids;
  }, [currentTurnKey, turnBaseline, durableAssistantUuids]);

  useWatchEffect(() => {
    if (
      !turnOpen ||
      !currentTurnKey ||
      turnBaseline?.key === currentTurnKey ||
      !streamState ||
      streamState.order.length === 0
    )
      return;
    const seeded = new Set<string>();
    for (const id of durableAssistantUuids) {
      if (
        !streamState.order.some((k) => streamState.entries[k]?.messageId === id)
      ) {
        seeded.add(id);
      }
    }
    setTurnBaseline({ key: currentTurnKey, uuids: seeded });
  }, [
    turnOpen,
    currentTurnKey,
    turnBaseline,
    streamState,
    durableAssistantUuids,
  ]);

  useWatchEffect(() => {
    return () => {
      applyRelayTokenDeltaStatus(conversationId, "disabled");
    };
  }, [conversationId, applyRelayTokenDeltaStatus]);

  useWatchEffect(() => {
    const prev = lastTurnStateRef.current;
    const closedTransition =
      prev.conversationId === conversationId && prev.turnOpen && !turnOpen;
    lastTurnStateRef.current = { conversationId, turnOpen };
    if (!streamState) return;
    if (closedTransition) {
      setTurnBaseline(null);
      pruneRelayTokenStreams(
        conversationId,
        durableAssistantUuids,
        baselineUuids,
        true,
      );
      return;
    }
    pruneRelayTokenStreams(
      conversationId,
      durableAssistantUuids,
      baselineUuids,
      false,
    );
  }, [
    conversationId,
    durableAssistantUuids,
    baselineUuids,
    turnOpen,
    streamState,
    pruneRelayTokenStreams,
  ]);

  const entries = useMemo(
    () =>
      selectVisibleRelayTokenStreams(
        streamState,
        durableAssistantUuids,
        turnOpen,
        baselineUuids,
      ),
    [streamState, durableAssistantUuids, turnOpen, baselineUuids],
  );
  const renderedEntries = useThrottledByFrame(entries);

  if (!renderedEntries.length) return null;

  return (
    <div>
      {renderedEntries.map((entry) => (
        <div
          key={`${entry.run}:${entry.turn}:${entry.messageId}`}
          data-cc-message="assistant"
          data-testid="relay-streaming-reply"
          data-message-id={entry.messageId}
          className="group relative mb-6"
        >
          <div
            data-cc-message-who
            className="flex items-center gap-2 mb-2 mt-4"
          >
            <span className="flex items-center gap-2 cursor-default">
              <AgentSpeaker row={identityRow} />
            </span>
          </div>
          <div className="pl-8">
            <div
              data-cc-prose=""
              className="text-sol-text prose prose-invert prose-sm max-w-none break-words"
            >
              {renderAssistantBody(entry.text, true)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RelayStreamingReplies(props: RelayStreamingRepliesProps) {
  const tokenDeltasAvailable = useContext(RelayTokenDeltasAvailableContext);
  if (!tokenDeltasAvailable) return null;
  return <ActiveRelayStreamingReplies {...props} />;
}
