import {
  isValidPaneTarget,
  PANE_CAPTURE_INTERVAL_MS,
  PANE_HEARTBEAT_MS,
  PANE_MAX_FRAME_BYTES,
} from "@codecast/daemon/terminalStream";
import {
  refreshKnownVault,
  terminalRedactionReady,
} from "../known-value-redaction.js";
import { deviceId } from "../remote/device.js";
import { tmuxRunAsync } from "../tmux.js";
import { redactFrame } from "./pane-stream.js";

const PANE_IDENTITY =
  "#{session_name}|#{session_created}|#{pid}|#{pane_id}|#{pane_pid}|#{pane_dead}";
const MAX_PUSH_FAILURES = 6;

export async function captureTeamPane(target: string) {
  if (!isValidPaneTarget(target) || target.startsWith("%")) return null;
  const pane = target.includes(":") ? target : `${target}:0.0`;
  const result = await tmuxRunAsync([
    "display-message",
    "-p",
    "-t",
    pane,
    "-F",
    `${PANE_IDENTITY}|#{pane_width}`,
    ";",
    "capture-pane",
    "-p",
    "-N",
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
    name !== target.split(":")[0]
  )
    return null;
  return { identity, cols, text: output.slice(first + 1, last) };
}

type Frame = { pane_instance?: string; frame?: string };
type StreamDeps = {
  capture: (
    target: string,
  ) =>
    | ReturnType<typeof captureTeamPane>
    | Awaited<ReturnType<typeof captureTeamPane>>;
  redactionReady?: () => boolean;
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
    if (deps.redactionReady?.() === false) return;
    const pane = await deps.capture(target);
    if (deps.redactionReady?.() === false) return;
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
    !(
      "bind" in args ||
      ("stream_id" in args &&
        typeof args.stream_id === "string" &&
        "pane_instance" in args &&
        typeof args.pane_instance === "string")
    )
  )
    return false;

  const { target, share } = args;
  const post = async (
    path: string,
    payload: Frame & { stream_id?: string },
  ): Promise<unknown> => {
    try {
      const response = await fetch(`${siteUrl}/cli/terminal/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: token,
          device_id: deviceId(),
          share,
          ...payload,
        }),
        signal: AbortSignal.timeout(PANE_HEARTBEAT_MS),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  if ("bind" in args) {
    if (args.bind !== true) return false;
    const pane = await captureTeamPane(target);
    return (
      (await post("team-bind", { pane_instance: pane?.identity })) === true
    );
  }

  const { stream_id, pane_instance } = args as {
    stream_id: string;
    pane_instance: string;
  };
  if (active.has(stream_id)) return true;
  active.add(stream_id);
  void (async () => {
    try {
      if (!(await refreshKnownVault())) return;
      await streamTeamPane(
        target,
        {
          capture: captureTeamPane,
          redactionReady: terminalRedactionReady,
          now: Date.now,
          sleep: Bun.sleep,
          push: async (frame) => {
            const result = (await post("team-frame", {
              stream_id,
              ...frame,
            })) as { stop?: unknown } | null;
            return typeof result?.stop === "boolean" ? result.stop : null;
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
