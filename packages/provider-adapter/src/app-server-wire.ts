import type { RawProviderFrame } from "./options";
import type { Done } from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcLine } from "./app-server-schema";
import type { makeProviderEvents } from "./provider-events";
import {
  AdapterError,
  processError,
  type RpcId,
  type spawnProvider,
} from "./provider-process";

type Transport = ReturnType<typeof spawnProvider>;
type Frame = Pick<RawProviderFrame, "line" | "base64Fragment">;
type Events = Effect.Success<ReturnType<typeof makeProviderEvents>>;
type Rpc = typeof RpcLine.Type;
type Reply = Pick<Rpc, "result" | "error"> & {
  id: RpcId;
  requestMethod: string;
};
interface Packet {
  frame: Frame;
  rpc?: Rpc;
  reply?: Reply;
  bytes: number;
}

const frameCapacity = 64;
const byteCapacity = 32 * 1024 * 1024;

export const readAppServer = Effect.fn("app-server.read")(function* (
  transport: Transport,
  events: Pick<Events, "full" | "awaitSpace">,
  scope: Scope.Scope,
  responseMethod: (id: RpcId) => string | undefined,
) {
  const queue = yield* Queue.dropping<Packet, AdapterError | Done>(
    frameCapacity,
  );
  const waiting = new Set<Reply>();
  let bytes = 0;

  const settle = ({ id, result, error }: Reply) =>
    transport.settle(id, result, error);

  const read = Effect.fn("app-server.read-frame")(function* (frame: Frame) {
    if (!frame.base64Fragment && !frame.line.trim()) return;
    const decoded = frame.base64Fragment
      ? undefined
      : yield* Effect.result(Schema.decodeUnknownEffect(RpcLine)(frame.line));
    const rpc = decoded?._tag === "Success" ? decoded.success : undefined;
    let reply: Reply | undefined;
    if (rpc && rpc.id !== undefined && !rpc.method) {
      const requestMethod = responseMethod(rpc.id);
      if (requestMethod)
        reply = {
          id: rpc.id,
          result: rpc.result,
          error: rpc.error,
          requestMethod,
        };
    }
    const size = Buffer.byteLength(frame.line, "utf8");
    if (
      bytes + size > byteCapacity ||
      !Queue.offerUnsafe(queue, { frame, rpc, reply, bytes: size })
    ) {
      const overflow = processError(
        "output-overflow",
        "Codex app-server exceeded the stdout read-ahead limit",
      );
      yield* transport.failPending(overflow);
      return yield* overflow;
    }
    bytes += size;
    if (reply) {
      waiting.add(reply);
      if (events.full()) yield* settle(reply);
    }
  });

  yield* Effect.forkIn(
    Stream.fromAsyncIterable(transport.frames(), (cause) =>
      cause instanceof AdapterError
        ? cause
        : processError(
            "read-failed",
            "Could not read app-server output",
            cause,
          ),
    ).pipe(
      Stream.runForEach(read),
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Queue.end(queue)
          : Effect.sync(() => {
              Queue.failCauseUnsafe(queue, exit.cause);
            }),
      ),
      Effect.ignoreCause,
    ),
    scope,
  );

  const awaitSpace = Effect.fn("app-server.await-event-space")(function* () {
    if (!events.full()) return;
    yield* Effect.forEach(waiting, settle, { discard: true });
    yield* events.awaitSpace();
  });

  return {
    settle,
    awaitSpace,
    packets: Stream.fromEffectRepeat(
      Queue.take(queue).pipe(
        Effect.tap((packet) =>
          Effect.sync(() => {
            bytes -= packet.bytes;
            if (packet.reply) waiting.delete(packet.reply);
          }),
        ),
      ),
    ),
  };
});
