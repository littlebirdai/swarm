import {
  commands,
  fixtureAdapter,
  readWrites,
  fixtureHooks,
  ownedCase,
  interceptInput,
  writeGate,
} from "./provider-fixture";
import { expect, spyOn } from "bun:test";
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
import {
  createProviderAdapter,
  type ProviderOwnedSession,
  type RawProviderFrame,
} from "../src";

export const scope = { session: "fixture-session", run: 1, afterSeq: 10 };
export const threadId = "codex-fixture-thread";
export const turn = "actual-turn-1";
const expected = { run: scope.run, fencing_token: "fixture-fence" };
const author = { kind: "person", id: "owner" } as const;
export const steer: SteerRequest = {
  expected: { ...expected, turn: null },
  delivery_id: "delivery",
  authors: [author],
  input: [{ type: "text", text: "test message" }],
};
export const interrupt: InterruptRequest = { expected: { ...expected, turn } };
export const answer: AnswerRequest = {
  expected: { ...expected, prompt_id: "1:app-server:string:approval" },
  by: author,
  answer: { behavior: "allow" },
};
export const bestEffort = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-receipt",
  message: "Codex app-server does not record delivery IDs",
} as const;
export const answerOutcome = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-control-ack",
  message: "Codex app-server does not acknowledge the prompt reply",
} as const;
export const buffer = 32;
const executable = join(import.meta.dir, "fake-app-server.ts");
const hooks = fixtureHooks(executable);
export const installAppServerFixtureHooks = hooks.install;

type Notification = {
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
    item?: { type: string; id: string };
    [key: string]: unknown;
  };
};
const capture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../apps/cli/src/__fixtures__/codexCloud/turns.ask.json",
    ),
    "utf8",
  ),
);
export const recorded = findEvents(capture);

function findEvents(data: unknown): Notification[] {
  if (data === null || typeof data !== "object") return [];
  if ("thread_events" in data)
    return (data.thread_events as { events: Notification[] }).events;
  return Object.values(data).flatMap(findEvents);
}

const statuses = recorded.filter(
  (event) => event.method === "thread/status/changed",
);
export function approval(thread = threadId, active = turn, id = "approval") {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: thread,
      turnId: active,
      itemId: "tool-1",
      command: "pwd",
      reason: "Read current directory",
    },
  };
}

interface Observed {
  action: ProviderEffect | "rejected";
  message: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };
}

export function fixture(env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "adapter-app-server-"));
  const effectsPath = join(directory, "effects");
  const raw: RawProviderFrame[] = [];
  const blocked = Promise.withResolvers<void>();
  let fault: Error | undefined;
  let pipeFault: (() => void) | undefined;
  let running = false;
  let bootstrap = 0;
  let session: ProviderOwnedSession | undefined;
  const wrote = commands(directory);
  const gate = writeGate('"id":"hold-write"', () => {
    void wrote({ frame: { id: "hold-write", method: "fixture/hold" } }, false);
  });
  const options = {
    provider: { agent: "codex", version: "0.153.4" },
    command: [process.execPath, executable, directory] as const,
    env,
    onStderr(line: string) {
      if (line === "fixture stderr fault") throw new Error(line);
      if (line === "fixture stdout fault") pipeFault?.();
    },
    retainRaw(frame: RawProviderFrame) {
      raw.push(frame);
      if (frame.line.includes(`"fixtureBuffer":${buffer}`))
        setImmediate(blocked.resolve);
      if (fault && frame.line === "fixture defect") throw fault;
    },
  };
  const client = createProviderAdapter(options);
  const spec = { ...scope, ...expected, cwd: directory };
  const observed = () => readWrites<Observed>(effectsPath);
  const owned = hooks.attach(directory, async () => {
    gate.release();
    await client.dispose();
  });
  owned.spawn((child) => {
    if (
      env.FIXTURE_READ_FAILURE &&
      child.stdout &&
      typeof child.stdout === "object"
    ) {
      const getReader = child.stdout.getReader.bind(child.stdout);
      spyOn(child.stdout, "getReader").mockImplementation((() => {
        const reader = getReader();
        const read = reader.read.bind(reader);
        let failed = false;
        const failure = Promise.withResolvers<never>();
        void failure.promise.catch(() => {});
        pipeFault = () => {
          failed = true;
          failure.reject(new Error("fixture stdout fault"));
        };
        spyOn(reader, "read").mockImplementation(async () => {
          const result = await (failed
            ? failure.promise
            : Promise.race([read(), failure.promise]));
          return result.done
            ? { done: true as const, value: undefined }
            : result;
        });
        return reader;
      }) as typeof child.stdout.getReader);
    }
    interceptInput(child, gate.intercept);
  });

  const contract: ProviderFixture = {
    adapter: fixtureAdapter(
      client,
      gate,
      () => observed().length,
      ["answer"],
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
      {
        kind: "context",
        body: { data: { status: { activeFlags: [], type: "active" } } },
      },
      { kind: "context", body: { data: { status: { type: "idle" } } } },
    ],
    nonReceiptDelivery: bestEffort,
    interruptOutcome: { status: "applied" },
    answerOutcome,
    bufferCapacity: buffer,
    open(nextScope) {
      return this.adapter.start({ ...spec, ...nextScope });
    },
    resumeSpec: (checkpoint) => ({ ...spec, run: 2, checkpoint }),
    async sendEvent(index) {
      if (!running) return;
      const frame = statuses[index === 1 ? 1 : 0]!;
      await wrote({
        frame: {
          ...frame,
          params: {
            ...frame.params,
            threadId: session?.getCheckpoint(),
            fixtureBuffer: index,
          },
        },
      });
    },
    backpressure: { kind: "block", wait: () => blocked.promise },
    async atActiveTurn(run) {
      bootstrap++;
      expect(await session?.steer(steer)).toEqual(bestEffort);
      return run();
    },
    async atPendingPrompt(run) {
      if (bootstrap === 0) {
        bootstrap++;
        expect(await session?.steer(steer)).toEqual(bestEffort);
      }
      await wrote({ frame: approval(session?.getCheckpoint()) });
      return run();
    },
    pauseBeforeWrite: gate.pause,
    processExit: () => wrote({ exit: true }, false),
    streamDefect(error) {
      fault = error;
      return wrote({ raw: "fixture defect" }, false);
    },
    failClose: owned.failClose,
    effects() {
      let count = 0;
      return observed().flatMap(({ action }) =>
        action === "rejected" || (action === "steer" && count++ < bootstrap)
          ? []
          : [action],
      );
    },
    releases: owned.releases,
  };
  return {
    client,
    contract,
    directory,
    observed,
    options,
    raw,
    spec,
    wrote,
    full: blocked.promise,
  };
}

export const appServerCase = ownedCase(fixture);
