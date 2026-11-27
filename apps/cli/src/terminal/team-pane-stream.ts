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
import { redactTeamScreen } from "./team-pane-redaction.js";

import { exactTypingTarget, WATCH_PANE_IDENTITY } from "./tmux-typing-pane.js";
import {
  observeClaimedTerminal,
  isTerminalOwnerId,
  type TerminalEnd,
} from "./terminal-lifecycle.js";
const MAX_PUSH_FAILURES = 6;

export async function captureTeamPane(target: string) {
  const exact = exactTypingTarget(target);
  if (!exact) return null;
  const pane = exact.paneTarget;
  const format = `${WATCH_PANE_IDENTITY}|#{window_index}.#{pane_index}`;
  const result = await tmuxRunAsync([
    "display-message",
    "-p",
    "-t",
    pane,
    "-F",
    format,
    ";",
    "capture-pane",
    "-p",
    "-J",
    "-t",
    pane,
    ";",
    "display-message",
    "-p",
    "-t",
    pane,
    "-F",
    format,
  ]);
  if (result.status !== 0) return null;
  const output = result.stdout.replace(/\n$/, "");
  const first = output.indexOf("\n");
  const last = output.lastIndexOf("\n");
  if (first < 0 || last <= first) return null;
  const stamp = output.slice(0, first);
  const separator = stamp.lastIndexOf("|");
  const identity = stamp.slice(0, separator);
  const [name, , , paneId, panePid, dead] = identity.split("|");
  if (
    stamp !== output.slice(last + 1) ||
    stamp.slice(separator + 1) !== `${exact.windowIndex}.${exact.paneIndex}` ||
    !paneId?.startsWith("%") ||
    !Number(panePid) ||
    dead !== "0" ||
    name !== exact.sessionName
  )
    return null;
  return { identity, text: output.slice(first + 1, last) };
}

type Frame = { pane_instance?: string; frame?: string };
type StreamDeps = {
  capture: (
    target: string,
  ) =>
    | ReturnType<typeof captureTeamPane>
    | Awaited<ReturnType<typeof captureTeamPane>>;
  redactionReady?: () => boolean;
  observePane?: (
    identity: string,
  ) => Promise<TerminalEnd | undefined> | undefined;
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
  let end: TerminalEnd | undefined;
  let outcome: Parameters<TerminalEnd>[0] = { kind: "lost" };
  try {
    for (;;) {
      if (deps.redactionReady?.() === false) return;
      const pane = await deps.capture(target);
      if (deps.redactionReady?.() === false) return;
      if (!pane || (paneInstance && pane.identity !== paneInstance)) {
        if (pane) outcome = { kind: "replaced" };
        await deps.push({});
        return;
      }
      paneInstance = pane.identity;
      if (!end)
        end = await deps.observePane?.(pane.identity)?.catch(() => undefined);
      const frame = redactTeamScreen(pane.text).slice(0, PANE_MAX_FRAME_BYTES);
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
  } finally {
    await end?.(outcome).catch(() => {});
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

  const conversation =
    "conversation_id" in args && typeof args.conversation_id === "string"
      ? args.conversation_id
      : undefined;
  const owner =
    "owner_id" in args && isTerminalOwnerId(args.owner_id)
      ? args.owner_id
      : undefined;
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
          observePane:
            conversation && owner
              ? (identity) =>
                  observeClaimedTerminal(conversation, identity, owner)
              : undefined,
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
