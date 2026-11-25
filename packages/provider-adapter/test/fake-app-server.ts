import {
  appendFileSync,
  closeSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[2]!;
let threadId = "codex-fixture-thread";
let turnId = "";
let turns = 0;
const held = new Map<string, number>();
const inbox = createInterface({ input: process.stdin });

function send(frame: object) {
  const line = JSON.stringify(frame) + "\n";
  if (process.env.FIXTURE_CLOSE_STDOUT) writeSync(1, line);
  else process.stdout.write(line);
}

function record(action: string, message: object) {
  appendFileSync(
    join(directory, "effects"),
    JSON.stringify({ action, message }) + "\n",
  );
}

function burst(method: string) {
  if (process.env.FIXTURE_BURST_METHOD !== method) return;
  for (
    let index = 0;
    index < Number(process.env.FIXTURE_BURST_COUNT ?? 35);
    index++
  ) {
    send({
      method: "thread/name/updated",
      params: { threadId, threadName: String(index) },
    });
  }
}

function largeFrames(count: number) {
  const payload = "x".repeat(6 * 1024 * 1024);
  for (let index = 0; index < count; index++)
    send({
      method: "thread/name/updated",
      params: { threadId, threadName: payload },
    });
}

inbox.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params, result, error } = message;
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          userAgent:
            process.env.FIXTURE_USER_AGENT ?? "codex_cli_rs/0.153.4 (fixture)",
        },
      });
      return;
    case "initialized":
      writeFileSync(join(directory, "initialized"), "");
      return;
    case "thread/start":
    case "thread/resume":
      if (method === "thread/resume") threadId = params.threadId;
      writeFileSync(join(directory, "thread-request"), JSON.stringify(message));
      send({
        id,
        result: {
          thread: {
            id: process.env.FIXTURE_WRONG_CHECKPOINT
              ? "wrong-thread"
              : threadId,
            status: { type: process.env.FIXTURE_ACTIVE ? "active" : "idle" },
            turns: [{ id: "historical-turn", status: "completed" }],
          },
          sandbox: { type: "readOnly", networkAccess: false },
        },
      });
      return;
    case "turn/start": {
      record("steer", message);
      if (process.env.FIXTURE_START_ERROR) {
        send({
          id,
          error: { code: -32000, message: process.env.FIXTURE_START_ERROR },
        });
        return;
      }
      const turn = {
        id: (turnId = `actual-turn-${++turns}`),
        status: process.env.FIXTURE_TERMINAL_START ? "completed" : "inProgress",
        items: [],
      };
      if (
        process.env.FIXTURE_HOLD_START ||
        (process.env.FIXTURE_HOLD_SECOND && turns === 2)
      ) {
        held.set(method, id);
        return;
      }
      if (process.env.FIXTURE_COMPLETED_REPLY && turns === 1) {
        send({
          id,
          result: {
            turn: { ...turn, id: "historical-turn", status: "completed" },
          },
        });
        return;
      }
      if (!process.env.FIXTURE_REPLY_ONLY)
        send({ method: "turn/started", params: { threadId, turn } });
      burst(method);
      if (process.env.FIXTURE_LARGE_START) largeFrames(6);
      send({ id, result: { turn } });
      return;
    }
    case "turn/steer":
      record("steer", message);
      if (
        process.env.FIXTURE_HOLD_ALL_STEERS ||
        (process.env.FIXTURE_HOLD_FIRST_STEER && !held.has(method))
      ) {
        held.set(method, id);
        return;
      }
      burst(method);
      if (params.expectedTurnId !== turnId)
        send({ id, error: { code: -32602, message: "Unexpected turn" } });
      else
        send({
          id,
          result: {
            turnId: process.env.FIXTURE_WRONG_STEER ? "wrong-turn" : turnId,
          },
        });
      return;
    case "turn/interrupt":
      record("interrupt", message);
      burst(method);
      send({ id, result: process.env.FIXTURE_INVALID_INTERRUPT ? null : {} });
      return;
  }
  if (typeof id === "string" && id.startsWith("barrier:")) {
    writeFileSync(join(directory, id), "");
  } else if (id === "hold-write" && error) {
    writeFileSync(join(directory, "hold-drained"), "");
  } else if (result) {
    record("answer", message);
  } else if (error) {
    record("rejected", message);
  }
});

watch(directory, () => {
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith(".command"))
    .sort()) {
    const path = join(directory, name);
    const command = JSON.parse(readFileSync(path, "utf8"));
    unlinkSync(path);
    if (command.exit) process.exit(0);
    if (command.closeStdout) closeSync(1);
    if (command.stderr) process.stderr.write(command.stderr + "\n");
    if (command.largeFrames) largeFrames(command.largeFrames);
    if (command.fill) {
      for (let index = 0; index <= 32; index++)
        send({
          method: "thread/name/updated",
          params: { threadId, threadName: String(index), fixtureBuffer: index },
        });
    }
    if (command.frame) send(command.frame);
    if (command.raw) process.stdout.write(command.raw + "\n");
    if (command.rejectStart) {
      const id = held.get("turn/start");
      send({ id, error: { code: -32000, message: "Delayed refusal" } });
    }
    if (command.rejectSteer) {
      send({
        id: held.get("turn/steer"),
        error: { code: -32000, message: "Delayed steer refusal" },
      });
    }
    if (command.ackStart) {
      send({
        id: held.get("turn/start"),
        result: { turn: { id: turnId, status: "inProgress", items: [] } },
      });
    }
    if (command.barrier)
      send({ id: command.barrier, method: "fixture/barrier" });
  }
});

writeFileSync(join(directory, "pid"), String(process.pid));
