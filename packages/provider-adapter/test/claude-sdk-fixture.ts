import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnswerRequest,
  InterruptRequest,
  SteerRequest,
} from "@codecast/provider-contract";
import type {
  ProviderEffect,
  ProviderFixture,
} from "@codecast/provider-contract/test";
import { waitFor } from "@codecast/test-helpers/waitFor";
import { createProviderAdapter, type RawProviderFrame } from "../src";

export const scope = { session: "claude-fixture", run: 1, afterSeq: 10 };
export const fence = { run: scope.run, fencing_token: "fixture-fence" };
export const person = { kind: "person", id: "owner" } as const;
export const steer: SteerRequest = {
  expected: { ...fence, turn: null },
  delivery_id: "fixture-delivery",
  authors: [person],
  input: [{ type: "text", text: "fixture input" }],
};
export const interrupt: InterruptRequest = {
  expected: { ...fence, turn: "claude-sdk:1:1" },
};
export const answer: AnswerRequest = {
  expected: { ...fence, prompt_id: "1:claude-sdk:approval" },
  by: person,
  answer: { option_id: "allow" },
};
export const provider = { agent: "claude", version: "2.1.319" };
export const noReceipt = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-receipt",
  message: "Claude SDK does not record delivery IDs",
} as const;
export const noAnswerAck = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-control-ack",
  message: "Claude SDK does not acknowledge the prompt reply",
} as const;

const realKill = process.kill.bind(process);
const denied = Object.assign(new Error("fixture kill denied"), {
  code: "EPERM",
});
const groups = new Map<number, { signals: number; fail: boolean }>();
const cleanups: (() => Promise<void>)[] = [];

export function installClaudeFixtureHooks() {
  beforeEach(() => {
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      const group = groups.get(-pid);
      if (group) {
        group.signals++;
        if (group.fail) throw denied;
      }
      return realKill(pid, signal);
    });
  });
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    } finally {
      groups.clear();
      (process.kill as ReturnType<typeof spyOn>).mockRestore();
    }
  });
}

export function requireOpened<T extends { status: string }>(
  result: T,
): Extract<T, { status: "opened" }> {
  if (result.status !== "opened") throw new Error(JSON.stringify(result));
  return result as Extract<T, { status: "opened" }>;
}

const buffer = 32;
export const runningFrame = {
  type: "system",
  subtype: "session_state_changed",
  state: "running",
  uuid: "fixture-running",
};
export const approval = {
  type: "control_request",
  request_id: "approval",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    input: { command: "pwd" },
  },
};
export const interruptReply = (request_id: string) => ({
  type: "control_response",
  response: { subtype: "success", request_id, response: { still_queued: [] } },
});

type Write = {
  type: string;
  uuid?: string;
  priority?: string;
  message?: { role: string; content: unknown };
  request_id?: string;
  response?: { request_id: string; response: object };
};

export function fixture(env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "adapter-claude-sdk-"));
  const raw: RawProviderFrame[] = [];
  const blocked = Promise.withResolvers<void>();
  const writesPath = join(directory, "writes");
  let generation = 0;
  let running = false;
  let started = false;
  let fault: Error | undefined;
  let group: { signals: number; fail: boolean } | undefined;
  let pid: number | undefined;
  let counter = 0;
  const options = {
    provider,
    command: [
      process.execPath,
      join(import.meta.dir, "fake-claude-sdk.ts"),
      directory,
    ] as const,
    env,
    retainRaw(frame: RawProviderFrame) {
      if (frame.line === "fixture defect" && fault) throw fault;
      raw.push(frame);
      if (frame.line.includes('"model":"full"')) blocked.resolve();
    },
  };
  const client = createProviderAdapter(options);
  const spec = { ...scope, ...fence, cwd: directory };
  const observed = (): Write[] =>
    existsSync(writesPath)
      ? readFileSync(writesPath, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  cleanups.push(async () => {
    await client.dispose();
    if (group?.fail && pid) realKill(-pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  });

  function send(command: object) {
    const index = String(++counter).padStart(6, "0");
    const temp = join(directory, `${index}.tmp`);
    writeFileSync(temp, JSON.stringify(command));
    renameSync(temp, join(directory, `${index}.command`));
  }

  async function retained(needle: string) {
    expect(
      await waitFor(
        () => raw.some(({ line }) => line.includes(needle)),
        2500,
        5,
      ),
    ).toBe(true);
  }

  function attach(result: Awaited<ReturnType<typeof client.start>>) {
    if (result.status !== "opened") return result;
    const owned = result.session;
    generation++;
    running = true;
    started = false;
    pid = Number(readFileSync(join(directory, "pid"), "utf8"));
    group = { signals: 0, fail: false };
    groups.set(pid, group);
    async function track<T extends { status: string }>(run: () => Promise<T>) {
      const previous = observed().length;
      const result = await run();
      if (result.status === "in-doubt")
        expect(await waitFor(() => observed().length > previous, 2500, 5)).toBe(
          true,
        );
      return result;
    }
    return {
      ...result,
      session: {
        ...owned,
        steer: (request: SteerRequest) => track(() => owned.steer(request)),
        answer: (request: AnswerRequest) => track(() => owned.answer(request)),
        close: () => {
          running = false;
          return owned.close();
        },
      },
    };
  }

  const eventFrame = (index: number, gen = generation) => ({
    type: "system",
    subtype: "init",
    uuid: `event-${gen}-${index}`,
    model: index === buffer ? "full" : `model-${index}`,
  });
  const contract: ProviderFixture = {
    adapter: {
      ...client,
      start: async (next) => attach(await client.start(next)),
      resume: async (next) => attach(await client.resume(next)),
    },
    mode: "own",
    scope,
    steer,
    interrupt,
    answer,
    orderedEvents: [
      {
        kind: "context",
        body: { data: { model: "model-0", permission_mode: null } },
      },
      {
        kind: "context",
        body: { data: { model: "model-1", permission_mode: null } },
      },
    ],
    nonReceiptDelivery: noReceipt,
    interruptOutcome: { status: "applied" },
    answerOutcome: noAnswerAck,
    bufferCapacity: buffer,
    backpressure: { kind: "block", wait: () => blocked.promise },
    open(next) {
      return this.adapter.start({ ...spec, ...next });
    },
    resumeSpec: (checkpoint) => ({ ...spec, run: 2, checkpoint }),
    async sendEvent(index) {
      if (!running) return;
      const frame = eventFrame(index);
      send({ frames: [frame] });
      await retained(frame.uuid);
      if (index === buffer)
        await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async atActiveTurn(run) {
      if (!started) {
        started = true;
        send({ frames: [runningFrame] });
        await retained(runningFrame.uuid);
      }
      return run();
    },
    async atPendingPrompt(run) {
      return this.atActiveTurn(async () => {
        send({ frames: [approval] });
        await retained('"request_id":"approval"');
        return run();
      });
    },
    async processExit() {
      send({ exit: 7 });
    },
    async streamDefect(error) {
      fault = error;
      send({ raw: "fixture defect" });
    },
    failClose() {
      if (!group) throw new Error("No fixture group");
      group.fail = true;
      return { status: "failed", code: "kill-failed", message: String(denied) };
    },
    effects: () =>
      observed().map(({ type }): ProviderEffect =>
        type === "user"
          ? "steer"
          : type === "control_request"
            ? "interrupt"
            : "answer",
      ),
    releases: () => group?.signals ?? 0,
  };

  return {
    client,
    contract,
    spec,
    send,
    raw,
    retained,
    observed,
    options,
    eventFrame,
    sessionEnv: () =>
      JSON.parse(readFileSync(join(directory, "session-env"), "utf8")),
  };
}
