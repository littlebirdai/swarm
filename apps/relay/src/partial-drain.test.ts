import { expect, spyOn } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { connect } from "node:net";
import { it } from "@codecast/effect-kit/effect/testing";
import type { RelayConnection } from "@codecast/relay/effect";
import * as Effect from "effect/Effect";
import { readConfig } from "./config";
import { startRelayServer } from "./server";

type SocketData = { connection: RelayConnection | null };
type Drain = NonNullable<WebSocketHandler<SocketData>["drain"]>;

function captureDrain() {
  let drain: Drain | undefined;
  const spy = spyOn(Bun, "serve").mockImplementation(((options: {
    websocket: WebSocketHandler<SocketData>;
  }) => {
    drain = options.websocket.drain;
    return { url: new URL("http://127.0.0.1"), stop: async () => undefined };
  }) as unknown as typeof Bun.serve);
  try {
    const server = startRelayServer(
      readConfig({
        RELAY_AUDIENCE: "cell-A",
        RELAY_HMAC_KEY: Buffer.alloc(32, 57).toString("base64url"),
      }),
    );
    if (!drain) throw new Error("Missing Bun drain handler");
    return { drain, stop: server.stop };
  } finally {
    spy.mockRestore();
  }
}

it.effect("the server resumes a connection only after a full drain", () =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(Effect.sync(captureDrain), (app) =>
      Effect.promise(app.stop),
    );
    let amount = 512;
    let resumes = 0;
    const ws = {
      data: {
        connection: {
          writable: Effect.sync(() => {
            resumes++;
          }),
        },
      },
      getBufferedAmount: () => amount,
    } as unknown as ServerWebSocket<SocketData>;
    app.drain(ws);
    expect(resumes).toBe(0);
    amount = 0;
    app.drain(ws);
    expect(resumes).toBe(1);
  }),
);

async function observePartialDrain(drain: Drain) {
  const mac = process.platform === "darwin";
  const native = dlopen(mac ? "libSystem.B.dylib" : "libc.so.6", {
    getpeername: { args: ["i32", "ptr", "ptr"], returns: "i32" },
    setsockopt: { args: ["i32", "i32", "i32", "ptr", "u32"], returns: "i32" },
  });
  const finished = Promise.withResolvers<{
    amount: number;
    resumes: number;
    bytesRead: number;
  }>();
  let amount = 0;
  let resumes = 0;
  let bytesRead = 0;

  function setBuffer(peerPort: number, option: number, size: number) {
    const address = Buffer.alloc(128);
    const length = new Uint32Array(1);
    const value = new Int32Array([size]);
    for (let fd = 3; fd < 4096; fd++) {
      length[0] = address.length;
      if (native.symbols.getpeername(fd, ptr(address), ptr(length)) !== 0)
        continue;
      if (address.readUInt16BE(2) !== peerPort) continue;
      if (
        native.symbols.setsockopt(
          fd,
          mac ? 0xffff : 1,
          option,
          ptr(value),
          value.byteLength,
        ) === 0
      )
        return;
      break;
    }
    throw new Error("Could not set loopback TCP buffer");
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const connection: RelayConnection = {
        receive: () => Effect.void,
        writable: Effect.sync(() => {
          resumes++;
        }),
        disconnected: Effect.void,
      };
      if (!server.upgrade(request, { data: { connection } }))
        return new Response(null, { status: 426 });
    },
    websocket: {
      backpressureLimit: 16384,
      closeOnBackpressureLimit: true,
      open(ws) {
        try {
          if (!client.localPort) throw new Error("Missing raw client port");
          setBuffer(client.localPort, mac ? 0x1001 : 7, 4096);
          const frame = "x".repeat(4096);
          for (let index = 0; index < 100; index++) {
            ws.sendText(frame);
            if (ws.getBufferedAmount() >= 12000) break;
          }
        } catch (error) {
          finished.reject(error);
        }
      },
      drain(ws) {
        const buffered = ws.getBufferedAmount();
        if (buffered === 0 || amount > 0) return;
        amount = buffered;
        drain(ws);
      },
      message() {},
    },
  });
  const clientOptions = {
    host: "127.0.0.1",
    port: server.port!,
    highWaterMark: 512,
  };
  const client = connect(clientOptions);
  client.once("error", finished.reject);
  client.once("connect", () => {
    try {
      setBuffer(server.port!, mac ? 0x1002 : 8, mac ? 1024 : 4096);
      client.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
    } catch (error) {
      finished.reject(error);
    }
  });
  const reader = setInterval(() => {
    bytesRead += client.read(512)?.length ?? 0;
    if (amount > 0 && bytesRead > 0)
      finished.resolve({ amount, resumes, bytesRead });
  }, 10);
  const limit = setTimeout(
    () => finished.reject(new Error("No partial Bun drain before deadline")),
    2500,
  );
  try {
    return await finished.promise;
  } finally {
    clearInterval(reader);
    clearTimeout(limit);
    client.destroy();
    await server.stop(true);
    native.close();
  }
}

it.effect(
  "real Bun reports a partial drain while a raw TCP reader is throttled",
  () =>
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(
        Effect.sync(captureDrain),
        (app) => Effect.promise(app.stop),
      );
      const observed = yield* Effect.promise(() =>
        observePartialDrain(app.drain),
      );
      expect(observed.amount).toBeGreaterThan(0);
      expect(observed.bytesRead).toBeGreaterThanOrEqual(512);
      expect(observed.resumes).toBe(0);
    }),
  2900,
);
