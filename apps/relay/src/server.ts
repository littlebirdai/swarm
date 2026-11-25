import { RELAY_MAX_FRAME_BYTES } from "@codecast/relay-contract";
import { Relay, type RelayConnection } from "@codecast/relay/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { ServerConfig } from "./config";
import { hmacVerifier } from "./token-verifier";

export function startRelayServer(config: ServerConfig) {
  const runtime = ManagedRuntime.make(
    Relay.layer(config).pipe(Layer.provide(hmacVerifier(config.key))),
  );
  const server = Bun.serve<{ connection: RelayConnection | null }>({
    hostname: config.hostname,
    port: config.port,
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/health" && request.method === "GET") {
        const draining = runtime.runSync(
          Effect.flatMap(Relay, (relay) => relay.isDraining),
        );
        return Response.json(
          { status: draining ? "draining" : "ok" },
          { status: draining ? 503 : 200 },
        );
      }
      if (pathname !== "/relay") return new Response(null, { status: 404 });
      if (server.upgrade(request, { data: { connection: null } })) return;
      return new Response(null, { status: 426 });
    },
    websocket: {
      maxPayloadLength: RELAY_MAX_FRAME_BYTES,
      backpressureLimit: RELAY_MAX_FRAME_BYTES * 2,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open(ws) {
        ws.data.connection = runtime.runSync(
          Effect.flatMap(Relay, (relay) =>
            relay.open({
              send(text) {
                const size = ws.sendText(text);
                if (size === 0) return "closed";
                return size < 0 ? "paused" : "sent";
              },
              close: (code) => ws.close(code),
              terminate: () => ws.terminate(),
            }),
          ),
        );
      },
      message(ws, message) {
        const connection = ws.data.connection;
        if (connection) runtime.runSync(connection.receive(message));
      },
      drain(ws) {
        const connection = ws.data.connection;
        if (connection) runtime.runSync(connection.writable);
      },
      close(ws) {
        const connection = ws.data.connection;
        ws.data.connection = null;
        if (connection) runtime.runSync(connection.disconnected);
      },
    },
  });

  let stopping: Promise<void> | undefined;
  function stop() {
    stopping ??= runtime
      .runPromise(
        Effect.gen(function* () {
          const relay = yield* Relay;
          yield* relay.drain;
          const graceful = Effect.promise(() => server.stop()).pipe(
            Effect.as(true),
          );
          const timeout = Effect.sleep(config.drainMs).pipe(Effect.as(false));
          if (!(yield* Effect.raceFirst(graceful, timeout))) {
            yield* Effect.promise(() => server.stop(true));
          }
        }),
      )
      .finally(() => runtime.dispose());
    return stopping;
  }

  return { url: server.url, stop };
}
