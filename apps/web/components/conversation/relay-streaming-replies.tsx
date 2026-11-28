import { useContext, useMemo, useRef } from "react";
import { isProducingAgentStatus } from "../workingStatus";
import { useConversationIdentityRow } from "../../hooks/useLiveIdentityRow";
import { useSyncRelayTokenDeltas } from "../../hooks/use-sync-relay-viewer-presence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { RelayTokenDeltasAvailableContext } from "../../lib/relay-presence-context";
import { useInboxStore } from "../../store/inboxStore";
import { selectVisibleRelayTokenStreams } from "../../store/relay-token-deltas-slice";
import { AgentSpeaker } from "../identity/AgentSpeaker";
import { MessageMarkdown } from "./markdown";

export function RelayStreamingReplies({
  conversationId,
  messages,
  agentStatus,
}: {
  conversationId: string;
  messages: ReadonlyArray<{ message_uuid?: string }>;
  agentStatus?: string | null;
}) {
  const tokenDeltasAvailable = useContext(RelayTokenDeltasAvailableContext);
  useSyncRelayTokenDeltas(conversationId, tokenDeltasAvailable);

  const streamState = useInboxStore(
    (state) => state.relayTokenDeltas[conversationId],
  );
  const pruneRelayTokenStreams = useInboxStore(
    (state) => state.pruneRelayTokenStreams,
  );
  const identityRow = useConversationIdentityRow(conversationId);

  const turnOpen = isProducingAgentStatus(agentStatus);
  const wasTurnOpenRef = useRef(turnOpen);

  const durableMessageUuids = useMemo(() => {
    const set = new Set<string>();
    for (const msg of messages) {
      if (msg.message_uuid) set.add(msg.message_uuid);
    }
    return set;
  }, [messages]);

  useWatchEffect(() => {
    const closedTransition = wasTurnOpenRef.current && !turnOpen;
    wasTurnOpenRef.current = turnOpen;
    if (!tokenDeltasAvailable || !streamState) return;
    if (closedTransition) {
      pruneRelayTokenStreams(conversationId, durableMessageUuids, true);
      return;
    }
    pruneRelayTokenStreams(conversationId, durableMessageUuids, false);
  }, [
    tokenDeltasAvailable,
    conversationId,
    durableMessageUuids,
    turnOpen,
    streamState,
    pruneRelayTokenStreams,
  ]);

  const entries = useMemo(() => {
    if (!tokenDeltasAvailable) return [];
    return selectVisibleRelayTokenStreams(
      streamState,
      durableMessageUuids,
      turnOpen,
    );
  }, [tokenDeltasAvailable, streamState, durableMessageUuids, turnOpen]);

  if (!entries.length) return null;

  return (
    <div className="space-y-3 pb-2">
      {entries.map((entry) => (
        <div
          key={`${entry.run}:${entry.turn}:${entry.messageId}`}
          data-testid="relay-streaming-reply"
          data-message-id={entry.messageId}
          className="px-4 py-2"
        >
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <AgentSpeaker row={identityRow} />
          </div>
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <MessageMarkdown content={entry.text} />
          </div>
        </div>
      ))}
    </div>
  );
}
