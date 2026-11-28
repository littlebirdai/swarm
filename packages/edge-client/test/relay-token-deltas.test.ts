import type { RelayClientOptions } from "@codecast/relay-client";
import {
  RELAY_MAX_GRANTS_PER_TOKEN,
  RELAY_MAX_HUBS_PER_CONNECTION,
  RELAY_PROTOCOL_VERSION,
} from "@codecast/relay-contract";
import { expect } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { it } from "@codecast/effect-kit/effect/testing";
import { makeRelayLiveness, type RunLease } from "../src/relay-liveness-layer";
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

function makeLease(session = "conv-1", run = 4): RunLease {
  return {
    session,
    run,
    fencing_token: `fence-${session}-${run}`,
    deadline: Math.ceil(performance.now()) + 60_000,
  };
}

function makeTransport(
  capabilities: readonly string[],
  onGrantRequest?: () => void,
): {
  transport: EdgeTransport;
  helloCapabilities: string[][];
  grantRequests: Array<{
    sessions: Array<{ session: string; run: number; fencing_token: string }>;
    token_deltas?: boolean;
  }>;
} {
  const helloCapabilities: string[][] = [];
  const grantRequests: Array<{
    sessions: Array<{ session: string; run: number; fencing_token: string }>;
    token_deltas?: boolean;
  }> = [];
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
        token_deltas?: boolean;
      };
      grantRequests.push({
        sessions: [...grantReq.sessions],
        ...(grantReq.token_deltas !== undefined
          ? { token_deltas: grantReq.token_deltas }
          : {}),
      });
      onGrantRequest?.();
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
  return { transport, helloCapabilities, grantRequests };
}

it.effect("negotiates token_delta capability and publishes frames", () =>
  Effect.gen(function* () {
    FakeRelaySocket.instances = [];
    const granted = yield* Deferred.make<void>();
    const { transport, helloCapabilities, grantRequests } = makeTransport(
      ["relay_session_liveness", "relay_token_deltas"],
      () => Effect.runSync(Deferred.succeed(granted, undefined)),
    );
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
      [makeLease()],
    );

    const fiber = yield* Layer.build(liveness.layer).pipe(
      Effect.andThen(Effect.never),
      Effect.forkScoped,
    );
    yield* Deferred.await(granted);
    yield* Effect.yieldNow;

    expect(helloCapabilities).toEqual([
      ["relay_session_liveness", "relay_token_deltas"],
    ]);
    expect(grantRequests).toEqual([
      {
        sessions: [
          { session: "conv-1", run: 4, fencing_token: "fence-conv-1-4" },
        ],
        token_deltas: true,
      },
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
  "preserves 256 session cap without deltas and batches both-grant requests at half max grants",
  () =>
    Effect.gen(function* () {
      FakeRelaySocket.instances = [];
      const livenessOnlyDone = yield* Deferred.make<void>();
      const livenessLeases = Array.from({ length: 20 }, (_, i) =>
        makeLease(`s-${i}`, 1),
      );
      const livenessOnly = makeTransport(
        ["relay_session_liveness", "relay_token_deltas"],
        () => Effect.runSync(Deferred.succeed(livenessOnlyDone, undefined)),
      );
      const onlyLiveness = makeRelayLiveness(
        {
          transport: livenessOnly.transport,
          hello: {
            machine: "machine-1",
            boot: "boot-1",
            providers: [{ name: "codex", version: "1.0.0" }],
            runtimes: [{ host: "daemon", isolation: "app-server" }],
            capacity: {
              memory_total_bytes: 0,
              memory_available_bytes: 0,
              live_agents: 20,
            },
          },
          WebSocket:
            FakeRelaySocket as unknown as RelayClientOptions["WebSocket"],
        },
        livenessLeases,
      );

      const fiber1 = yield* Layer.build(onlyLiveness.layer).pipe(
        Effect.andThen(Effect.never),
        Effect.forkScoped,
      );
      yield* Deferred.await(livenessOnlyDone);
      yield* Effect.yieldNow;
      expect(livenessOnly.grantRequests[0]?.token_deltas).toBeUndefined();
      expect(livenessOnly.grantRequests[0]?.sessions).toHaveLength(
        RELAY_MAX_GRANTS_PER_TOKEN,
      );
      yield* Fiber.interrupt(fiber1);

      const bothDone = yield* Deferred.make<void>();
      const manyLeases = Array.from(
        { length: RELAY_MAX_HUBS_PER_CONNECTION },
        (_, i) => makeLease(`both-${i}`, 1),
      );
      const bothTransport = makeTransport(
        ["relay_session_liveness", "relay_token_deltas"],
        () => Effect.runSync(Deferred.succeed(bothDone, undefined)),
      );
      const bothLiveness = makeRelayLiveness(
        {
          transport: bothTransport.transport,
          hello: {
            machine: "machine-1",
            boot: "boot-1",
            providers: [{ name: "codex", version: "1.0.0" }],
            runtimes: [{ host: "daemon", isolation: "app-server" }],
            capacity: {
              memory_total_bytes: 0,
              memory_available_bytes: 0,
              live_agents: 20,
            },
          },
          tokenDeltas: true,
          WebSocket:
            FakeRelaySocket as unknown as RelayClientOptions["WebSocket"],
        },
        manyLeases,
      );

      const fiber2 = yield* Layer.build(bothLiveness.layer).pipe(
        Effect.andThen(Effect.never),
        Effect.forkScoped,
      );
      yield* Deferred.await(bothDone);
      yield* Effect.yieldNow;

      expect(bothTransport.grantRequests[0]?.token_deltas).toBe(true);
      expect(bothTransport.grantRequests[0]?.sessions).toHaveLength(
        Math.floor(RELAY_MAX_GRANTS_PER_TOKEN / 2),
      );
      yield* Fiber.interrupt(fiber2);
    }),
);

it.effect(
  "publishDelta fails open when relay socket is closed or refuses send",
  () =>
    Effect.gen(function* () {
      FakeRelaySocket.instances = [];
      const granted = yield* Deferred.make<void>();
      const { transport } = makeTransport(["relay_token_deltas"], () =>
        Effect.runSync(Deferred.succeed(granted, undefined)),
      );
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
        [makeLease()],
      );

      const fiber = yield* Layer.build(liveness.layer).pipe(
        Effect.andThen(Effect.never),
        Effect.forkScoped,
      );
      yield* Deferred.await(granted);
      yield* Effect.yieldNow;

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
