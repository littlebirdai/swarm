import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapter, fake, legacy, until, type Trace } from "./peers";
import {
  input,
  labelText,
  midInput,
  question,
  recordedAssistantId,
  recordedCompletion,
  recordedItems,
  recordedToolId,
} from "./recording";

async function settled<T>(pending: Promise<T>, label: string) {
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await until(() => done, label);
  return pending;
}

async function replay(directory: string, path: "legacy" | "adapter") {
  const server = fake(directory, path);
  const trace: Trace = { api: [], events: [], reasoning: [], names: [] };
  const peer = (path === "legacy" ? legacy : adapter)(server, directory, trace);
  const raw =
    "raw" in peer ? (peer.raw as ReturnType<typeof adapter>["raw"]) : undefined;
  const phases: Record<string, { api: unknown[]; events: string[] }> = {};
  const threadId = server.thread;
  const turnId = server.turn(1);
  const nameFrame = (threadName: string) => ({
    method: "thread/name/updated",
    params: { threadId, threadName },
  });
  async function phase(label: string, frames: object[] = []) {
    server.send({ frames: [...frames, nameFrame(label)] });
    await until(() => trace.names.includes(label), label);
    phases[label] = {
      api: trace.api.splice(0),
      events: trace.events.splice(0),
    };
  }
  function approval(id: string) {
    return {
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: recordedToolId(turnId),
        command: "pwd",
      },
    };
  }
  async function prompt(
    frame: { id: string; method: string; params: object },
    answer: Parameters<typeof peer.answer>[1],
  ) {
    server.send({ frames: [frame] });
    trace.api.push([frame.id, await peer.answer(frame.id, answer)]);
    await until(
      () => server.wire().some(({ id, result }) => id === frame.id && !!result),
      `wire answer ${frame.id}`,
    );
    trace.api.push(server.wire().find(({ id }) => id === frame.id)!.result);
  }

  try {
    trace.api.push(await peer.start());
    await phase("start");
    trace.api.push(await peer.steer(input, "initial-delivery", null));
    await phase("idle-steer");

    trace.api.push(await peer.steer(midInput, "mid-delivery", turnId));
    await phase("mid-turn");

    await prompt(approval("allow"), { behavior: "allow" });
    await prompt(approval("deny"), { behavior: "deny" });
    await prompt(
      {
        ...approval("ask"),
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: recordedToolId(turnId),
          questions: [question],
        },
      },
      { answers: { question: { answers: ["Short"] } } },
    );
    await phase("prompts");

    const names = Array.from({ length: 36 }, (_, index) => `burst-${index}`);
    const unpause = peer.pause();
    server.send({ frames: names.map(nameFrame), marker: "burst-written" });
    try {
      await until(
        () => server.marked("burst-written"),
        "fake broadcasts burst before interrupt",
      );
      if (raw) {
        await until(
          () =>
            raw.filter(({ line }) => line.includes('"threadName":"burst-'))
              .length >= 33,
          "adapter projects 33 frames with the consumer paused",
        );
        expect(
          trace.names.filter((name) => name.startsWith("burst-")).length,
        ).toBeLessThanOrEqual(1);
      }
      trace.api.push(
        await settled(
          peer.interrupt(turnId),
          "interrupt settles before the reader resumes",
        ),
      );
    } finally {
      unpause();
    }
    await until(() => trace.names.includes(names.at(-1)!), "drain burst");
    expect(trace.names.filter((name) => name.startsWith("burst-"))).toEqual(
      names,
    );
    await phase("interrupt");
    await phase("recording", [
      {
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: recordedAssistantId(turnId),
          delta: "partial",
        },
      },
      ...recordedItems(threadId, turnId),
      {
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "reasoning",
            id: "reasoning-with-content",
            content: ["Inspect the result before replying."],
            summary: ["Check the result."],
          },
        },
      },
      recordedCompletion(threadId, turnId, "interrupted"),
    ]);

    const reasoning = trace.reasoning.join("\n");
    expect(
      reasoning.includes("Inspect the result before replying."),
      "reasoning content survives projection",
    ).toBe(true);

    const lateTurn = server.turn(2);
    const late = peer.steer("Reply after completion", "late-delivery", null);
    await until(
      () => trace.events.includes("turn-2 started"),
      "late turn starts",
    );
    server.send({
      frames: [
        recordedCompletion(threadId, lateTurn, "completed"),
        nameFrame("waiting-for-reply"),
      ],
    });
    await until(
      () => trace.names.includes("waiting-for-reply"),
      "completion precedes reply",
    );
    server.send({ releaseLate: true });
    trace.api.push(await settled(late, "late reply settles"));
    await phase("late-reply");

    trace.api.push(
      await peer.steer("Keep working after restart", "exit-delivery", null),
    );
    await phase("before-exit");
    server.send({ exit: true });
    await settled(peer.afterExit(), "exit settles");
    phases.exit = { api: trace.api.splice(0), events: trace.events.splice(0) };

    trace.api.push(await peer.resume());
    await phase("resume");
    await phase("resumed-turn", [
      ...recordedItems(threadId, server.turn(3)),
      recordedCompletion(threadId, server.turn(3), "completed"),
    ]);
    expect(
      server.wire().filter(({ method }) => method === "turn/interrupt"),
    ).toEqual([expect.objectContaining({ params: { threadId, turnId } })]);
    expect(
      server.wire().filter(({ method }) => method === "thread/resume"),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ threadId }),
      }),
    ]);
    const methods = server.wire().flatMap(({ method }) => method ?? []);
    expect(methods.filter((method) => method.startsWith("turn/"))).toEqual([
      "turn/start",
      path === "legacy" ? "turn/start" : "turn/steer",
      "turn/interrupt",
      "turn/start",
      "turn/start",
    ]);
    expect(methods.filter((method) => method === "initialized")).toHaveLength(
      path === "legacy" ? 0 : 2,
    );
    if (raw) {
      expect(
        raw
          .filter(({ line }) => line.includes('"threadName":"burst-'))
          .map(({ line }) => JSON.parse(line).params.threadName),
      ).toEqual(names);
      const lateRequest = server
        .wire()
        .find(
          ({ method, params }) =>
            method === "turn/start" &&
            Array.isArray(params?.input) &&
            params.input[0]?.text === "Reply after completion",
        );
      expect(lateRequest?.id).toBeDefined();
      expect(
        raw
          .filter(({ line }) => JSON.parse(line).id === lateRequest?.id)
          .map(({ disposition }) => disposition),
      ).toEqual(["decoded", "unknown"]);
    }
    return { phases, reasoning };
  } finally {
    await peer.close();
  }
}

test("legacy Codex and the owned adapter replay one recorded turn schedule", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-driver-parity-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    mkdirSync(join(home, "legacy"));
    mkdirSync(join(home, "adapter"));
    const legacy = await replay(join(home, "legacy"), "legacy");
    const adapter = await replay(join(home, "adapter"), "adapter");
    const { phases: before } = legacy;
    const { phases: after } = adapter;
    expect(labelText(legacy.reasoning), "effective reasoning matches").toBe(
      labelText(adapter.reasoning),
    );
    expect(before.start).toEqual({ api: [["opened", "thread"]], events: [] });
    expect(before.interrupt).toEqual({ api: ["applied"], events: [] });
    const differences = Object.fromEntries(
      Object.entries(before).flatMap(([phase, legacy]) => {
        const adapter = after[phase];
        return Bun.deepEquals(legacy, adapter)
          ? []
          : [[phase, { legacy, adapter }]];
      }),
    );
    expect(Object.keys(before)).toEqual(Object.keys(after));
    expect(differences).toMatchSnapshot();
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
