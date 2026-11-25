import { isValidPaneTarget } from "@codecast/daemon/terminalStream";
import {
  refreshKnownVault,
  terminalRedactionReady,
} from "../known-value-redaction.js";
import { deviceId } from "../remote/device.js";
import { isManagedTmuxName } from "../resumeCommand.js";
import { hasTmux } from "../tmux.js";
import { isPaneStreaming, startPaneStream, writePane } from "./pane-stream.js";
import { startTeamPaneStream } from "./team-pane-stream.js";
import { reapStaleTerminalSessions } from "./terminalServer.js";

type Log = (message: string) => void;
type TmuxExec = (args: string[]) => Promise<{ stdout: string }>;
type RecordOutcome = (result?: string, error?: string) => void;

export async function getTerminalEndpoint(
  hookServerPort: number,
  hookListening: Promise<number>,
  terminalToken: () => string,
  log: Log,
  recordOutcome: RecordOutcome,
): Promise<void> {
  // The web's integrated terminal asks every live daemon for its
  // loopback endpoint, then connects to whichever answers on 127.0.0.1
  // — only the machine the browser is physically on is reachable, so
  // multi-device resolution falls out for free.
  //
  // Never answer port 0. Asked before the listen resolves, wait for it:
  // an answer of 0 is one the web has to discard anyway, and a device
  // that stays silent is a case discover() already handles.
  const port =
    hookServerPort ||
    (await Promise.race([
      hookListening,
      new Promise<number>((r) => setTimeout(() => r(0), 5000)),
    ]));
  if (port === 0) {
    recordOutcome(undefined, "terminal endpoint not listening yet");
    log(`[REMOTE] Terminal endpoint requested before listen`);
    return;
  }
  recordOutcome(
    JSON.stringify({
      port,
      token: terminalToken(),
      device_id: deviceId(),
      tmux: hasTmux(),
    }),
  );
  log(`[REMOTE] Terminal endpoint requested (port ${port})`);
}

export async function streamTerminalPane(
  siteUrl: string,
  config: { auth_token?: string },
  commandArgs: string | undefined,
  observePaneInput: (target: string, bytes: ArrayLike<number>) => void,
  log: Log,
  recordOutcome: RecordOutcome,
): Promise<void> {
  // A browser on another machine wants to watch a pane here. It can't
  // reach the loopback PTY, so publish the pane's screen to the relay
  // instead, and take keystrokes back on the same request. It stops on
  // its own when the viewer's lease lapses; the lease is also what
  // authorizes input (apps/cli/src/terminal/pane-stream.ts).
  const parsed = commandArgs ? JSON.parse(commandArgs) : {};
  if (parsed && typeof parsed === "object" && "team_watch" in parsed) {
    const started = await startTeamPaneStream(
      siteUrl,
      config.auth_token,
      parsed.team_watch,
    );
    if (started) recordOutcome(JSON.stringify({ streaming: true }));
    else recordOutcome(undefined, "Invalid team terminal stream command");
    return;
  }
  const target = typeof parsed.target === "string" ? parsed.target : "";
  if (!isValidPaneTarget(target)) {
    recordOutcome(
      undefined,
      `stream_pane: invalid target ${JSON.stringify(parsed.target)}`,
    );
    return;
  }
  if (!hasTmux()) {
    recordOutcome(
      undefined,
      "stream_pane: tmux is not installed on this machine",
    );
    return;
  }
  const alreadyRunning = isPaneStreaming(target);
  // Frames go out through redactSecrets: take the Vault's current values
  // first, as a `cast vault` read does, so one stored a moment ago is in.
  if (!alreadyRunning && !(await refreshKnownVault())) {
    recordOutcome(undefined, "Terminal redaction unavailable");
    return;
  }
  startPaneStream(target, {
    log,
    redactionReady: terminalRedactionReady,
    write: (pane, bytes) => {
      if (writePane(pane, bytes)) observePaneInput(pane, bytes);
    },
    push: async (msg) => {
      try {
        const res = await fetch(`${siteUrl}/cli/terminal/frame`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            device_id: deviceId(),
            ...msg,
          }),
        });
        if (!res.ok) return null;
        return (await res.json()) as {
          stop: boolean;
          input?: string;
          fast?: boolean;
        };
      } catch {
        return null;
      }
    },
  });
  recordOutcome(
    JSON.stringify({
      target,
      streaming: true,
      already: alreadyRunning,
    }),
  );
  log(
    `[PANE] Streaming ${target} for a remote viewer${alreadyRunning ? " (already running)" : ""}`,
  );
}

export function startTerminalMaintenance(tmuxExec: TmuxExec, log: Log): void {
  // Reap idle panel terminals on boot and periodically (see terminalServer.ts).
  setTimeout(() => {
    void reapStaleTerminalSessions(log);
  }, 30_000).unref?.();
  const terminalReapTimer = setInterval(
    () => {
      void reapStaleTerminalSessions(log);
    },
    6 * 60 * 60 * 1000,
  );
  terminalReapTimer.unref?.();
  // Agent windows left squeezed by a viewer the previous daemon took down
  // with it (see healSqueezedAgentWindows).
  setTimeout(() => {
    void healSqueezedAgentWindows(tmuxExec, log);
  }, 15_000).unref?.();
  const squeezeHealTimer = setInterval(
    () => {
      void healSqueezedAgentWindows(tmuxExec, log);
    },
    5 * 60 * 1000,
  );
  squeezeHealTimer.unref?.();
}

// Detached tmux sessions default to 80x24, and Claude Code's teammate panes
// split that window until the lead pane is too narrow for its TUI to render
// recognizably (truncated footer markers, separators under the detection
// threshold, chip-list-only regions). Nobody is attached to daemon-owned
// sessions, so claim a real screen. An attached client re-imposes its own size.
export const TMUX_WINDOW_WIDTH = "220";
export const TMUX_WINDOW_HEIGHT = "50";
export const TMUX_SIZE_ARGS = [
  "-x",
  TMUX_WINDOW_WIDTH,
  "-y",
  TMUX_WINDOW_HEIGHT,
];
// When teammate panes split the 220-column window, give the lead pane 130 and
// leave 89 for the side stack — both sides stay above the 80-column TUI floor.
const TMUX_LEAD_PANE_WIDTH = "130";

// Self-heal for a lead pane under 80 columns — too narrow to render the markers
// the classifier needs (and mirrored at that width by the web terminal). Two
// distinct squeezes: a window that was never sized (created before the daemon
// sized its windows, or re-squeezed by a small attached client that detached),
// fixed by resize-window; and a window SPLIT by Claude Code's teammate panes,
// where resize-window is a no-op — the total is already right, only the pane
// tiling is wrong — so the lead pane must be widened directly. Returns the tmux
// commands to run (without target); empty when the pane is healthy.
//
// A window that is short rather than narrow is the web terminal split's
// signature: it sizes the pane to a few rows while open and hands the size
// back on detach — unless the daemon died under it. Nobody attached and the
// window at a fraction of its height means that hand-back was lost, so the
// window is put back. Only when nobody is attached: a live client (the split
// itself, a human's terminal) owns the size while it is there.
const TMUX_MIN_UNATTENDED_HEIGHT = 20;
export function planLeadPaneHeal(
  paneWidth: number,
  windowPanes: number,
  windowHeight = Infinity,
  sessionAttached = 0,
): string[][] {
  const narrow = !(paneWidth >= 80); // NaN (unparseable) counts as narrow, as before
  const short =
    windowHeight < TMUX_MIN_UNATTENDED_HEIGHT && sessionAttached === 0;
  if (!narrow && !short) return [];
  const cmds: string[][] = [
    ["resize-window", "-x", TMUX_WINDOW_WIDTH, "-y", TMUX_WINDOW_HEIGHT],
  ];
  if (narrow && windowPanes > 1)
    cmds.push(["resize-pane", "-x", TMUX_LEAD_PANE_WIDTH]);
  return cmds;
}

// Best-effort — classification proceeds either way.
export async function ensureTmuxPaneWide(
  target: string,
  tmuxExec: TmuxExec,
): Promise<void> {
  try {
    const { stdout } = await tmuxExec([
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_width}|#{window_panes}|#{window_height}|#{session_attached}",
    ]);
    const [paneWidth, windowPanes, windowHeight, sessionAttached] = stdout
      .trim()
      .split("|")
      .map((part) => parseInt(part, 10));
    const heals = planLeadPaneHeal(
      paneWidth,
      windowPanes,
      windowHeight,
      sessionAttached,
    );
    if (!heals.length) return;
    for (const [cmd, ...rest] of heals)
      await tmuxExec([cmd, "-t", target, ...rest]);
    // Give the TUI a beat to reflow before the first capture.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch {}
}

// Boot + periodic sweep over every managed agent window nobody is attached
// to. The per-target heal above only runs when a message is injected, so a
// pane left squeezed by a viewer that never handed the size back — the daemon
// died or restarted under it, and no in-band restore survives that — stays
// squeezed for as long as the agent goes without a message, painting a
// screen too small to render into (165x6 across a restart, 2026-08-21).
// Unattended only: a live client, web or human, owns the size while it is
// there and restores it when it leaves.
async function healSqueezedAgentWindows(
  tmuxExec: TmuxExec,
  log: Log,
): Promise<number> {
  if (!hasTmux()) return 0;
  let healed = 0;
  try {
    const { stdout } = await tmuxExec([
      "list-windows",
      "-a",
      "-F",
      "#{session_name}|#{session_attached}|#{pane_width}|#{window_panes}|#{window_height}",
    ]);
    for (const line of stdout.split("\n")) {
      const [name, attached, paneWidth, windowPanes, windowHeight] =
        line.split("|");
      if (!name || !isManagedTmuxName(name)) continue;
      if ((parseInt(attached ?? "", 10) || 0) > 0) continue;
      const heals = planLeadPaneHeal(
        parseInt(paneWidth ?? "", 10),
        parseInt(windowPanes ?? "", 10) || 1,
        parseInt(windowHeight ?? "", 10),
        0,
      );
      if (!heals.length) continue;
      for (const [cmd, ...rest] of heals)
        await tmuxExec([cmd, "-t", name, ...rest]);
      healed++;
      log(
        `[TERM] healed squeezed agent window ${name} (was ${paneWidth}x${windowHeight}, nobody attached)`,
      );
    }
  } catch {}
  return healed;
}
