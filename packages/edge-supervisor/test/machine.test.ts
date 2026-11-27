import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { adjust } from "effect/testing/TestClock";
import {
  Machine,
  MachineLive,
  Watchdog,
  type LinkSettings,
} from "../src/effect";

const link: LinkSettings = {
  bearer: "test-token",
  siteUrl: "https://edge.invalid",
  hello: {
    machine: "machine",
    boot: "boot",
    versions: [1],
    capabilities: ["heartbeat"],
    providers: [],
    runtimes: [],
    capacity: {
      memory_total_bytes: 10,
      memory_available_bytes: 5,
      live_agents: 1,
    },
  },
};

function welcome(revision = 1) {
  return {
    status: 200,
    body: {
      status: "ok",
      version: 1,
      policy: {
        revision,
        heartbeat_interval_ms: 1_000,
        uplink_interval_ms: 250,
        limits: {
          max_batch_events: 100,
          max_batch_bytes: 1000,
          max_blob_bytes: 1000,
        },
        capabilities: ["heartbeat"],
      },
    },
  };
}

const heartbeat = (revision = 1) => ({
  status: 200,
  body: { v: 1, policy_revision: revision },
});

it.effect("a link defect restarts only the failed link", () =>
  Effect.gen(function* () {
    let links = 0;
    let watchdogRuns = 0;
    let watchdogSamples = 0;
    const calls: string[] = [];
    const logs: string[] = [];
    const watchdog = Layer.effect(
      Watchdog,
      Effect.sync(() => {
        watchdogRuns++;
        return Watchdog.of({
          run: Effect.forever(
            Effect.sleep(100).pipe(
              Effect.tap(() => Effect.sync(() => watchdogSamples++)),
            ),
          ),
        });
      }),
    );
    yield* Effect.gen(function* () {
      const machine = yield* Machine;
      yield* machine.connect(link);
      yield* adjust(0);
      yield* adjust(1_000);
      expect(calls).toEqual(["hello", "heartbeat"]);
      expect(links).toBe(1);
      const samplesAtFailure = watchdogSamples;
      yield* adjust(29_999);
      expect(links).toBe(1);
      expect(watchdogSamples).toBeGreaterThan(samplesAtFailure);
      yield* adjust(1_001);
      expect(links).toBe(2);
      expect(calls).toEqual(["hello", "heartbeat", "hello", "heartbeat"]);
      expect(watchdogRuns).toBe(1);
      expect(logs).toEqual(["[EDGE] Restarting link"]);
    }).pipe(
      Effect.provide(
        MachineLive(
          { log: (message) => logs.push(message) },
          {
            watchdog,
            transport: () => {
              const generation = ++links;
              return async (operation) => {
                calls.push(operation);
                if (operation === "hello") return welcome();
                if (generation === 1) throw new Error("transport defect");
                return heartbeat();
              };
            },
          },
        ),
      ),
    );
  }),
);

it.effect("closing the machine stops the heartbeat and watchdog fibers", () =>
  Effect.gen(function* () {
    let requests = 0;
    let heartbeatsAborted = 0;
    let watchdogTicks = 0;
    let watchdogStopped = false;
    const watchdog = Layer.succeed(
      Watchdog,
      Watchdog.of({
        run: Effect.forever(
          Effect.sleep(100).pipe(
            Effect.tap(() => Effect.sync(() => watchdogTicks++)),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              watchdogStopped = true;
            }),
          ),
        ),
      }),
    );
    yield* Effect.gen(function* () {
      const machine = yield* Machine;
      yield* machine.connect(link);
      yield* adjust(0);
      yield* adjust(1_000);
      expect(requests).toBe(1);
      expect(heartbeatsAborted).toBe(0);
      expect(watchdogTicks).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        MachineLive(
          { log: () => {} },
          {
            watchdog,
            transport: () => async (operation, _, signal) => {
              if (operation === "hello") return welcome();
              requests++;
              return new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    heartbeatsAborted++;
                    reject(signal.reason);
                  },
                  { once: true },
                );
              });
            },
          },
        ),
      ),
    );
    expect(heartbeatsAborted).toBe(1);
    expect(watchdogStopped).toBe(true);
    const stoppedAt = watchdogTicks;
    yield* adjust(60_000);
    expect(requests).toBe(1);
    expect(watchdogTicks).toBe(stoppedAt);
  }),
);

it.effect(
  "a policy revision and a new credential each negotiate a new link",
  () =>
    Effect.gen(function* () {
      const transports: string[] = [];
      const calls: string[] = [];
      let policy = 1;
      yield* Effect.gen(function* () {
        const machine = yield* Machine;
        yield* machine.connect(link);
        yield* adjust(0);
        yield* adjust(100);
        yield* machine.connect({ ...link });
        yield* adjust(100);
        expect(transports).toEqual(["test-token"]);
        policy = 2;
        yield* adjust(800);
        expect(calls).toEqual(["hello", "heartbeat", "hello"]);
        expect(transports).toEqual(["test-token", "test-token"]);
        yield* machine.connect({ ...link, bearer: "new-token" });
        yield* adjust(0);
        yield* adjust(1_000);
        expect(transports).toEqual(["test-token", "test-token", "new-token"]);
        expect(calls).toEqual([
          "hello",
          "heartbeat",
          "hello",
          "hello",
          "heartbeat",
        ]);
      }).pipe(
        Effect.provide(
          MachineLive(
            { log: () => {} },
            {
              transport: ({ bearer }) => {
                transports.push(bearer);
                return async (operation) => {
                  calls.push(operation);
                  return operation === "hello"
                    ? welcome(policy)
                    : heartbeat(policy);
                };
              },
            },
          ),
        ),
      );
    }),
);

it.effect(
  "MachineLive runs HeartbeatFlush on a scoped fiber and stops it on close",
  () =>
    Effect.gen(function* () {
      const sessions = new Set<string>();
      const batches: Array<ReadonlyArray<{ session_id: string }>> = [];
      yield* Effect.gen(function* () {
        const machine = yield* Machine;
        yield* machine.ensureSessionHeartbeat("session-a");
        yield* adjust(30_000);
        expect(batches).toEqual([[{ session_id: "session-a" }]]);
        yield* machine.stopSessionHeartbeat("session-a");
        yield* adjust(30_000);
        expect(batches).toHaveLength(1);
      }).pipe(
        Effect.provide(
          MachineLive({
            log: () => {},
            heartbeatFlush: {
              log: () => {},
              isReady: () => true,
              sessions,
              currentSessions: () => [...sessions],
              agentStatus: () => undefined,
              isParked: () => false,
              hasPane: () => true,
              isProcessAlive: () => true,
              isOwnedOrSuperseded: () => false,
              sendBatch: async (payload) => {
                batches.push(payload);
              },
            },
          }),
        ),
      );
      yield* adjust(60_000);
      expect(batches).toHaveLength(1);
    }),
);
