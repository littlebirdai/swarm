import { it } from "@codecast/effect-kit/effect/testing";
import type {
  AnswerRequest,
  InterruptRequest,
  OwnedSession,
  ObservedSession,
  ResumeSpec,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import * as Effect from "effect/Effect";
import type { ProviderAdapterClient, ProviderOwnedSession } from "../src";
import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { waitFor } from "@codecast/test-helpers/waitFor";

const originalSpawn = Bun.spawn;
export const originalKill = process.kill.bind(process);
const denied = Object.assign(new Error("fixture kill denied"), {
  code: "EPERM",
});
type Child = ReturnType<typeof Bun.spawn>;
type Write = Bun.FileSink["write"];
export type Intercept = (
  data: Parameters<Write>[0],
  write: Write,
) => ReturnType<Write>;

export function fixtureHooks(executable: string) {
  const fixtures = new Map<string, (child: Child) => void>();
  const groups = new Map<number, { calls: number; fail: boolean }>();
  const cleanups: (() => Promise<void>)[] = [];

  return {
    install() {
      beforeEach(() => {
        spyOn(Bun, "spawn").mockImplementation(((
          ...args: Parameters<typeof Bun.spawn>
        ) => {
          const child = Reflect.apply(originalSpawn, Bun, args) as Child;
          const config = args[0];
          if (
            config &&
            "cmd" in config &&
            Array.isArray(config.cmd) &&
            config.cmd[1] === executable
          )
            fixtures.get(config.cmd[2]!)?.(child);
          return child;
        }) as typeof Bun.spawn);
        spyOn(process, "kill").mockImplementation((pid, signal) => {
          const group = groups.get(-pid);
          if (group) {
            group.calls++;
            if (group.fail) throw denied;
          }
          return originalKill(pid, signal);
        });
      });
      afterEach(async () => {
        try {
          for (const cleanup of cleanups.splice(0)) await cleanup();
        } finally {
          fixtures.clear();
          groups.clear();
          (Bun.spawn as ReturnType<typeof spyOn>).mockRestore();
          (process.kill as ReturnType<typeof spyOn>).mockRestore();
        }
      });
    },
    attach(directory: string, dispose: () => Promise<void>, denyKill = false) {
      let pid = 0;
      let group: { calls: number; fail: boolean } | undefined;
      cleanups.push(async () => {
        try {
          await dispose();
        } finally {
          if (pid && group?.fail) {
            try {
              originalKill(-pid, "SIGKILL");
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ESRCH"
                )
              )
                throw error;
            }
          }
          rmSync(directory, { recursive: true, force: true });
        }
      });
      return {
        spawn(intercept: (child: Child) => void) {
          fixtures.set(directory, (child) => {
            pid = child.pid;
            group = { calls: 0, fail: denyKill };
            groups.set(pid, group);
            intercept(child);
          });
        },
        failClose() {
          if (!group) throw new Error("No fixture group");
          group.fail = true;
          return {
            status: "failed",
            code: "kill-failed",
            message: String(denied),
          } as const;
        },
        releases: () => group?.calls ?? 0,
      };
    },
  };
}

export function interceptInput(child: Child, intercept: Intercept) {
  if (child.stdin && typeof child.stdin === "object") {
    const write = child.stdin.write.bind(child.stdin);
    spyOn(child.stdin, "write").mockImplementation((data) =>
      intercept(data, write),
    );
  }
}

export function commands(directory: string) {
  let counter = 0;
  return async (command: object, barrier = true) => {
    const index = String(++counter).padStart(6, "0");
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
  };
}

export function writeGate(marker: string, start: () => void) {
  let gate:
    | {
        blocked: ReturnType<typeof Promise.withResolvers<void>>;
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  return {
    intercept(
      data: Parameters<Write>[0],
      write: Write,
      next: Intercept = (value, send) => send(value),
    ) {
      if (gate && typeof data === "string" && data.includes(marker)) {
        gate.blocked.resolve();
        return gate.release.promise.then(() => write(data));
      }
      return next(data, write);
    },
    async control<T>(run: () => Promise<T>) {
      const paused = gate;
      if (!paused) return run();
      start();
      await paused.blocked.promise;
      const result = run();
      setImmediate(paused.entered.resolve);
      return result;
    },
    pause() {
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
    release: () => gate?.release.resolve(),
  };
}

export function requireOpened<T extends { status: string }>(
  result: T,
): Extract<T, { status: "opened" }> {
  if (result.status !== "opened") throw new Error(JSON.stringify(result));
  return result as Extract<T, { status: "opened" }>;
}

export function ownedCase<
  F extends { client: ProviderAdapterClient; spec: StartSpec },
>(fixture: (env?: Record<string, string>) => F) {
  return (
    label: string,
    run: (session: ProviderOwnedSession, fake: F) => Promise<void>,
    env?: Record<string, string>,
  ) =>
    it.effect(label, () =>
      Effect.promise(async () => {
        const fake = fixture(env);
        const { session } = requireOpened(await fake.client.start(fake.spec));
        try {
          await run(session, fake);
        } finally {
          await session.close();
        }
      }),
    );
}

export function readEvent(session: OwnedSession | ObservedSession) {
  const events = session.events[Symbol.asyncIterator]();
  return async () => (await events.next()).value;
}

export function readWrites<T>(file: string): T[] {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .slice(0, -1)
        .map((line) => JSON.parse(line))
    : [];
}

export function fixtureAdapter(
  client: ProviderAdapterClient,
  gate: ReturnType<typeof writeGate>,
  count: () => number,
  tracks: readonly ("steer" | "interrupt" | "answer")[],
  opened: (session: ProviderOwnedSession) => void,
  closed: () => void,
) {
  function attach(result: Awaited<ReturnType<ProviderAdapterClient["start"]>>) {
    if (result.status !== "opened") return result;
    const { session } = result;
    opened(session);
    async function run<T extends { status: string; reason?: string }>(
      kind: (typeof tracks)[number],
      effect: () => Promise<T>,
    ) {
      const before = count();
      const result = await gate.control(effect);
      if (
        tracks.includes(kind) &&
        result.status === "in-doubt" &&
        result.reason === "best-effort"
      )
        expect(await waitFor(() => count() > before, 2500, 5)).toBe(true);
      return result;
    }
    return {
      ...result,
      session: {
        ...session,
        steer: (request: SteerRequest) =>
          run("steer", () => session.steer(request)),
        interrupt: (request: InterruptRequest) =>
          run("interrupt", () => session.interrupt(request)),
        answer: (request: AnswerRequest) =>
          run("answer", () => session.answer(request)),
        close: () => {
          closed();
          return session.close();
        },
      },
    };
  }
  return {
    ...client,
    start: async (spec: StartSpec) => attach(await client.start(spec)),
    resume: async (spec: ResumeSpec) => attach(await client.resume(spec)),
  };
}
