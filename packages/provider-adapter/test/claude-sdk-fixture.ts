import {
  commands,
  fixtureAdapter,
  readWrites,
  fixtureHooks,
  ownedCase,
  interceptInput,
  writeGate,
  type Intercept,
} from "./provider-fixture";
import { expect } from "bun:test";
import type { ProviderOwnedSession } from "../src";
import { mkdtempSync, readFileSync } from "node:fs";
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

const executable = join(import.meta.dir, "fake-claude-sdk.ts");
const hooks = fixtureHooks(executable);
export const installClaudeFixtureHooks = hooks.install;

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
  let session: ProviderOwnedSession | undefined;
  let intercept: Intercept | undefined;
  const command = commands(directory);
  const send = (entry: object) => {
    void command(entry, false);
  };
  const gate = writeGate('"request_id":"hold-write"', () =>
    send({
      frames: [
        {
          type: "control_request",
          request_id: "hold-write",
          request: { subtype: "fixture-gate" },
        },
      ],
    }),
  );
  const options = {
    provider,
    command: [process.execPath, executable, directory] as const,
    env,
    onStderr() {
      if (env.FIXTURE_STDERR_FAILURE)
        throw new Error("fixture stderr callback");
    },
    retainRaw(frame: RawProviderFrame) {
      if (frame.line === "fixture defect" && fault) throw fault;
      raw.push(frame);
      if (frame.line.includes('"model":"full"')) blocked.resolve();
    },
  };
  const client = createProviderAdapter(options);
  const spec = { ...scope, ...fence, cwd: directory };
  const observed = () => readWrites<Write>(writesPath);
  const processFixture = hooks.attach(
    directory,
    async () => {
      gate.release();
      await client.dispose();
    },
    !!env.FIXTURE_DENY_KILL,
  );
  processFixture.spawn((child) =>
    interceptInput(child, (data, write) =>
      gate.intercept(data, write, intercept),
    ),
  );

  async function retained(needle: string) {
    expect(
      await waitFor(
        () => raw.some(({ line }) => line.includes(needle)),
        2500,
        5,
      ),
    ).toBe(true);
  }

  const eventFrame = (index: number, gen = generation) => ({
    type: "system",
    subtype: "init",
    uuid: `event-${gen}-${index}`,
    model: index === buffer ? "full" : `model-${index}`,
  });
  const contract: ProviderFixture = {
    adapter: fixtureAdapter(
      client,
      gate,
      () => observed().length,
      ["steer", "answer"],
      (opened) => {
        session = opened;
        running = true;
        generation++;
        started = false;
      },
      () => {
        running = false;
      },
    ),
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
    async advanceCheckpoint() {
      const checkpoint = crypto.randomUUID();
      send({
        frames: [
          runningFrame,
          { type: "conversation_reset", uuid: "fixture-reset" },
          { ...eventFrame(10), session_id: checkpoint },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: checkpoint,
            uuid: "fixture-reset-result",
          },
        ],
      });
      expect(
        await waitFor(() => session?.getCheckpoint() === checkpoint, 2500, 5),
      ).toBe(true);
      return checkpoint;
    },
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
    failClose: processFixture.failClose,
    pauseBeforeWrite: gate.pause,
    effects: () =>
      observed().map(({ type }): ProviderEffect =>
        type === "user"
          ? "steer"
          : type === "control_request"
            ? "interrupt"
            : "answer",
      ),
    releases: processFixture.releases,
  };

  return {
    client,
    contract,
    spec,
    send,
    frames: (...frames: object[]) => send({ frames }),
    disposition: (needle: string) =>
      raw.find(({ line }) => line.includes(needle))?.disposition,
    raw,
    retained,
    observed,
    options,
    eventFrame,
    async wrote(count: number) {
      expect(await waitFor(() => observed().length === count, 2500, 5)).toBe(
        true,
      );
    },
    interceptWrite: (write: Intercept) => {
      intercept = write;
    },
    sessionEnv: () =>
      JSON.parse(readFileSync(join(directory, "session-env"), "utf8")),
  };
}

export const claudeCase = ownedCase(fixture);
