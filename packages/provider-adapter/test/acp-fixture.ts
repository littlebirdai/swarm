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
  answer: "allow",
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
const closeError = Object.assign(new Error("fixture kill denied"), {
  code: "EPERM",
});
export const bufferCapacity = 32;
const fixtureScript = join(import.meta.dir, "fake-acp.ts");
export const originalKill = process.kill.bind(process);
const groups = new Map<number, { calls: number; fail: boolean }>();
const cleanups: (() => Promise<void>)[] = [];
const originalSpawn = Bun.spawn;
type Write = Bun.FileSink["write"];
type Intercept = (
  data: Parameters<Write>[0],
  write: Write,
) => ReturnType<Write>;
const writes = new Map<string, Intercept>();

function spawnWithIntercept(...args: Parameters<typeof Bun.spawn>) {
  const child = Reflect.apply(originalSpawn, Bun, args) as ReturnType<
    typeof Bun.spawn
  >;
  const config = args[0];
  if (
    config &&
    "cmd" in config &&
    Array.isArray(config.cmd) &&
    config.cmd[1] === fixtureScript
  ) {
    const write = writes.get(config.cmd[2]!);
    if (write && child.stdin && typeof child.stdin === "object") {
      const original = child.stdin.write.bind(child.stdin);
      spyOn(child.stdin, "write").mockImplementation((data) =>
        write(data, original),
      );
    }
  }
  return child;
}

export function installAcpFixtureHooks() {
  beforeEach(() => {
    spyOn(Bun, "spawn").mockImplementation(
      spawnWithIntercept as typeof Bun.spawn,
    );
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      const group = groups.get(-pid);
      if (group) {
        group.calls++;
        if (group.fail) throw closeError;
      }
      return originalKill(pid, signal);
    });
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    } finally {
      groups.clear();
      writes.clear();
      (Bun.spawn as ReturnType<typeof spyOn>).mockRestore();
      (process.kill as ReturnType<typeof spyOn>).mockRestore();
    }
  });
}

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
  let gate:
    | {
        blocked: ReturnType<typeof Promise.withResolvers<void>>;
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  writes.set(directory, (data, write) => {
    if (
      gate &&
      typeof data === "string" &&
      data.includes('"id":"fixture-write-gate"')
    ) {
      gate.blocked.resolve();
      return gate.release.promise.then(() => write(data));
    }
    return intercept ? intercept(data, write) : write(data);
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
  let group: { calls: number; fail: boolean } | undefined;
  let pid: number | undefined;
  let queued = 0;
  let running = false;

  cleanups.push(async () => {
    gate?.release.resolve();
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

  const observed = () =>
    existsSync(effectsPath)
      ? readFileSync(effectsPath, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                action: ProviderEffect;
                message: {
                  id?: string;
                  params?: { prompt?: unknown[] };
                  result?: unknown;
                };
              },
          )
      : [];

  async function wrote(command: object, barrier = true) {
    const index = String(++queued).padStart(6, "0");
    const barrierId = `barrier:${index}`;
    const temporary = join(directory, `${index}.tmp`);
    writeFileSync(
      temporary,
      JSON.stringify({
        ...command,
        ...(barrier ? { barrier: barrierId } : {}),
      }),
    );
    renameSync(temporary, join(directory, `${index}.command`));
    if (barrier)
      expect(
        await waitFor(() => existsSync(join(directory, barrierId)), 2500, 5),
      ).toBe(true);
  }

  async function runControl<T>(run: () => Promise<T>): Promise<T> {
    const paused = gate;
    if (!paused) return run();
    await wrote(
      { frame: { id: "fixture-write-gate", method: "fixture/hold-write" } },
      false,
    );
    await paused.blocked.promise;
    const result = run();
    setImmediate(paused.entered.resolve);
    return result;
  }

  let bootstrap = 0;
  const attach = (result: Awaited<ReturnType<typeof client.start>>) => {
    if (result.status !== "opened") return result;
    pid = Number(readFileSync(join(directory, "pid"), "utf8"));
    group = { calls: 0, fail: false };
    groups.set(pid, group);
    running = true;
    const owned = result.session;
    session = owned;
    return {
      status: "opened" as const,
      session: {
        ...owned,
        async steer(request: SteerRequest) {
          const before = observed().length;
          const result = await runControl(() => owned.steer(request));
          if (result.status === "in-doubt")
            expect(
              await waitFor(() => observed().length > before, 2500, 5),
            ).toBe(true);
          return result;
        },
        async interrupt(request: InterruptRequest) {
          const before = observed().length;
          const result = await runControl(() => owned.interrupt(request));
          if (result.status === "in-doubt")
            expect(
              await waitFor(() => observed().length > before, 2500, 5),
            ).toBe(true);
          return result;
        },
        async answer(request: AnswerRequest) {
          const before = observed().length;
          const result = await runControl(() => owned.answer(request));
          if (result.status === "in-doubt")
            expect(
              await waitFor(() => observed().length > before, 2500, 5),
            ).toBe(true);
          return result;
        },
        close() {
          running = false;
          return owned.close();
        },
      },
    };
  };

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
    pauseBeforeWrite() {
      const paused = {
        blocked: Promise.withResolvers<void>(),
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      gate = paused;
      return {
        entered: paused.entered.promise,
        release() {
          paused.release.resolve();
          gate = undefined;
        },
      };
    },
    async processExit() {
      await wrote({ exit: true }, false);
    },
    async streamDefect(error) {
      fault = error;
      await wrote({ raw: "fixture defect" }, false);
    },
    failClose() {
      if (!group) throw new Error("No process group");
      group.fail = true;
      return {
        status: "failed",
        code: "kill-failed",
        message: String(closeError),
      };
    },
    effects() {
      let ignored = 0;
      return observed().flatMap(({ action }) =>
        action === "steer" && ignored++ < bootstrap ? [] : [action],
      );
    },
    releases: () => group?.calls ?? 0,
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
