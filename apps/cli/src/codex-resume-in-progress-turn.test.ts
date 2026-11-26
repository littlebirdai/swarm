import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, until } from "../../../tests/codex-driver-parity/peers.js";
import { CodexAppServer } from "./codex-app-server.js";

test("streams and completes a resumed active turn without a turn-start notification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-resumed-turn-"));
  const appServer = fake(directory, "resume");
  const client = new CodexAppServer({
    log: () => {},
    codexBinary: appServer.executable,
  });
  try {
    client.start();
    await until(() => client.running, "Codex client ready");
    const { thread } = await client.threadResume({
      threadId: appServer.thread,
    });
    const turn = thread.turns?.find((entry) => entry.status === "inProgress");
    expect(turn?.id).toBe(appServer.turn(3));

    const item = {
      id: "assistant-item",
      type: "agentMessage",
      text: "Resumed answer",
    };
    const params = { threadId: thread.id, turnId: turn!.id, item };
    const started: unknown[] = [];
    client.on("itemStarted", (...event) => started.push(event));
    const completed = once(client, "turnCompleted");
    appServer.send({
      frames: [
        { method: "item/started", params },
        { method: "item/completed", params },
        {
          method: "turn/completed",
          params: {
            threadId: thread.id,
            turn: { ...turn, status: "completed" },
          },
        },
      ],
    });
    const [, , messages] = await completed;
    expect({ started, messages }).toEqual({
      started: [[thread.id, turn!.id, item]],
      messages: [
        expect.objectContaining({
          role: "assistant",
          content: "Resumed answer",
        }),
      ],
    });
  } finally {
    client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
