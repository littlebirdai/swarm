import { spawn } from "node:child_process";
import {
  appendFileSync,
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

function reply(id: number | string, result: object = {}) {
  send({ id, result });
}

rpc.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params, result } = message;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: Number(process.env.ACP_PROTOCOL_VERSION ?? 1),
        agentInfo: { name: "fake", version: "1.0.13" },
        agentCapabilities: { loadSession: true },
      });
      break;
    case "session/new":
      writeFileSync(join(directory, "new-seen"), "");
      if (process.env.ACP_HOLD_NEW) break;
      if (process.env.ACP_EXIT_ON_NEW) process.exit(17);
      if (process.env.ACP_CHILD) {
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 60_000)"],
          { stdio: "ignore" },
        );
        writeFileSync(join(directory, "descendant"), String(descendant.pid));
      }
      reply(id, { sessionId });
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
      reply(id);
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
    if (command.complete && promptId !== undefined)
      reply(promptId, { stopReason: "end_turn" });
    if (command.frame) send(command.frame);
    if (command.raw) process.stdout.write(command.raw + "\n");
    if (command.barrier)
      send({ id: command.barrier, method: "fixture/barrier" });
  }
});
writeFileSync(join(directory, "pid"), String(process.pid));
