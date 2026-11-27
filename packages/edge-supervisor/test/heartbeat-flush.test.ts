import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import {
  HEARTBEAT_FLUSH_INTERVAL_MS,
  type AgentStatus,
} from "@codecast/sessions/agentStatus";
import * as Effect from "effect/Effect";
import { adjust } from "effect/testing/TestClock";
import {
  HeartbeatFlush,
  type HeartbeatFlushHost,
  type HeartbeatSessionPayload,
} from "../src/effect";

type TestHost = HeartbeatFlushHost & {
  batches: Array<ReadonlyArray<HeartbeatSessionPayload>>;
  logs: string[];
  statuses: Map<string, AgentStatus>;
  panes: Set<string>;
  parked: Set<string>;
  alive: Set<string>;
  owned: Set<string>;
  unknownNext: string[];
  failNext: boolean;
  beforeCount: number;
};

function makeHost(overrides: Partial<HeartbeatFlushHost> = {}): TestHost {
  const batches: Array<ReadonlyArray<HeartbeatSessionPayload>> = [];
  const logs: string[] = [];
  const statuses = new Map<string, AgentStatus>();
  const panes = new Set<string>();
  const parked = new Set<string>();
  const alive = new Set<string>();
  const owned = new Set<string>();
  const sessions = new Set<string>();
  const host: TestHost = {
    batches,
    logs,
    statuses,
    panes,
    parked,
    alive,
    owned,
    unknownNext: [],
    failNext: false,
    beforeCount: 0,
    log: (message: string) => logs.push(message),
    isReady: () => true,
    sessions,
    currentSessions: () => [...sessions].filter((id) => !owned.has(id)),
    agentStatus: (id: string) => statuses.get(id),
    isParked: (id: string) => parked.has(id),
    hasPane: (id: string) => panes.has(id),
    isProcessAlive: (id: string) => alive.has(id),
    isOwnedOrSuperseded: (id: string) => owned.has(id),
    beforeFlush: () => {
      host.beforeCount++;
    },
    sendBatch: async (payload) => {
      batches.push(payload);
      if (host.failNext) {
        host.failNext = false;
        throw new Error("network down");
      }
      if (host.unknownNext.length > 0) return { unknown: host.unknownNext };
    },
    ...overrides,
  };
  return host;
}

it.effect(
  "arms on first session, batches by 25 on TestClock ticks, and stops when scope closes",
  () =>
    Effect.gen(function* () {
      const host = makeHost();
      for (let i = 0; i < 26; i++) host.statuses.set(`s-${i}`, "working");

      yield* Effect.gen(function* () {
        const service = yield* HeartbeatFlush;
        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        expect(host.batches).toEqual([]);

        for (let i = 0; i < 26; i++) yield* service.ensureSession(`s-${i}`);
        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS - 1);
        expect(host.batches).toEqual([]);

        yield* adjust(1);
        expect(host.batches).toHaveLength(2);
        expect(host.batches[0]).toHaveLength(25);
        expect(host.batches[1]).toHaveLength(1);
        expect(host.batches[0][0]).toEqual({
          session_id: "s-0",
          agent_status: "working",
          client_ts: HEARTBEAT_FLUSH_INTERVAL_MS * 2 - 1 + 1,
        });
        expect(host.beforeCount).toBe(1);
      }).pipe(Effect.provide(HeartbeatFlush.layer(host)));

      const flushedAtClose = host.batches.length;
      yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS * 3);
      expect(host.batches).toHaveLength(flushedAtClose);
    }),
);

it.effect(
  "prunes dead transcript beats and drops disowned sessions after three strikes unless parked",
  () =>
    Effect.gen(function* () {
      const host = makeHost();
      host.alive.add("t-alive");
      host.parked.add("t-parked");
      host.statuses.set("t-alive", "working");
      host.statuses.set("t-parked", "hibernated");
      host.statuses.set("owned-1", "working");

      yield* Effect.gen(function* () {
        const service = yield* HeartbeatFlush;
        yield* service.ensureSession("t-dead", "transcript");
        yield* service.ensureSession("t-alive", "transcript");
        yield* service.ensureSession("t-parked", "transcript");
        yield* service.ensureSession("owned-1");
        yield* service.ensureSession("owned-1");
        host.owned.add("ignored");
        yield* service.ensureSession("ignored");
        expect(host.sessions.has("ignored")).toBe(false);

        host.unknownNext = ["t-alive", "t-parked"];
        yield* adjust(0);
        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 0)));
        expect(host.batches).toHaveLength(1);
        expect(host.sessions.has("t-dead")).toBe(false);
        expect(host.sessions.has("t-alive")).toBe(true);
        expect(host.sessions.has("t-parked")).toBe(true);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 0)));
        expect(host.batches).toHaveLength(2);
        expect(host.sessions.has("t-alive")).toBe(true);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 0)));
        expect(host.batches).toHaveLength(3);
        expect(host.sessions.has("t-alive")).toBe(false);
        expect(host.sessions.has("t-parked")).toBe(true);
        expect(
          host.logs.some((line) =>
            line.includes("stopped beating 1 session(s) whose process exited"),
          ),
        ).toBe(true);
        expect(
          host.logs.some((line) =>
            line.includes(
              "stopped beating 1 session(s) the server has no row for",
            ),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(HeartbeatFlush.layer(host)));
    }),
);

it.effect(
  "throttles status logs to 5 minutes, logs transitions immediately, and handles batch errors",
  () =>
    Effect.gen(function* () {
      const host = makeHost();
      host.statuses.set("session-1234", "working");

      yield* Effect.gen(function* () {
        const service = yield* HeartbeatFlush;
        yield* service.ensureSession("session-1234");
        yield* adjust(0);
        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        expect(
          host.logs.filter((line) => line.startsWith("[HEARTBEAT] session=")),
        ).toEqual(["[HEARTBEAT] session=session- status=working stuck=0s"]);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        expect(
          host.logs.filter((line) => line.startsWith("[HEARTBEAT] session=")),
        ).toHaveLength(1);

        yield* adjust(5 * 60 * 1000);
        yield* adjust(0);
        expect(
          host.logs.filter((line) => line.startsWith("[HEARTBEAT] session=")),
        ).toEqual([
          "[HEARTBEAT] session=session- status=working stuck=0s",
          "[HEARTBEAT] session=session- status=working stuck=300s",
        ]);

        host.statuses.set("session-1234", "idle");
        host.failNext = true;
        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* adjust(0);
        expect(
          host.logs.filter((line) => line.startsWith("[HEARTBEAT] session=")),
        ).toEqual([
          "[HEARTBEAT] session=session- status=working stuck=0s",
          "[HEARTBEAT] session=session- status=working stuck=300s",
          "[HEARTBEAT] session=session- status=idle stuck=0s",
        ]);
        expect(
          host.logs.some((line) =>
            line.includes("batch of 1 failed: network down"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(HeartbeatFlush.layer(host)));
    }),
);

it.effect(
  "runs maintenance off the send path so a hung maintenance pass does not delay flushes",
  () =>
    Effect.gen(function* () {
      let releaseMaintenance!: () => void;
      let maintenanceStarts = 0;
      const host = makeHost({
        onTick: () => {
          maintenanceStarts++;
          return new Promise<void>((resolve) => {
            releaseMaintenance = resolve;
          });
        },
      });

      yield* Effect.gen(function* () {
        const service = yield* HeartbeatFlush;
        yield* service.ensureSession("s1");

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* adjust(0);
        expect(host.batches).toHaveLength(1);
        expect(maintenanceStarts).toBe(1);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* adjust(0);
        expect(host.batches).toHaveLength(2);
        expect(maintenanceStarts).toBe(1);

        releaseMaintenance();
        yield* adjust(0);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        yield* adjust(0);
        expect(host.batches).toHaveLength(3);
        expect(maintenanceStarts).toBe(2);
      }).pipe(Effect.provide(HeartbeatFlush.layer(host)));
    }),
);

it.effect(
  "logs a starvation warning when more than 2x interval elapses between sends",
  () =>
    Effect.gen(function* () {
      let releaseFirst!: () => void;
      let calls = 0;
      const host = makeHost({
        sendBatch: () => {
          calls++;
          if (calls === 1) {
            return new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return Promise.resolve();
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* HeartbeatFlush;
        yield* service.ensureSession("s1");
        yield* adjust(0);
        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        expect(calls).toBe(1);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS * 2 + 5_000);
        releaseFirst();
        yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 0)));

        yield* service.flushNow();
        expect(
          host.logs.some(
            (line) =>
              line.includes("WARNING:") &&
              line.includes("liveness sends are being starved"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(HeartbeatFlush.layer(host)));
    }),
);

it.effect(
  "keeps fixed 30s start-to-start cadence when a flush hangs for 35s and still runs maintenance",
  () =>
    Effect.gen(function* () {
      let releaseFirstFlush!: () => void;
      let flushCalls = 0;
      let maintenanceCalls = 0;
      const host = makeHost({
        sendBatch: () => {
          flushCalls++;
          if (flushCalls === 1) {
            return new Promise<void>((resolve) => {
              releaseFirstFlush = resolve;
            });
          }
          return Promise.resolve();
        },
        onTick: async () => {
          maintenanceCalls++;
        },
      });

      yield* Effect.gen(function* () {
        const service = yield* HeartbeatFlush;
        yield* service.ensureSession("s1");
        yield* adjust(0);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        expect(flushCalls).toBe(1);
        expect(maintenanceCalls).toBe(1);

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS);
        expect(flushCalls).toBe(1);
        expect(maintenanceCalls).toBe(2);

        yield* adjust(5_000);
        releaseFirstFlush();
        yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 0)));

        yield* adjust(HEARTBEAT_FLUSH_INTERVAL_MS - 5_000);
        expect(flushCalls).toBe(2);
        expect(maintenanceCalls).toBe(3);
      }).pipe(Effect.provide(HeartbeatFlush.layer(host)));
    }),
);
