import type { RelayClientOptions } from "@codecast/relay-client";
import { RELAY_PROTOCOL_VERSION } from "@codecast/relay-contract";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { it } from "@codecast/effect-kit/effect/testing";
import { makeRelayLiveness } from "../src/relay-liveness-layer";
import type { EdgeTransport } from "../src/types";

type SocketListener = (event: { data?: unknown; code?: number }) => void;

class FakeRelaySocket {
  static instances: FakeRelaySocket[] = [];
  readonly sent: string[] = [];
  private listeners = new Map<string, Set<SocketListener>>();

  constructor(readonly url: string) {
    FakeRelaySocket.instances.push(this);
  }

  addEventListener(type: string, handler: SocketListener) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  send(text: string) {
    this.sent.push(text);
  }

  close() {}

  emit(type: string, event: { data?: unknown; code?: number } = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler(event);
    }
  }
}

const lease = {
  session: "conv-1",
  run: 4,
  fencing_token: "fence-4",
  deadline: Math.ceil(performance.now()) + 60_000,
};

function makeTransport(capabilities: readonly string[]): {
  transport: EdgeTransport;
  helloCapabilities: string[][];
  grantSessions: Array<
    Array<{ session: string; run: number; fencing_token: string }>
  >;
} {
  const helloCapabilities: string[][] = [];
  const grantSessions: Array<
    Array<{ session: string; run: number; fencing_token: string }>
  > = [];
  const transport: EdgeTransport = async (operation, request) => {
    if (operation === "hello") {
      const helloReq = request as { capabilities: string[] };
      helloCapabilities.push([...helloReq.capabilities]);
      return {
        status: 200,
        body: {
          status: "ok",
          version: 1,
          policy: {
            revision: 1,
            heartbeat_interval_ms: 5000,
            uplink_interval_ms: 1000,
            limits: {
              max_batch_events: 100,
              max_batch_bytes: 1_000_000,
              max_blob_bytes: 1_000_000,
            },
            capabilities: [...capabilities],
          },
        },
      };
    }
    if (operation === "relay-grant") {
      const grantReq = request as {
        sessions: Array<{
          session: string;
          run: number;
          fencing_token: string;
        }>;
      };
      grantSessions.push([...grantReq.sessions]);
      return {
        status: 200,
        body: {
          v: 1,
          status: "ok",
          url: "wss://relay.example.test/relay",
          token: "grant-token",
          ttl_ms: 60_000,
        },
      };
    }
    return { status: 404, body: { error: "not_found" } };
  };
  return { transport, helloCapabilities, grantSessions };
}

it.effect("negotiates token_delta capability and publishes frames", () =>
  Effect.gen(function* () {
    FakeRelaySocket.instances = [];
    const { transport, helloCapabilities, grantSessions } = makeTransport([
      "relay_session_liveness",
      "relay_token_deltas",
    ]);
    const liveness = makeRelayLiveness(
      {
        transport,
        hello: {
          machine: "machine-1",
          boot: "boot-1",
          providers: [{ name: "codex", version: "1.0.0" }],
          runtimes: [{ host: "daemon", isolation: "app-server" }],
          capacity: {
            memory_total_bytes: 0,
            memory_available_bytes: 0,
            live_agents: 1,
          },
        },
        tokenDeltas: true,
        WebSocket:
          FakeRelaySocket as unknown as RelayClientOptions["WebSocket"],
      },
      [lease],
    );

    const fiber = yield* Layer.build(liveness.layer).pipe(
      Effect.andThen(Effect.never),
      Effect.forkScoped,
    );
    yield* Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );

    expect(helloCapabilities).toEqual([
      ["relay_session_liveness", "relay_token_deltas"],
    ]);
    expect(grantSessions).toEqual([
      [{ session: "conv-1", run: 4, fencing_token: "fence-4" }],
    ]);

    const socket = FakeRelaySocket.instances[0];
    expect(socket).toBeDefined();
    socket.emit("open");
    yield* Effect.yieldNow;

    const connectFrame = JSON.parse(socket.sent[0]!);
    expect(connectFrame.type).toBe("connect");
    expect(connectFrame.capabilities).toEqual([
      "session_liveness",
      "token_delta",
    ]);

    socket.emit("message", {
      data: JSON.stringify({
        type: "hello",
        status: "ok",
        version: RELAY_PROTOCOL_VERSION,
        capabilities: ["session_liveness", "token_delta"],
        connection_id: "conn-1",
        ttl_ms: 60_000,
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        v: RELAY_PROTOCOL_VERSION,
        type: "subscription",
        status: "subscribed",
        hub: { kind: "session", id: "conv-1" },
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        v: RELAY_PROTOCOL_VERSION,
        type: "subscription",
        status: "subscribed",
        hub: { kind: "session", id: "viewer:conv-1" },
      }),
    });
    yield* Effect.yieldNow;

    const sent = liveness.publishDelta({
      session: "conv-1",
      run: 4,
      turn: "turn-1",
      message_id: "msg-1",
      delta_seq: 1,
      text: "Hello",
    });
    expect(sent).toBe(true);

    const deltaFrames = socket.sent
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.type === "token_delta");
    expect(deltaFrames).toEqual([
      {
        v: RELAY_PROTOCOL_VERSION,
        type: "token_delta",
        hub: { kind: "session", id: "viewer:conv-1" },
        run: 4,
        turn: "turn-1",
        message_id: "msg-1",
        delta_seq: 1,
        text: "Hello",
      },
    ]);

    expect(
      liveness.publishDelta({
        session: "conv-1",
        run: 99,
        turn: "turn-1",
        message_id: "msg-1",
        delta_seq: 2,
        text: "stale-run",
      }),
    ).toBe(false);

    yield* Fiber.interrupt(fiber);
  }),
);

it.effect(
  "publishDelta fails open when relay socket is closed or refuses send",
  () =>
    Effect.gen(function* () {
      FakeRelaySocket.instances = [];
      const { transport } = makeTransport(["relay_token_deltas"]);
      const BrokenSocket = class extends FakeRelaySocket {
        override send() {
          throw new Error("socket down");
        }
      };
      const liveness = makeRelayLiveness(
        {
          transport,
          hello: {
            machine: "machine-1",
            boot: "boot-1",
            providers: [{ name: "codex", version: "1.0.0" }],
            runtimes: [{ host: "daemon", isolation: "app-server" }],
            capacity: {
              memory_total_bytes: 0,
              memory_available_bytes: 0,
              live_agents: 1,
            },
          },
          sessionLiveness: false,
          tokenDeltas: true,
          WebSocket: BrokenSocket as unknown as RelayClientOptions["WebSocket"],
        },
        [lease],
      );

      const fiber = yield* Layer.build(liveness.layer).pipe(
        Effect.andThen(Effect.never),
        Effect.forkScoped,
      );
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 10)),
      );

      expect(
        liveness.publishDelta({
          session: "conv-1",
          run: 4,
          turn: "turn-1",
          message_id: "msg-1",
          delta_seq: 1,
          text: "Hello",
        }),
      ).toBe(false);

      yield* Fiber.interrupt(fiber);
    }),
);
