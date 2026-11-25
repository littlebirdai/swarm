import { isValidBrowserStreamKey } from "@codecast/browser/browserStream";
import { deviceId } from "../remote/device.js";
import {
  getTerminalEndpoint,
  streamTerminalPane,
} from "../terminal/daemonBridge.js";
import { runWatchSession, defaultWatchDeps } from "../browser/watchServer.js";
import { startWatchRelay, type RelayAnswer } from "../browser/watchRelay.js";
import { type Config } from "../config/types.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleTerminalCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "hookListening"
    | "hookServerPort"
    | "log"
    | "observePaneInput"
    | "terminalToken"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  config: Config,
  commandArgs: string | undefined,
  siteUrl: string,
): Promise<void> {
  const { hookListening, log, observePaneInput, terminalToken } = daemon;
  switch (command) {
    case "get_terminal_endpoint": {
      await getTerminalEndpoint(
        daemon.hookServerPort,
        hookListening,
        terminalToken,
        log,
        (terminalResult, terminalError) => {
          commandOutcome.result = terminalResult;
          commandOutcome.error = terminalError;
        },
      );
      break;
    }
    case "stream_pane": {
      await streamTerminalPane(
        siteUrl,
        config,
        commandArgs,
        observePaneInput,
        log,
        (terminalResult, terminalError) => {
          commandOutcome.result = terminalResult;
          commandOutcome.error = terminalError;
        },
      );
      break;
    }
    case "stream_browser": {
      // A viewer on another machine wants to watch the browser tab a
      // session here drives. It can't reach the loopback watch socket, so
      // run the same watch session and publish it to the relay; the
      // viewer's lease stops it (apps/cli/src/browser/watchRelay.ts).
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      if (
        !isValidBrowserStreamKey(parsed.key) ||
        (parsed.session_uuid !== undefined &&
          !isValidBrowserStreamKey(parsed.session_uuid)) ||
        (parsed.tmux_session !== undefined &&
          !isValidBrowserStreamKey(parsed.tmux_session))
      ) {
        commandOutcome.error = `stream_browser: invalid args ${JSON.stringify(parsed)}`;
        break;
      }
      const started = startWatchRelay(
        {
          key: parsed.key,
          session_uuid: parsed.session_uuid,
          tmux_session: parsed.tmux_session,
        },
        {
          log,
          startSession: (opts, sink) =>
            runWatchSession(opts, sink, defaultWatchDeps()),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          push: async (msg) => {
            try {
              const res = await fetch(`${siteUrl}/cli/browser/frame`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  api_token: config.auth_token,
                  device_id: deviceId(),
                  ...msg,
                }),
              });
              if (!res.ok) return null;
              return (await res.json()) as RelayAnswer;
            } catch {
              return null;
            }
          },
        },
      );
      commandOutcome.result = JSON.stringify({
        key: parsed.key,
        streaming: true,
        already: !started,
      });
      log(
        `[BROWSER-RELAY] Streaming ${parsed.key} for a remote viewer${started ? "" : " (already running)"}`,
      );
      break;
    }
  }
}
