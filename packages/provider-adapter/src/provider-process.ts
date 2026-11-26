import { existsSync } from "node:fs";
import { withoutSecrets } from "@codecast/secrets/secretShapes";
import { hasInterruptsOnly } from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import type { CloseOutcome } from "@codecast/provider-contract";

import {
  closed,
  type ProviderAdapterOptions,
  type RawProviderFrame,
} from "./options";

export class AdapterError extends Data.TaggedError("AdapterError")<{
  code: string;
  message: string;
  cause?: unknown;
}> {}

const maxFrameBytes = 8 * 1024 * 1024;

export const processError = (code: string, message: string, cause?: unknown) =>
  new AdapterError({ code, message, cause });

export type RpcId = number | string;

interface DialectProcess {
  name: string;
  command: readonly [string, ...string[]];
  framing?: "stream-json";
}

export const ownProviderProcess = Effect.fn("provider.own-process")(function* (
  options: ProviderAdapterOptions,
  cwd: string,
  scope: Scope.Scope,
  dialect: DialectProcess,
) {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => spawnProvider(options, cwd, scope, dialect),
      catch: (cause) =>
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT" &&
        existsSync(cwd)
          ? processError(
              "binary-missing",
              `${dialect.name} executable was not found`,
            )
          : processError(
              "spawn-failed",
              `Could not start ${dialect.name} process`,
              cause,
            ),
    }),
    (transport) =>
      Effect.flatMap(Effect.promise(transport.release), (result) =>
        result.status === "failed"
          ? Effect.die(processError(result.code, result.message))
          : Effect.void,
      ),
  ).pipe(Scope.provide(scope));
});

export const bestEffortReplies = Effect.fn("provider.best-effort-replies")(
  function* (transport: ReturnType<typeof spawnProvider>, scope: Scope.Scope) {
    const replies = yield* Queue.dropping<object>(32);
    yield* Effect.forkIn(
      Effect.forever(
        Queue.take(replies).pipe(
          Effect.flatMap((reply) =>
            transport.write(() => Result.succeed([reply])),
          ),
          Effect.ignore,
        ),
      ),
      scope,
    );
    return replies;
  },
);

export function spawnProvider(
  options: ProviderAdapterOptions,
  cwd: string,
  scope: Scope.Scope,
  dialect: DialectProcess,
) {
  let groupResult: CloseOutcome | undefined;
  function stopGroup(pid: number): CloseOutcome {
    if (groupResult) return groupResult;
    if (pid <= 0) return (groupResult = closed);
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        return (groupResult = {
          status: "failed",
          code: "kill-failed",
          message: String(error),
        });
      }
    }
    return (groupResult = closed);
  }

  const child = Bun.spawn({
    cmd: [...(options.command ?? dialect.command)],
    cwd,
    env: options.env ?? process.env,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    onExit: (process) => {
      stopGroup(process.pid);
    },
  });
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();
  let closing = false;
  const writer = Semaphore.makeUnsafe(1);
  const writeQueueError = processError(
    "write-queue-timeout",
    `${dialect.name} input did not drain`,
  );
  const newWriteWindow = () => ({
    expired: false,
    signal: Deferred.makeUnsafe<void>(),
  });
  let writeWindow = newWriteWindow();
  const isClosed = () => closing || scope.state._tag === "Closed";
  const inputClosed = () =>
    isClosed() || child.exitCode !== null || child.signalCode !== null;
  let nextId = 0;
  let stderrError: AdapterError | undefined;
  const pending = new Map<
    number,
    { method: string; response: Deferred.Deferred<unknown, AdapterError> }
  >();
  const exit = child.exited.then(
    (code) => child.signalCode ?? (code === 0 ? "exited" : `exit-${code}`),
  );
  const drainStderr = async () => {
    try {
      let inPrivateKey = false;
      for await (const { line, base64Fragment } of readFrames(stderr, 8192)) {
        if (isClosed()) break;
        if (base64Fragment) continue;
        const redacted = withoutSecrets(line);
        let safe = "";
        let offset = 0;
        for (const marker of redacted.matchAll(
          /-----(BEGIN|END) [A-Z0-9 ]{0,40}?PRIVATE KEY-----/g,
        )) {
          if (!inPrivateKey) {
            safe += redacted.slice(offset, marker.index);
            if (marker[1] === "BEGIN") safe += "[redacted:private-key]";
          }
          inPrivateKey = marker[1] === "BEGIN";
          offset = marker.index + marker[0].length;
        }
        if (!inPrivateKey) safe += redacted.slice(offset);
        if (safe) options.onStderr?.(safe.slice(0, 500));
      }
    } catch (cause) {
      if (!closing) {
        stderrError = processError(
          "stderr-handler",
          `${dialect.name} stderr reader failed`,
          cause,
        );
        await stdout.cancel().catch(() => {});
      }
    }
  };
  void drainStderr();

  async function* frames() {
    yield* readFrames(stdout, maxFrameBytes);
    if (stderrError) throw stderrError;
  }

  const write = Effect.fn("provider.write")(function* <E>(
    prepare: () => Result.Result<readonly object[], E>,
  ) {
    if (inputClosed())
      return yield* processError(
        "channel-closed",
        `${dialect.name} input is closed`,
      );
    const window = writeWindow;
    if (window.expired) return yield* writeQueueError;
    let started = false;
    let finished = false;
    const worker = yield* Effect.forkIn(
      Semaphore.withPermit(
        writer,
        Effect.callback<void, E | AdapterError>((resume) => {
          if (inputClosed()) {
            resume(
              Effect.fail(
                processError(
                  "channel-closed",
                  `${dialect.name} input is closed`,
                ),
              ),
            );
            return;
          }
          if (window.expired) {
            resume(Effect.fail(writeQueueError));
            return;
          }
          const planned = prepare();
          if (planned._tag === "Failure") {
            resume(Effect.fail(planned.failure));
            return;
          }
          started = true;
          const send = async () => {
            await child.stdin.write(
              planned.success
                .map(
                  (message) =>
                    JSON.stringify(
                      dialect.framing === "stream-json"
                        ? message
                        : { jsonrpc: "2.0", ...message },
                    ) + "\n",
                )
                .join(""),
            );
            await child.stdin.flush();
          };
          const finish = (result: Effect.Effect<void, AdapterError>) => {
            finished = true;
            if (window.expired) writeWindow = newWriteWindow();
            resume(result);
          };
          void send().then(
            () => finish(Effect.void),
            (cause) =>
              finish(
                Effect.fail(
                  processError(
                    "write-failed",
                    `Could not write ${dialect.name} input`,
                    cause,
                  ),
                ),
              ),
          );
        }),
      ),
      scope,
      { startImmediately: true },
    );
    return yield* Fiber.join(worker).pipe(
      Effect.catchCause((cause) =>
        isClosed() && hasInterruptsOnly(cause)
          ? Effect.fail(
              processError(
                started ? "write-interrupted" : "channel-closed",
                `${dialect.name} input is closed`,
              ),
            )
          : Effect.failCause(cause),
      ),
      Effect.raceFirst(
        Deferred.await(window.signal).pipe(
          Effect.flatMap(() =>
            started ? Effect.never : Effect.fail(writeQueueError),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.suspend(() => {
            if (!started) return Effect.fail(writeQueueError);
            if (!finished) {
              window.expired = true;
              Deferred.doneUnsafe(window.signal, Effect.void);
            }
            return Effect.fail(
              processError(
                "write-timeout",
                `${dialect.name} input did not drain`,
              ),
            );
          }),
      }),
      Effect.ensuring(
        Effect.suspend(() => (started ? Effect.void : Fiber.interrupt(worker))),
      ),
    );
  });

  const request = Effect.fn("provider.request")(function* (
    method: string,
    params: object,
    encode: (id: number, method: string, params: object) => object = (
      id,
      method,
      params,
    ) => ({
      id,
      method,
      params,
    }),
  ) {
    const response = yield* Deferred.make<unknown, AdapterError>();
    const id = ++nextId;
    return {
      id,
      send<E = never>(beforeWrite?: () => Result.Result<void, E>) {
        return write(() => {
          const planned = beforeWrite?.();
          if (planned?._tag === "Failure") return Result.fail(planned.failure);
          pending.set(id, { method, response });
          return Result.succeed([encode(id, method, params)]);
        });
      },
      awaitResponse: Deferred.await(response),
      forget: Effect.sync(() => {
        pending.delete(id);
      }),
    };
  });

  const settle = Effect.fn("provider.settle")(function* (
    id: RpcId,
    result: unknown,
    error?: AdapterError | { code: number; message: string },
  ) {
    const deferred =
      typeof id === "number" ? pending.get(id)?.response : undefined;
    if (!deferred) return false;
    pending.delete(Number(id));
    yield* error
      ? Deferred.fail(
          deferred,
          error instanceof AdapterError
            ? error
            : processError("rpc-rejected", withoutSecrets(error.message)),
        )
      : Deferred.succeed(deferred, result);
    return true;
  });

  const failPending = Effect.fn("provider.failPending")(function* (
    error: AdapterError,
  ) {
    for (const { response } of pending.values())
      yield* Deferred.fail(response, error);
    pending.clear();
  });

  const releaseResult = Promise.withResolvers<CloseOutcome>();
  let releasing = false;
  async function release() {
    if (releasing) return releaseResult.promise;
    releasing = true;
    closing = true;
    const outcome = stopGroup(child.pid);
    await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
    const endInput = Promise.resolve()
      .then(() => child.stdin.end())
      .catch(() => {});
    if (outcome.status === "failed") child.unref();
    else await Promise.allSettled([child.exited, endInput]);
    releaseResult.resolve(outcome);
    return outcome;
  }

  return {
    frames,
    fence: () => {
      closing = true;
      void stdout.cancel().catch(() => {});
    },
    write,
    request,
    settle,
    pendingMethod: (id: RpcId) =>
      typeof id === "number" ? pending.get(id)?.method : undefined,
    failPending,
    release,
    releaseOutcome: () => releaseResult.promise,
    terminate: () => stopGroup(child.pid),
    exit,
  };
}

async function* readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): AsyncGenerator<Pick<RawProviderFrame, "line" | "base64Fragment">> {
  let parts: Buffer[] = [];
  let length = 0;
  let fragment = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function decode(bytes: Buffer) {
    try {
      return { line: decoder.decode(bytes) };
    } catch {
      return {
        line: bytes.toString("base64"),
        base64Fragment: { index: 0, last: true },
      };
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline < 0 ? undefined : newline);
      if (fragment > 0 || length + part.length > limit) {
        if (length > 0) {
          yield {
            line: Buffer.concat(parts, length).toString("base64"),
            base64Fragment: { index: fragment++, last: false },
          };
        }
        yield {
          line: part.toString("base64"),
          base64Fragment: { index: fragment++, last: newline >= 0 },
        };
      } else {
        parts.push(part);
        length += part.length;
        if (newline < 0) break;
        yield decode(Buffer.concat(parts, length));
      }
      length = 0;
      parts = [];
      if (newline < 0) break;
      fragment = 0;
      start = newline + 1;
    }
  }
  if (fragment > 0)
    yield { line: "", base64Fragment: { index: fragment, last: true } };
  else if (length > 0) yield decode(Buffer.concat(parts, length));
}

export function rawFrames(
  options: ProviderAdapterOptions,
  scope: Pick<RawProviderFrame, "session" | "run">,
) {
  let unknownCount = 0;
  return {
    getUnknownPayloadCount: () => unknownCount,
    retain: Effect.fn("provider.retain")(function* (
      line: string,
      disposition: RawProviderFrame["disposition"],
      base64Fragment?: RawProviderFrame["base64Fragment"],
    ) {
      if (
        disposition === "unknown" &&
        (!base64Fragment || base64Fragment.index === 0)
      )
        unknownCount++;
      yield* Effect.promise(async (signal) =>
        options.retainRaw(
          {
            session: scope.session,
            run: scope.run,
            line,
            disposition,
            ...(base64Fragment ? { base64Fragment } : {}),
          },
          signal,
        ),
      );
    }),
  };
}
