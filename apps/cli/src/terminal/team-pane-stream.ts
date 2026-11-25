import {
  isValidPaneTarget,
  PANE_CAPTURE_INTERVAL_MS,
  PANE_HEARTBEAT_MS,
  PANE_MAX_FRAME_BYTES,
} from "@codecast/daemon/terminalStream";
import { refreshKnownVault } from "../knownValueRedaction.js";
import { deviceId } from "../remote/device.js";
import { tmuxRun } from "../tmux.js";
import { redactFrame } from "./paneStream.js";

const PANE_IDENTITY =
  "#{session_name}|#{session_created}|#{pid}|#{pane_id}|#{pane_pid}|#{pane_dead}";
const MAX_PUSH_FAILURES = 6;

export function captureTeamPane(target: string) {
  if (!isValidPaneTarget(target)) return null;
  const pane =
    target.includes(":") || target.startsWith("%") ? target : `${target}:0.0`;
  const result = tmuxRun([
    "display-message",
    "-p",
    "-t",
    pane,
    "-F",
    `${PANE_IDENTITY}|#{pane_width}`,
    ";",
    "capture-pane",
    "-p",
    "-t",
    pane,
    ";",
    "display-message",
    "-p",
    "-t",
    pane,
    "-F",
    PANE_IDENTITY,
  ]);
  if (result.status !== 0) return null;
  const output = result.stdout.replace(/\n$/, "");
  const first = output.indexOf("\n");
  const last = output.lastIndexOf("\n");
  if (first < 0 || last <= first) return null;
  const header = output.slice(0, first);
  const identity = header.slice(0, header.lastIndexOf("|"));
  const cols = Number(header.slice(header.lastIndexOf("|") + 1));
  const [name, , , paneId, panePid, dead] = identity.split("|");
  if (
    identity !== output.slice(last + 1) ||
    !cols ||
    !paneId?.startsWith("%") ||
    !Number(panePid) ||
    dead !== "0" ||
    (!target.startsWith("%") && name !== target.split(":")[0])
  )
    return null;
  return { identity, cols, text: output.slice(first + 1, last) };
}

type Frame = { pane_instance?: string; frame?: string };
type StreamDeps = {
  capture: typeof captureTeamPane;
  push: (frame: Frame) => Promise<boolean | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export async function streamTeamPane(
  target: string,
  deps: StreamDeps,
  paneInstance?: string,
) {
  let lastFrame: string | undefined;
  let lastPushAt = 0;
  let failures = 0;
  for (;;) {
    const pane = deps.capture(target);
    if (!pane || (paneInstance && pane.identity !== paneInstance)) {
      await deps.push({});
      return;
    }
    paneInstance = pane.identity;
    const frame = redactFrame(pane.text, pane.cols).slice(
      0,
      PANE_MAX_FRAME_BYTES,
    );
    const changed = frame !== lastFrame;
    if (changed || deps.now() - lastPushAt >= PANE_HEARTBEAT_MS) {
      const stop = await deps.push({
        pane_instance: pane.identity,
        ...(changed ? { frame } : {}),
      });
      if (stop === true) return;
      if (stop === null) {
        if (++failures >= MAX_PUSH_FAILURES) return;
      } else {
        failures = 0;
        lastFrame = frame;
        lastPushAt = deps.now();
      }
    }
    await deps.sleep(PANE_CAPTURE_INTERVAL_MS);
  }
}

const active = new Set<string>();

export async function startTeamPaneStream(
  siteUrl: string,
  token: string | undefined,
  args: unknown,
): Promise<boolean> {
  if (
    !token ||
    !args ||
    typeof args !== "object" ||
    !("target" in args) ||
    typeof args.target !== "string" ||
    !isValidPaneTarget(args.target) ||
    !("share" in args) ||
    typeof args.share !== "string" ||
    !("stream_id" in args) ||
    typeof args.stream_id !== "string" ||
    ("pane_instance" in args && typeof args.pane_instance !== "string")
  )
    return false;
  const { target, share, stream_id, pane_instance } = args as {
    target: string;
    share: string;
    stream_id: string;
    pane_instance?: string;
  };
  if (active.has(stream_id)) return true;
  active.add(stream_id);
  void (async () => {
    try {
      await refreshKnownVault();
      await streamTeamPane(
        target,
        {
          capture: captureTeamPane,
          now: Date.now,
          sleep: Bun.sleep,
          push: async (frame) => {
            try {
              const response = await fetch(
                `${siteUrl}/cli/terminal/team-frame`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    api_token: token,
                    device_id: deviceId(),
                    share,
                    stream_id,
                    ...frame,
                  }),
                  signal: AbortSignal.timeout(PANE_HEARTBEAT_MS),
                },
              );
              if (!response.ok) return null;
              const result = (await response.json()) as { stop?: unknown };
              return typeof result.stop === "boolean" ? result.stop : null;
            } catch {
              return null;
            }
          },
        },
        pane_instance,
      );
    } finally {
      active.delete(stream_id);
    }
  })().catch(() => {});
  return true;
}
