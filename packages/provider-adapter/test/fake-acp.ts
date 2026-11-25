import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[2]!;
const rpc = createInterface({ input: process.stdin });
let sessionId = "fake-acp-session";
let promptId: number | undefined;

function send(message: object) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function record(action: string, message: object) {
  appendFileSync(
    join(directory, "effects"),
    JSON.stringify({ action, message }) + "\n",
  );
}

function reply(id: number | string, result: object | null = {}) {
  send({ id, result });
}

rpc.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params, result } = message;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: Number(process.env.ACP_PROTOCOL_VERSION ?? 1),
        _meta: { agentVersion: process.env.ACP_AGENT_VERSION ?? "1.0.13" },
        agentCapabilities: { loadSession: !process.env.ACP_LOAD_DISABLED },
      });
      break;
    case "session/new":
      writeFileSync(join(directory, "new-seen"), "");
      if (process.env.ACP_HOLD_NEW) break;
      if (process.env.ACP_EXIT_ON_NEW) process.exit(17);
      if (process.env.ACP_NEW_ERROR) {
        send({
          id,
          error: { code: -32000, message: process.env.ACP_NEW_ERROR },
        });
        break;
      }
      if (process.env.ACP_CHILD) {
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 60_000)"],
          { stdio: "ignore" },
        );
        writeFileSync(join(directory, "descendant"), String(descendant.pid));
      }
      reply(id, { sessionId });
      if (process.env.ACP_PAUSE_STDIN) {
        rpc.pause();
        process.stdin.pause();
      }
      if (process.env.ACP_CLOSE_STDIN) {
        rpc.close();
        closeSync(0);
        writeFileSync(join(directory, "stdin-closed"), "");
      }
      break;
    case "session/load":
      sessionId = params.sessionId;
      send({
        method: "session/update",
        params: {
          sessionId,
          _meta: { isReplay: true },
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
        },
      });
      for (
        let index = 0;
        index < Number(process.env.ACP_LOAD_BURST ?? 0);
        index++
      )
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [],
            },
          },
        });
      reply(id, null);
      break;
    case "session/prompt":
      promptId = id;
      record("steer", message);
      break;
    case "session/cancel":
      record("interrupt", message);
      if (promptId !== undefined) reply(promptId, { stopReason: "cancelled" });
      break;
    default:
      if (result?.outcome) record("answer", message);
      else if (id === "unknown-request")
        writeFileSync(
          join(directory, "unsupported-seen"),
          JSON.stringify(message.error),
        );
      else if (String(id).startsWith("barrier:"))
        writeFileSync(join(directory, String(id)), "");
  }
});

watch(directory, () => {
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".command"))
    .sort()) {
    const path = join(directory, file);
    const command = JSON.parse(readFileSync(path, "utf8"));
    unlinkSync(path);
    if (command.exit) process.exit(0);
    for (const frame of command.frames ?? []) send(frame);
    if (command.complete && promptId !== undefined)
      reply(
        promptId,
        command.complete === "malformed" ? {} : { stopReason: "end_turn" },
      );
    if (command.promptError && promptId !== undefined)
      send({
        id: promptId,
        error: { code: -32000, message: command.promptError },
      });
    if (command.stderr) process.stderr.write(command.stderr);
    if (command.frame) send(command.frame);
    if (command.raw) process.stdout.write(command.raw + "\n");
    if (command.barrier)
      send({ id: command.barrier, method: "fixture/barrier" });
    if (command.exitAfter) process.stdout.write("", () => process.exit(0));
  }
});
writeFileSync(join(directory, "pid"), String(process.pid));
