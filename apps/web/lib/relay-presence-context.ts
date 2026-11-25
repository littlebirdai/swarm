import type { createRelayClient, RelayHandler } from "@codecast/relay-client";
import { createContext } from "react";

export type RelayPresenceClient = {
  subscribe(sessionId: string, handler: RelayHandler): () => void;
  publish: ReturnType<typeof createRelayClient>["publish"];
};

export const RelayPresenceContext = createContext<RelayPresenceClient | null>(
  null,
);
