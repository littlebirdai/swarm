import path from "node:path";
import {
  isValidPaneTarget,
  PANE_INPUT_CHUNK_BYTES,
} from "@codecast/daemon/terminalStream";
import { tmuxRunAsync } from "../tmux.js";

export const WATCH_PANE_IDENTITY =
  "#{session_name}|#{session_created}|#{pid}|#{pane_id}|#{pane_pid}|#{pane_dead}";

export type TypingPane = {
  socket: string;
  serverPid: string;
  paneId: string;
  panePid: string;
  watchIdentity: string;
};

export function exactTypingTarget(target: string) {
  if (!isValidPaneTarget(target)) return null;
  const match = /^([^:.@%][^:.]*)(?::(\d+)\.(\d+))?$/.exec(target);
  if (!match) return null;
  const [, sessionName, window = "0", pane = "0"] = match;
  const windowIndex = Number(window);
  const paneIndex = Number(pane);
  if (!Number.isSafeInteger(windowIndex) || !Number.isSafeInteger(paneIndex))
    return null;
  return {
    sessionName,
    windowIndex,
    paneIndex,
    paneTarget: `=${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

export const physicalPaneKey = (pane: TypingPane) =>
  JSON.stringify([pane.socket, pane.serverPid, pane.paneId, pane.panePid]);

export async function resolveTypingPane(
  target: string,
): Promise<TypingPane | null> {
  const exact = exactTypingTarget(target);
  if (!exact) return null;
  const result = await tmuxRunAsync([
    "display-message",
    "-p",
    "-t",
    exact.paneTarget,
    "-F",
    "#{socket_path}",
    ";",
    "display-message",
    "-p",
    "-t",
    exact.paneTarget,
    "-F",
    WATCH_PANE_IDENTITY,
    ";",
    "display-message",
    "-p",
    "-t",
    exact.paneTarget,
    "-F",
    "#{window_index}.#{pane_index}",
  ]);
  const lines = result.stdout.replace(/\n$/, "").split("\n");
  if (result.status !== 0 || lines.length !== 3) return null;
  const [socket, watchIdentity, indices] = lines;
  if (
    !path.isAbsolute(socket) ||
    watchIdentity.length > 256 ||
    indices !== `${exact.windowIndex}.${exact.paneIndex}`
  )
    return null;
  const [name, , serverPid, paneId, panePid, dead] = watchIdentity.split("|");
  if (
    name !== exact.sessionName ||
    dead !== "0" ||
    !/^%\d+$/.test(paneId) ||
    !/^[1-9]\d*$/.test(serverPid) ||
    !/^[1-9]\d*$/.test(panePid)
  )
    return null;
  return { socket, serverPid, paneId, panePid, watchIdentity };
}

export async function writeTypingPane(
  target: string,
  pane: TypingPane,
  bytes: readonly number[],
) {
  const exact = exactTypingTarget(target);
  if (!exact || !path.isAbsolute(pane.socket) || !bytes.length) return false;
  if (
    !/^%\d+$/.test(pane.paneId) ||
    !/^[1-9]\d*$/.test(pane.serverPid) ||
    !/^[1-9]\d*$/.test(pane.panePid)
  )
    return false;
  const checks = [
    `#{==:#{session_name},${exact.sessionName}}`,
    `#{==:#{window_index},${exact.windowIndex}}`,
    `#{==:#{pane_index},${exact.paneIndex}}`,
    `#{==:#{pid},${pane.serverPid}}`,
    `#{==:#{pane_id},${pane.paneId}}`,
    `#{==:#{pane_pid},${pane.panePid}}`,
    "#{==:#{pane_dead},0}",
  ];
  const condition = checks.reduce((a, b) => `#{&&:${a},${b}}`);
  const commands: string[] = [];
  for (let i = 0; i < bytes.length; i += PANE_INPUT_CHUNK_BYTES) {
    const hex = bytes
      .slice(i, i + PANE_INPUT_CHUNK_BYTES)
      .map((value) => (value & 0xff).toString(16).padStart(2, "0"));
    commands.push(`send-keys -t ${pane.paneId} -H ${hex.join(" ")}`);
  }
  commands.push("display-message -p typed");
  const result = await tmuxRunAsync([
    "-S",
    pane.socket,
    "if-shell",
    "-F",
    "-t",
    exact.paneTarget,
    condition,
    commands.join(" ; "),
  ]);
  return result.status === 0 && result.stdout.trim() === "typed";
}
