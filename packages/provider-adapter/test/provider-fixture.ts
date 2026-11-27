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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { waitFor } from "@codecast/test-helpers/waitFor";

const originalSpawn = Bun.spawn;
export const originalKill = process.kill.bind(process);
const DEFAULT_WAIT_MS = 2500;
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
  const fixtures = new Map<
    string,
    { onSpawn: (child: Child) => void; onIpc: (message: unknown) => void }
  >();
  const groups = new Map<
    number,
    { calls: number; fail: boolean; notify: () => void }
  >();
  const cleanups: (() => Promise<void>)[] = [];

  return {
    install() {
      beforeEach(() => {
        spyOn(Bun, "spawn").mockImplementation(((
          ...args: Parameters<typeof Bun.spawn>
        ) => {
          const config = args[0];
          const match =
            config &&
            "cmd" in config &&
            Array.isArray(config.cmd) &&
            config.cmd[1] === executable
              ? fixtures.get(config.cmd[2]!)
              : undefined;
          const child = Reflect.apply(
            originalSpawn,
            Bun,
            match
              ? [
                  {
                    ...config,
                    ipc: (message: unknown) => match.onIpc(message),
                  },
                ]
              : args,
          ) as Child;
          match?.onSpawn(child);
          return child;
        }) as typeof Bun.spawn);
        spyOn(process, "kill").mockImplementation((pid, signal) => {
          const group = groups.get(-pid);
          if (group) {
            group.calls++;
            group.notify();
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
      let child: Child | undefined;
      let group:
        | { calls: number; fail: boolean; notify: () => void }
        | undefined;
      let intercept: ((child: Child) => void) | undefined;
      let aborted: Error | null = null;
      let generation = 0;
      const ipcListeners = new Set<(message: unknown) => void>();
      const releaseListeners = new Set<() => void>();
      const abortListeners = new Set<(error: Error) => void>();
      function abort(reason: string) {
        if (aborted) return;
        aborted = new Error(reason);
        for (const listener of [...abortListeners]) listener(aborted);
        abortListeners.clear();
      }
      function wait<T>(
        label: string,
        subscribe: (resolve: (value: T) => void) => () => void,
        timeoutMs = DEFAULT_WAIT_MS,
      ): Promise<T> {
        if (aborted)
          return Promise.reject(
            new Error(`${label} aborted: ${aborted.message}`),
          );
        return new Promise<T>((resolve, reject) => {
          let done = false;
          let unsubscribe: (() => void) | undefined;
          const finish = (complete: () => void) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            abortListeners.delete(onAbort);
            unsubscribe?.();
            complete();
          };
          const onAbort = (error: Error) =>
            finish(() =>
              reject(new Error(`${label} aborted: ${error.message}`)),
            );
          const timer = setTimeout(
            () =>
              finish(() =>
                reject(
                  new Error(
                    `Timed out waiting for ${label} after ${timeoutMs}ms`,
                  ),
                ),
              ),
            timeoutMs,
          );
          abortListeners.add(onAbort);
          try {
            unsubscribe = subscribe((value) => finish(() => resolve(value)));
          } catch (error) {
            finish(() => reject(error));
          }
        });
      }
      fixtures.set(directory, {
        onSpawn(spawned) {
          const spawnGeneration = ++generation;
          aborted = null;
          child = spawned;
          pid = spawned.pid;
          group = {
            calls: 0,
            fail: denyKill,
            notify() {
              for (const listener of [...releaseListeners]) listener();
            },
          };
          groups.set(pid, group);
          void spawned.exited.then((code) => {
            if (generation === spawnGeneration)
              abort(`fixture child exited (${code})`);
          });
          intercept?.(spawned);
        },
        onIpc(message) {
          for (const listener of [...ipcListeners]) listener(message);
        },
      });
      cleanups.push(async () => {
        try {
          await dispose();
        } finally {
          generation++;
          abort("fixture disposed");
          ipcListeners.clear();
          releaseListeners.clear();
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
        spawn(onSpawn: (child: Child) => void) {
          intercept = onSpawn;
        },
        send(command: object) {
          if (aborted)
            throw new Error(`Fixture send aborted: ${aborted.message}`);
          if (!child) throw new Error("Fixture child is not spawned");
          child.send(command);
        },
        onIpc(listener: (message: unknown) => void) {
          ipcListeners.add(listener);
          return () => ipcListeners.delete(listener);
        },
        wait,
        waitRelease(target = 1, timeoutMs?: number) {
          if ((group?.calls ?? 0) >= target) return Promise.resolve();
          return wait<void>(
            `release (${target})`,
            (resolve) => {
              const check = () => {
                if ((group?.calls ?? 0) >= target) resolve();
              };
              releaseListeners.add(check);
              return () => releaseListeners.delete(check);
            },
            timeoutMs,
          );
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

export function ipcCommands(
  attachHandle: ReturnType<ReturnType<typeof fixtureHooks>["attach"]>,
) {
  let counter = 0;
  const barriers = new Map<string, () => void>();
  const observedWaiters = new Set<() => void>();
  attachHandle.onIpc((message) => {
    if (!message || typeof message !== "object") return;
    const payload = message as { type?: unknown; id?: unknown };
    if (payload.type === "barrier" && typeof payload.id === "string") {
      const resolve = barriers.get(payload.id);
      if (resolve) {
        barriers.delete(payload.id);
        resolve();
      }
      return;
    }
    if (payload.type === "observed") {
      for (const notify of [...observedWaiters]) notify();
    }
  });
  return {
    async send(command: object, barrier = true, timeoutMs?: number) {
      if (!barrier) {
        attachHandle.send(command);
        return;
      }
      const id = `barrier:${String(++counter).padStart(6, "0")}`;
      await attachHandle.wait<void>(
        id,
        (resolve) => {
          barriers.set(id, resolve);
          attachHandle.send({ ...command, barrier: id });
          return () => barriers.delete(id);
        },
        timeoutMs,
      );
    },
    waitObserved(
      ready: () => boolean,
      label = "observed effect",
      timeoutMs?: number,
    ) {
      if (ready()) return Promise.resolve();
      return attachHandle.wait<void>(
        label,
        (resolve) => {
          const check = () => {
            if (ready()) resolve();
          };
          observedWaiters.add(check);
          return () => observedWaiters.delete(check);
        },
        timeoutMs,
      );
    },
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
  waitObserved?: (ready: () => boolean) => Promise<void>,
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
      ) {
        if (waitObserved) await waitObserved(() => count() > before);
        else expect(await waitFor(() => count() > before, 2500, 5)).toBe(true);
      }
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
