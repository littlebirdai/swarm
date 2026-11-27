import type {
  createRelayClient,
  RelayHandler,
  RelayHubStatus,
} from "@codecast/relay-client";
import { createContext } from "react";

export type RelayPresenceClient = {
  inboxViewer?: string;
  viewerAccount?: string;
  subscribe(
    sessionId: string,
    handler: RelayHandler,
    onStatus?: (status: RelayHubStatus) => void,
  ): () => void;
  status(sessionId: string): RelayHubStatus | undefined;
  retainViewerFeed?: (
    conversationId: string,
    onRelease: () => void,
  ) => () => void;
  publish: ReturnType<typeof createRelayClient>["publish"];
};

export const RelayPresenceContext = createContext<RelayPresenceClient | null>(
  null,
);
