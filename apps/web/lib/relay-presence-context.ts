import type {
  createRelayClient,
  RelayHandler,
  RelayHubStatus,
  RelayHubStatusMeta,
  RelaySubscribeOptions,
} from "@codecast/relay-client";
import { createContext } from "react";

export type RelayPresenceClient = {
  inboxViewer?: string;
  viewerAccount?: string;
  subscribe(
    sessionId: string,
    handler: RelayHandler,
    onStatus?: (status: RelayHubStatus, meta?: RelayHubStatusMeta) => void,
    options?: RelaySubscribeOptions,
  ): () => void;
  status(sessionId: string): RelayHubStatus | undefined;
  publish: ReturnType<typeof createRelayClient>["publish"];
};

export const RelayPresenceAvailableContext = createContext(false);

export const RelayPresenceContext = createContext<RelayPresenceClient | null>(
  null,
);
