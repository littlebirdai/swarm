import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { isOlderBackendRefusal } from "./castApi.js";

type WatchArgs = {
  api_token: string;
  state?: string;
  show_all?: boolean;
  label?: string;
  project_path?: string;
  limit?: number;
  session_ids?: string[];
  watch?: boolean;
};

type WatchResult = { error?: string; sessions?: Record<string, unknown>[] };

const query = makeFunctionReference<"query", WatchArgs, WatchResult>(
  "conversations:inboxForCLI",
);

export function subscribeCliInboxWatch(
  client: Pick<ConvexClient, "onUpdate">,
  args: Omit<WatchArgs, "watch">,
  onSessions: (sessions: Record<string, unknown>[]) => void,
) {
  const onFrame = (result: WatchResult) => {
    if (result && !result.error) onSessions(result.sessions ?? []);
  };
  if (args.label || args.project_path) {
    client.onUpdate(query, args, onFrame);
    return;
  }
  const unsubscribe = client.onUpdate(
    query,
    { ...args, watch: true },
    onFrame,
    (error) => {
      if (!isOlderBackendRefusal(error, "watch")) {
        void Promise.reject(error);
        return;
      }
      unsubscribe();
      client.onUpdate(query, args, onFrame);
    },
  );
}
