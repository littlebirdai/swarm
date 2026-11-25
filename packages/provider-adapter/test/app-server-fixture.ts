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
const originalKill = process.kill.bind(process);
const originalSpawn = Bun.spawn;
const denied = Object.assign(new Error("fixture kill denied"), {
  code: "EPERM",
});
const cleanups: (() => Promise<void>)[] = [];
const spawnInterceptors = new Map<
  string,
  (child: ReturnType<typeof Bun.spawn>) => void
>();
const groups = new Map<number, { signals: number; fail: boolean }>();

export function installAppServerFixtureHooks() {
  beforeEach(() => {
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      const group = groups.get(-pid);
      if (group) {
        group.signals++;
        if (group.fail) throw denied;
      }
      return originalKill(pid, signal);
    });
    spyOn(Bun, "spawn").mockImplementation(((
      ...args: Parameters<typeof Bun.spawn>
    ) => {
      const child = Reflect.apply(originalSpawn, Bun, args) as ReturnType<
        typeof Bun.spawn
      >;
      const config = args[0];
      if (
        config &&
        "cmd" in config &&
        Array.isArray(config.cmd) &&
        config.cmd[1] === executable
      )
        spawnInterceptors.get(config.cmd[2]!)?.(child);
      return child;
    }) as typeof Bun.spawn);
  });
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    } finally {
      groups.clear();
      spawnInterceptors.clear();
      (Bun.spawn as ReturnType<typeof spyOn>).mockRestore();
      (process.kill as ReturnType<typeof spyOn>).mockRestore();
    }
  });
}

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

export function requireOpened<T extends { status: string }>(
  result: T,
): Extract<T, { status: "opened" }> {
  if (result.status !== "opened") throw new Error(JSON.stringify(result));
  return result as Extract<T, { status: "opened" }>;
}

export function fixture(env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "adapter-app-server-"));
  const effectsPath = join(directory, "effects");
  const raw: RawProviderFrame[] = [];
  const blocked = Promise.withResolvers<void>();
  let fault: Error | undefined;
  let pipeFault: (() => void) | undefined;
  let running = false;
  let fileIndex = 0;
  let bootstrap = 0;
  let pid: number | undefined;
  let group: { signals: number; fail: boolean } | undefined;
  let session: ProviderOwnedSession | undefined;
  let held:
    | {
        started: ReturnType<typeof Promise.withResolvers<void>>;
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
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
  const observed = (): Observed[] =>
    existsSync(effectsPath)
      ? readFileSync(effectsPath, "utf8")
          .split("\n")
          .slice(0, -1)
          .map((line) => JSON.parse(line))
      : [];

  spawnInterceptors.set(directory, (child) => {
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
    if (!child.stdin || typeof child.stdin !== "object") return;
    const output = child.stdin;
    const write = output.write.bind(output);
    spyOn(output, "write").mockImplementation((data) => {
      const gate = held;
      if (
        gate &&
        typeof data === "string" &&
        data.includes('"id":"hold-write"')
      ) {
        gate.started.resolve();
        return gate.release.promise.then(() => write(data));
      }
      return write(data);
    });
  });

  cleanups.push(async () => {
    held?.release.resolve();
    await client.dispose();
    if (pid && group?.fail) {
      try {
        originalKill(-pid, "SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  async function wrote(command: object, barrier = true) {
    const index = String(++fileIndex).padStart(6, "0");
    const name = `barrier:${index}`;
    const temp = join(directory, `${index}.tmp`);
    writeFileSync(
      temp,
      JSON.stringify({ ...command, ...(barrier ? { barrier: name } : {}) }),
    );
    renameSync(temp, join(directory, `${index}.command`));
    if (barrier)
      expect(
        await waitFor(() => existsSync(join(directory, name)), 2500, 5),
      ).toBe(true);
  }

  async function control<T>(run: () => Promise<T>) {
    const gate = held;
    if (!gate) return run();
    await wrote({ frame: { id: "hold-write", method: "fixture/hold" } }, false);
    await gate.started.promise;
    const result = run();
    setImmediate(gate.entered.resolve);
    return result;
  }

  function attach(result: Awaited<ReturnType<typeof client.start>>) {
    if (result.status !== "opened") return result;
    const owned = result.session;
    session = owned;
    running = true;
    pid = Number(readFileSync(join(directory, "pid"), "utf8"));
    group = { signals: 0, fail: false };
    groups.set(pid, group);
    return {
      ...result,
      session: {
        ...owned,
        steer: (request: SteerRequest) => control(() => owned.steer(request)),
        interrupt: (request: InterruptRequest) =>
          control(() => owned.interrupt(request)),
        answer: (request: AnswerRequest) =>
          control(async () => {
            const previous = observed().length;
            const result = await owned.answer(request);
            if (result.status === "in-doubt" && result.reason === "best-effort")
              expect(
                await waitFor(() => observed().length > previous, 2500, 5),
              ).toBe(true);
            return result;
          }),
        close: () => {
          running = false;
          return owned.close();
        },
      },
    };
  }

  const contract: ProviderFixture = {
    adapter: {
      ...client,
      start: async (spec) => attach(await client.start(spec)),
      resume: async (spec) => attach(await client.resume(spec)),
    },
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
    pauseBeforeWrite() {
      const gate = {
        started: Promise.withResolvers<void>(),
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      held = gate;
      return {
        entered: gate.entered.promise,
        release: () => {
          gate.release.resolve();
          held = undefined;
        },
      };
    },
    processExit: () => wrote({ exit: true }, false),
    streamDefect(error) {
      fault = error;
      return wrote({ raw: "fixture defect" }, false);
    },
    failClose() {
      if (!group) throw new Error("No fixture group");
      group.fail = true;
      return { status: "failed", code: "kill-failed", message: String(denied) };
    },
    effects() {
      let count = 0;
      return observed().flatMap(({ action }) =>
        action === "rejected" || (action === "steer" && count++ < bootstrap)
          ? []
          : [action],
      );
    },
    releases: () => group?.signals ?? 0,
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
