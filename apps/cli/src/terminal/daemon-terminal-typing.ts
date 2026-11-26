import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { deviceId } from "../remote/device.js";
import {
  startTerminalTyping,
  type TerminalTypingTransport,
} from "./terminal-typing.js";
import { resolveTypingPane, writeTypingPane } from "./tmux-typing-pane.js";

type Credential = { api_token: string; device_id: string };
type ReportArgs = Parameters<TerminalTypingTransport["report"]>[0];
type PollArgs = Parameters<TerminalTypingTransport["poll"]>[0];

const reportPane = makeFunctionReference<
  "mutation",
  Credential & ReportArgs,
  Awaited<ReturnType<TerminalTypingTransport["report"]>>
>("terminalInput:cliReportPane");
const pollPane = makeFunctionReference<
  "mutation",
  Credential & PollArgs,
  Awaited<ReturnType<TerminalTypingTransport["poll"]>>
>("terminalInput:cliPoll");
const list = makeFunctionReference<
  "query",
  {
    api_token: string;
    terminal_typing: boolean;
  },
  {
    conversation_id?: string;
    tmux_session?: string;
    agent_started_at?: number;
  }[]
>("managedSessions:listManagedSessionsForDaemon");

export function startDaemonTerminalTyping(
  convexUrl: string,
  apiToken: string | undefined,
  observe: (target: string, bytes: ArrayLike<number>) => void,
) {
  if (process.env.CODECAST_TERMINAL_TYPING !== "1" || !apiToken) return;
  const fetchTyping = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(3500) }),
    { preconnect: fetch.preconnect },
  );
  const client = new ConvexHttpClient(convexUrl, {
    fetch: fetchTyping,
  });
  const credential = { api_token: apiToken, device_id: deviceId() };
  return startTerminalTyping(true, {
    async catalog() {
      const rows = await client.query(list, {
        api_token: apiToken,
        terminal_typing: true,
      });
      return rows.flatMap(
        ({ conversation_id, tmux_session, agent_started_at }) =>
          conversation_id &&
          tmux_session &&
          typeof agent_started_at === "number" &&
          Number.isFinite(agent_started_at)
            ? [{ conversation_id, tmux_session, agent_started_at }]
            : [],
      );
    },
    report: (args) =>
      client.mutation(
        reportPane,
        { ...credential, ...args },
        { skipQueue: true },
      ),
    poll: (args) =>
      client.mutation(
        pollPane,
        { ...credential, ...args },
        { skipQueue: true },
      ),
    resolve: resolveTypingPane,
    async write(target, pane, bytes) {
      const written = await writeTypingPane(target, pane, bytes);
      if (written) observe(target, bytes);
      return written;
    },
  });
}
