import {
  commands,
  fixtureAdapter,
  readWrites,
  fixtureHooks,
  originalKill,
  ownedCase,
  interceptInput,
  writeGate,
  type Intercept,
} from "./provider-fixture";
import { expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnswerRequest,
  InterruptRequest,
  ResumeSpec,
  SessionScope,
  SteerRequest,
} from "@codecast/provider-contract";
import {
  type ProviderEffect,
  type ProviderFixture,
} from "@codecast/provider-contract/test";
import { waitFor } from "@codecast/test-helpers/waitFor";
import {
  createProviderAdapter,
  type AcpOwnedSession,
  type RawProviderFrame,
} from "../src";

export const scope = { session: "session-1", run: 1, afterSeq: 10 };
const expected = { run: scope.run, fencing_token: "fixture-fence" };
export const author = { kind: "person", id: "owner" } as const;
export const steer: SteerRequest = {
  expected: { ...expected, turn: null },
  delivery_id: "delivery",
  authors: [author],
  input: [{ type: "text", text: "list the files here" }],
};
export const interrupt: InterruptRequest = {
  expected: { ...expected, turn: "1:1" },
};
export const answer: AnswerRequest = {
  expected: { ...expected, prompt_id: "1:permission:string:permission" },
  by: author,
  answer: { option_id: "allow" },
};
export const bestEffort = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-receipt",
  message: "ACP does not record delivery IDs",
} as const;
export const controlOutcome = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-control-ack",
  message: "ACP does not acknowledge this control write",
} as const;
export const bufferCapacity = 32;
const fixtureScript = join(import.meta.dir, "fake-acp.ts");
const hooks = fixtureHooks(fixtureScript);
export const installAcpFixtureHooks = hooks.install;

export const recorded = readFileSync(
  join(
    import.meta.dir,
    "../../../apps/cli/src/__fixtures__/grok/linear-tools.jsonl",
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

export function fixture(env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "adapter-acp-"));
  const effectsPath = join(directory, "effects");
  const command = [process.execPath, fixtureScript, directory] as const;
  const raw: RawProviderFrame[] = [];
  const stderr: string[] = [];
  let intercept: Intercept | undefined;
  const wrote = commands(directory);
  const gate = writeGate('"id":"fixture-write-gate"', () => {
    void wrote(
      { frame: { id: "fixture-write-gate", method: "fixture/hold-write" } },
      false,
    );
  });
  let fault: Error | undefined;
  const atBackpressure = Promise.withResolvers<void>();
  const options = {
    provider: { agent: "grok", version: "1.0.13" },
    command,
    env,
    onStderr(line: string) {
      stderr.push(line);
    },
    retainRaw(frame: RawProviderFrame) {
      raw.push(frame);
      if (frame.line.includes(`"fixtureBuffer":${bufferCapacity}`))
        setImmediate(atBackpressure.resolve);
      if (fault && frame.line === "fixture defect") throw fault;
    },
  };
  const client = createProviderAdapter(options);
  const spec = { ...scope, ...expected, cwd: directory };
  let session: AcpOwnedSession | undefined;
  let running = false;
  const owned = hooks.attach(directory, async () => {
    gate.release();
    await client.dispose();
  });
  owned.spawn((child) =>
    interceptInput(child, (data, write) =>
      gate.intercept(data, write, intercept),
    ),
  );

  const observed = () =>
    readWrites<{
      action: ProviderEffect;
      message: {
        id?: string;
        params?: { prompt?: unknown[] };
        result?: unknown;
      };
    }>(effectsPath);

  let bootstrap = 0;
  const contract: ProviderFixture = {
    adapter: fixtureAdapter(
      client,
      gate,
      () => observed().length,
      ["steer", "interrupt", "answer"],
      (opened) => {
        session = opened;
        running = true;
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
      { kind: "context", body: { data: { availableCommands: [] } } },
      {
        kind: "tool.call",
        body: {
          call_id: "call_synthbash01",
          name: "bash",
          input: { command: "ls" },
        },
      },
    ],
    nonReceiptDelivery: bestEffort,
    interruptOutcome: controlOutcome,
    answerOutcome: controlOutcome,
    bufferCapacity,
    open(nextScope: SessionScope) {
      return this.adapter.start({ ...spec, ...nextScope });
    },
    resumeSpec(checkpoint): ResumeSpec {
      return { ...spec, run: 2, checkpoint };
    },
    async sendEvent(index) {
      if (!running) return;
      const frame =
        index === 1
          ? recorded[5]
          : { method: "session/update", params: recorded[0] };
      await wrote({
        frame: {
          ...frame,
          params: {
            ...frame.params,
            sessionId: session?.getCheckpoint(),
            _meta: { fixtureBuffer: index },
          },
        },
      });
    },
    backpressure: { kind: "block", wait: () => atBackpressure.promise },
    async atActiveTurn(run) {
      bootstrap++;
      const before = observed().length;
      expect(await session?.steer(steer)).toEqual(bestEffort);
      expect(await waitFor(() => observed().length > before, 2500, 5)).toBe(
        true,
      );
      return run();
    },
    async atPendingPrompt(run) {
      await wrote({
        frame: {
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId: session?.getCheckpoint(),
            toolCall: { toolCallId: "tool", title: "Read files" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Remember", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        },
      });
      return run();
    },
    pauseBeforeWrite: gate.pause,
    async processExit() {
      await wrote({ exit: true }, false);
    },
    async streamDefect(error) {
      fault = error;
      await wrote({ raw: "fixture defect" }, false);
    },
    failClose: owned.failClose,
    effects() {
      let ignored = 0;
      return observed().flatMap(({ action }) =>
        action === "steer" && ignored++ < bootstrap ? [] : [action],
      );
    },
    releases: owned.releases,
  };
  return {
    client,
    spec,
    options,
    contract,
    raw,
    observed,
    wrote,
    directory,
    stderr,
    interceptWrite: (write: Intercept) => {
      intercept = write;
    },
  };
}

export function processStopped(pid: number) {
  try {
    originalKill(pid, 0);
    return (
      process.platform === "linux" &&
      /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    );
  } catch (error) {
    return (
      (error instanceof Error && "code" in error && error.code === "ESRCH") ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    );
  }
}

export const acpCase = ownedCase(fixture);
