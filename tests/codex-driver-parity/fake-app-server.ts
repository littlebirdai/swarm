import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [, , directory, peer] = process.argv;
if (!directory || !peer) throw new Error("Missing fake server arguments");
const threadId = `${peer}-thread`;
const sandbox = { type: "readOnly", networkAccess: false };
let turnId: string | undefined;
let turns = 0;
let lateReply: object | undefined;

function send(frame: object) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const inbox = createInterface({ input: process.stdin });
inbox.on("close", () => process.exit());
inbox.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(join(directory, "wire"), line + "\n");
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "codex_cli_rs/0.153.4 (parity)" } });
      break;
    case "thread/start":
      send({
        id,
        result: { thread: { id: threadId, status: { type: "idle" } }, sandbox },
      });
      break;
    case "thread/resume": {
      turnId = `${peer}-turn-3`;
      send({
        id,
        result: {
          thread: {
            id: params.threadId,
            status: { type: "active", activeFlags: [] },
            turns: [
              { id: `${peer}-turn-1`, status: "interrupted" },
              { id: `${peer}-turn-2`, status: "completed" },
              { id: turnId, status: "inProgress" },
            ],
          },
          sandbox,
        },
      });
      break;
    }
    case "turn/start": {
      if (turnId) {
        send({ id, error: { code: -32000, message: "Turn already active" } });
        break;
      }
      turnId = `${peer}-turn-${++turns}`;
      const turn = { id: turnId, items: [], status: "inProgress" };
      send({ method: "turn/started", params: { threadId, turn } });
      const reply = { id, result: { turn } };
      if (turns === 2) lateReply = reply;
      else send(reply);
      break;
    }
    case "turn/steer":
      if (turnId && params.expectedTurnId === turnId) {
        send({ id, result: { turnId } });
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              id: "mid-user-item",
              type: "userMessage",
              content: params.input,
            },
          },
        });
      } else send({ id, error: { code: -32602, message: "Wrong turn" } });
      break;
    case "turn/interrupt":
      if (turnId && params.turnId === turnId) send({ id, result: {} });
      else send({ id, error: { code: -32602, message: "Wrong turn" } });
      break;
  }
});

const commandPath = join(directory, "command");
watch(directory, (_, file) => {
  if (file !== "command" || !existsSync(commandPath)) return;
  const command = JSON.parse(readFileSync(commandPath, "utf8"));
  unlinkSync(commandPath);
  for (const frame of command.frames ?? []) {
    send(frame);
    if (frame.method === "turn/completed") turnId = undefined;
  }
  if (command.releaseLate && lateReply) {
    send(lateReply);
    send(lateReply);
    lateReply = undefined;
  }
  if (command.marker) writeFileSync(join(directory, command.marker), "");
  if (command.exit) process.exit(0);
});
