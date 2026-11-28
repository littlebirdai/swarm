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

type WatchResult = {
  error?: string;
  sessions?: Record<string, unknown>[];
  watch_truncation?: { shown: number; matching: number; windows: string[] };
};

const query = makeFunctionReference<"query", WatchArgs, WatchResult>(
  "cliInbox:inboxForCLI",
);

export function subscribeCliInboxWatch(
  client: Pick<ConvexClient, "onUpdate">,
  args: Omit<WatchArgs, "watch">,
  onSessions: (sessions: Record<string, unknown>[]) => void,
) {
  let warned = false;
  const onFrame = (result: WatchResult) => {
    if (!result || result.error) return;
    const truncated = result.watch_truncation;
    if (truncated && !warned) {
      const omitted = truncated.windows.length
        ? " Some watch windows also reached their limits."
        : "";
      const portion =
        truncated.shown < truncated.matching
          ? ` to ${truncated.shown} of ${truncated.matching} matching sessions`
          : "";
      process.stderr.write(
        `cast sessions: watch truncated${portion}.${omitted}\n`,
      );
    }
    warned = truncated !== undefined;
    onSessions(result.sessions ?? []);
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
