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

const tmuxTarget = (target: string) =>
  target.includes(":") ? target : `${target}:0.0`;

export const physicalPaneKey = (pane: TypingPane) =>
  JSON.stringify([pane.socket, pane.serverPid, pane.paneId, pane.panePid]);

export async function resolveTypingPane(
  target: string,
): Promise<TypingPane | null> {
  if (!isValidPaneTarget(target) || target.startsWith("%")) return null;
  const result = await tmuxRunAsync([
    "display-message",
    "-p",
    "-t",
    tmuxTarget(target),
    "-F",
    `#{socket_path}\t${WATCH_PANE_IDENTITY}`,
  ]);
  const [socket, watchIdentity] = result.stdout.trimEnd().split("\t");
  if (
    result.status !== 0 ||
    !path.isAbsolute(socket ?? "") ||
    !watchIdentity ||
    watchIdentity.length > 256
  )
    return null;
  const [, , serverPid, paneId, panePid, dead] = watchIdentity.split("|");
  if (
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
  if (!isValidPaneTarget(target) || target.startsWith("%") || !bytes.length)
    return false;
  if (
    !/^%\d+$/.test(pane.paneId) ||
    !/^[1-9]\d*$/.test(pane.serverPid) ||
    !/^[1-9]\d*$/.test(pane.panePid)
  )
    return false;
  const checks = [
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
    tmuxTarget(target),
    condition,
    commands.join(" ; "),
  ]);
  return result.status === 0 && result.stdout.trim() === "typed";
}
