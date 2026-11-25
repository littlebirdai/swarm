import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { CloseOutcome } from "@codecast/provider-contract";
import type { RpcId } from "./acp-schema";
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

export function spawnAcp(options: ProviderAdapterOptions, cwd: string) {
  const child = Bun.spawn({
    cmd: [...(options.command ?? ["grok", "agent", "stdio"])],
    cwd,
    env: options.env ?? process.env,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();
  let closing = false;
  let writing = false;
  let nextId = 0;
  let stderrError: AdapterError | undefined;
  const pending = new Map<
    number,
    { method: string; response: Deferred.Deferred<unknown, AdapterError> }
  >();
  let groupResult: CloseOutcome | undefined;
  function stopGroup(): CloseOutcome {
    if (groupResult) return groupResult;
    try {
      process.kill(-child.pid, "SIGKILL");
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

  const exit = child.exited.then((code) => {
    stopGroup();
    return child.signalCode ?? (code === 0 ? "exited" : `exit-${code}`);
  });
  const drainStderr = async () => {
    try {
      while (true) {
        const { done, value } = await stderr.read();
        if (done) break;
        options.onStderr?.(Buffer.from(value).toString().slice(0, 500));
      }
    } catch (cause) {
      if (!closing) {
        stderrError = processError(
          "stderr-handler",
          "ACP stderr reader failed",
          cause,
        );
        await stdout.cancel().catch(() => {});
      }
    }
  };
  void drainStderr();

  async function* frames(): AsyncGenerator<
    Pick<RawProviderFrame, "line" | "base64Fragment">
  > {
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
      const { done, value } = await stdout.read();
      if (stderrError) throw stderrError;
      if (done) break;
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const part = chunk.subarray(start, newline < 0 ? undefined : newline);
        if (fragment > 0 || length + part.length > maxFrameBytes) {
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

  function write(...messages: object[]) {
    return Effect.tryPromise({
      try: async () => {
        if (closing || child.exitCode !== null)
          throw processError("channel-closed", "ACP input is closed");
        if (writing)
          throw processError(
            "channel-busy",
            "Another ACP write is still pending",
          );
        writing = true;
        try {
          child.stdin.write(
            messages
              .map(
                (message) =>
                  JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
              )
              .join(""),
          );
          await child.stdin.flush();
        } finally {
          writing = false;
        }
      },
      catch: (cause) =>
        cause instanceof AdapterError
          ? cause
          : processError("write-failed", "Could not write ACP input", cause),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(processError("write-timeout", "ACP input did not drain")),
      }),
    );
  }

  const request = Effect.fn("acp.request")(function* (
    method: string,
    params: object,
  ) {
    const response = yield* Deferred.make<unknown, AdapterError>();
    const id = ++nextId;
    pending.set(id, { method, response });
    const awaitResponse = Deferred.await(response).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
    return {
      id,
      discard: Effect.sync(() => {
        pending.delete(id);
      }),
      send: write({ id, method, params }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      ),
      awaitResponse,
    };
  });

  const settle = Effect.fn("acp.settle")(function* (
    id: RpcId,
    result: unknown,
    error?: { code: number; message: string },
  ) {
    const deferred =
      typeof id === "number" ? pending.get(id)?.response : undefined;
    if (!deferred) return false;
    pending.delete(Number(id));
    yield* error
      ? Deferred.fail(deferred, processError("rpc-rejected", error.message))
      : Deferred.succeed(deferred, result);
    return true;
  });

  const failPending = Effect.fn("acp.failPending")(function* (
    error: AdapterError,
  ) {
    for (const { response } of pending.values())
      yield* Deferred.fail(response, error);
    pending.clear();
  });

  let released: Promise<CloseOutcome> | undefined;
  function release(): Promise<CloseOutcome> {
    closing = true;
    return (released ??= (async () => {
      const outcome = stopGroup();
      await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
      const endInput = Promise.resolve().then(() => child.stdin.end());
      if (outcome.status === "failed") {
        child.unref();
        void endInput.catch(() => {});
      } else {
        await child.exited;
        await endInput.catch(() => {});
      }
      return outcome;
    })());
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
    exit,
  };
}
