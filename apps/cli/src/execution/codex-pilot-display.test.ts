import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderAdapter } from "@codecast/provider-adapter";
import { fake, until } from "../../../../tests/codex-driver-parity/peers.js";
import {
  input,
  normalizeId,
  recordedCompletion,
  recordedItems,
} from "../../../../tests/codex-driver-parity/recording.js";
import { CodexAppServer } from "../codexAppServer.js";
import { inlineImageMarker } from "../inlineImage.js";
import type { ParsedMessage } from "../parser.js";
import { registerAppServerSpawnTracking, tmuxSpawns } from "../tmuxSpawns.js";
import {
  CodexPilotDisplay,
  type CodexPilotDisplayEffect,
} from "./codex-pilot-display.js";

function trace() {
  return {
    status: [] as Array<[string, string[]]>,
    names: [] as string[],
    spawns: [] as string[],
    messages: [] as ParsedMessage[],
    errors: [] as string[],
  };
}

function collect(
  output: ReturnType<typeof trace>,
  effect: CodexPilotDisplayEffect,
) {
  switch (effect.type) {
    case "statusChanged":
      output.status.push([effect.status.type, effect.status.activeFlags ?? []]);
      break;
    case "threadNameUpdated":
      output.names.push(effect.name);
      break;
    case "itemStarted":
      output.spawns.push(
        ...tmuxSpawns([effect.message]).map(({ name }) => name),
      );
      break;
    case "error":
      output.errors.push(effect.message);
      break;
    case "messages":
      output.messages.push(...effect.messages);
      break;
  }
}

const file = "/tmp/owned-pilot-output.webp";

function startFrames(threadId: string, turnId: string) {
  return [
    {
      method: "thread/status/changed",
      params: {
        threadId,
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
      },
    },
    {
      method: "thread/name/updated",
      params: { threadId, threadName: "Recorded title" },
    },
    {
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: {
          id: "spawn-command",
          type: "commandExecution",
          command: "tmux new-session -s bridge-worker",
          status: "inProgress",
        },
      },
    },
  ];
}

function completedFrames(threadId: string, turnId: string) {
  const additional = [
    {
      id: "spawn-command",
      type: "commandExecution",
      command: "tmux new-session -s bridge-worker",
      status: "completed",
      aggregatedOutput: `Ready\n${inlineImageMarker(file)}`,
    },
    {
      id: "mcp",
      type: "mcpToolCall",
      server: "docs",
      tool: "read",
      status: "completed",
      arguments: { path: "/work/summary" },
      result: { content: [{ type: "text", text: "Summary" }] },
    },
    {
      id: "change",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "notes.txt", diff: "New note\n", kind: { type: "add" } },
      ],
    },
    { id: "image", type: "imageView", path: "/tmp/viewed.png" },
  ];
  const completion = recordedCompletion(threadId, turnId, "failed");
  return [
    ...recordedItems(threadId, turnId),
    ...additional.map((item) => ({
      method: "item/completed",
      params: { threadId, turnId, item },
    })),
    {
      ...completion,
      params: {
        ...completion.params,
        turn: {
          ...completion.params.turn,
          error: {
            code: "context_window_exceeded",
            message: "The context is full",
          },
        },
      },
    },
  ];
}

function normalize(messages: ParsedMessage[]) {
  return messages.map(({ uuid, timestamp: _, model: _model, ...message }) => ({
    ...message,
    uuid:
      uuid &&
      normalizeId(
        uuid.replace(/codex-turn-error-(legacy|adapter)-/, "codex-turn-error-"),
      ),
    toolCalls: message.toolCalls?.map((call) => ({
      ...call,
      id: normalizeId(call.id),
    })),
    toolResults: message.toolResults?.map((result) => ({
      ...result,
      toolUseId: normalizeId(result.toolUseId),
    })),
  }));
}

test("the owned display matches the recorded legacy status, title, spawn, banner, images, MCP and diffs", async () => {
  const legacyDirectory = mkdtempSync(join(tmpdir(), "pilot-display-legacy-"));
  const ownedDirectory = mkdtempSync(join(tmpdir(), "pilot-display-owned-"));
  const legacyWire = fake(legacyDirectory, "legacy");
  const ownedWire = fake(ownedDirectory, "adapter");
  const legacy = new CodexAppServer({
    log: () => {},
    codexBinary: legacyWire.executable,
  });
  const display = new CodexPilotDisplay();
  const adapter = createProviderAdapter({
    provider: { agent: "codex", version: "0.153.4" },
    command: [ownedWire.executable],
    retainRaw: (frame) => display.retain(frame),
  });
  const previous = trace();
  const owned = trace();
  let reader: Promise<void> | undefined;
  try {
    legacy.start();
    await until(() => legacy.running, "legacy initializes");
    const legacyThread = (await legacy.threadStart({ cwd: legacyDirectory }))
      .thread.id;
    legacy.on("statusChanged", (_thread, status) =>
      collect(previous, { type: "statusChanged", status }),
    );
    legacy.on("threadNameUpdated", (_thread, name) =>
      collect(previous, { type: "threadNameUpdated", name }),
    );
    legacy.on("turnStarted", () =>
      collect(previous, { type: "statusChanged", status: { type: "active" } }),
    );
    registerAppServerSpawnTracking(
      legacy,
      () => "display",
      async (messages) => {
        for (const message of messages)
          collect(previous, { type: "itemStarted", message });
      },
      (error) => {
        throw error;
      },
    );
    const legacyDone = once(legacy, "turnCompleted");
    const legacyTurn = (
      await legacy.turnStart({
        threadId: legacyThread,
        input: [{ type: "text", text: input }],
      })
    ).turn.id;

    const result = await adapter.start({
      session: "display",
      run: 1,
      afterSeq: 0,
      fencing_token: "display-fence",
      cwd: ownedDirectory,
    });
    if (result.status !== "opened") throw new Error(JSON.stringify(result));
    const session = result.session;
    const ownedThread = session.getCheckpoint();
    reader = (async () => {
      for await (const event of session.events)
        if (event.kind !== "message.delta") {
          await display.publish(ownedThread, event, (effect) =>
            collect(owned, effect),
          );
        }
    })();
    await session.steer({
      expected: { run: 1, turn: null, fencing_token: "display-fence" },
      delivery_id: "delivery",
      authors: [],
      input: [{ type: "text", text: input }],
    });
    const ownedTurn = ownedWire.turn(1);

    for (const [server, thread, turn] of [
      [legacyWire, legacyThread, legacyTurn],
      [ownedWire, ownedThread, ownedTurn],
    ] as const) {
      server.send({ frames: startFrames(thread, turn) });
    }
    await until(
      () => previous.spawns.length === 1 && owned.spawns.length === 1,
      "both spawn trackers see the tool start before it completes",
    );
    for (const [server, thread, turn] of [
      [legacyWire, legacyThread, legacyTurn],
      [ownedWire, ownedThread, ownedTurn],
    ] as const) {
      server.send({ frames: completedFrames(thread, turn) });
    }
    const [, , messages, status, error] = await legacyDone;
    previous.messages.push(...messages);
    collect(previous, {
      type: "statusChanged",
      status: { type: status === "completed" ? "idle" : "systemError" },
    });
    if (status === "failed")
      collect(previous, { type: "error", message: error.message });
    await until(
      () => owned.messages.length > 0,
      "owned failed turn publishes messages and status",
    );

    expect(owned.status).toEqual(previous.status);
    expect(owned.names).toEqual(previous.names);
    expect(owned.spawns).toEqual(["bridge-worker"]);
    expect(normalize(owned.messages)).toEqual(normalize(previous.messages));
    expect(
      owned.messages
        .flatMap((message) => message.images ?? [])
        .map(({ localPath }) => localPath),
    ).toEqual([file, "/tmp/viewed.png"]);
    expect(
      owned.messages
        .flatMap((message) => message.toolCalls ?? [])
        .map(({ name }) => name),
    ).toContain("docs__read");
    expect(
      owned.messages
        .flatMap((message) => message.toolResults ?? [])
        .map(({ content }) => content),
    ).toContain("--- /dev/null\n+++ notes.txt\n@@ -0,0 +1,1 @@\n+New note");
    expect(owned.errors).toEqual(previous.errors);
    expect(owned.messages.at(-1)?.content).toContain("The context is full");
  } finally {
    legacy.stop();
    await adapter.dispose();
    await reader;
    rmSync(legacyDirectory, { recursive: true, force: true });
    rmSync(ownedDirectory, { recursive: true, force: true });
  }
});
