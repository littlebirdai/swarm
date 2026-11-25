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
const checkpoint = process.argv
  .find((arg) => /^--(session-id|resume)=/u.test(arg))
  ?.split("=")[1];
if (!checkpoint) process.exit(2);

function send(frame: object) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function response(id: string, payload: object) {
  send({
    type: "control_response",
    response: { subtype: "success", request_id: id, response: payload },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (
    frame.type === "control_request" &&
    frame.request.subtype === "initialize"
  ) {
    response(frame.request_id, {
      claude_code_version: process.env.FIXTURE_CLAUDE_VERSION ?? "2.1.319",
    });
    return;
  }
  appendFileSync(join(directory, "writes"), line + "\n");
  if (
    frame.type === "control_request" &&
    frame.request.subtype === "interrupt" &&
    !process.env.FIXTURE_HOLD_INTERRUPTS
  ) {
    response(frame.request_id, { still_queued: [] });
  }
});

watch(directory, () => {
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".command"))
    .sort()) {
    const path = join(directory, file);
    const command = JSON.parse(readFileSync(path, "utf8"));
    unlinkSync(path);
    for (const frame of command.frames ?? [])
      send({ session_id: checkpoint, ...frame });
    if (command.raw) process.stdout.write(command.raw + "\n");
    if (command.exit)
      process.stdout.write("", () => process.exit(command.exit));
  }
});

writeFileSync(join(directory, "pid"), String(process.pid));
writeFileSync(
  join(directory, "session-env"),
  JSON.stringify({
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    persistence: process.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE,
    nested: process.env.CLAUDECODE,
    child: process.env.CLAUDE_CODE_CHILD_SESSION,
    parent: process.env.CLAUDE_CODE_SESSION_ID,
  }),
);
