import type { RelayHub } from "@codecast/relay-contract";
import { Clock } from "effect/Clock";
import * as Effect from "effect/Effect";
import { Relay, type RelayConnection } from "../src/index";
import { claims, harness, token } from "./fixtures";

const hubs = 200;
const subscribers = 5;
const rounds = 100;

function memory() {
  Bun.gc(true);
  const { heapUsed, rss } = process.memoryUsage();
  return { heapUsed, rss };
}

await Effect.runPromise(
  harness(
    Effect.gen(function* () {
      const relay = yield* Relay;
      const clock = yield* Clock;
      const now = clock.currentTimeMillisUnsafe();
      let signals = 0;
      const baseline = memory();
      const bootCpu = process.cpuUsage();
      const bootStart = performance.now();
      const publishers: Array<{ connection: RelayConnection; signal: string }> =
        [];
      for (let index = 0; index < hubs; index++) {
        const hub: RelayHub = { kind: "session", id: `session-${index}` };
        for (let slot = 0; slot < subscribers; slot++) {
          const connection = yield* relay.open({
            send(text) {
              if (text.includes('"type":"presence"')) signals++;
              return "sent";
            },
            close: () => undefined,
            terminate: () => undefined,
          });
          if (!connection) throw new Error("Load connection refused");
          yield* connection.receive(
            JSON.stringify({
              type: "connect",
              versions: [1],
              capabilities: ["presence"],
              token: token(
                claims({
                  subject: { kind: "user", id: `user-${index}-${slot}` },
                  issued_at_ms: now,
                  expires_at_ms: now + 60_000,
                  grants: [{ ...hub, publish: slot === 0 ? ["presence"] : [] }],
                }),
              ),
            }),
          );
          yield* connection.receive(
            JSON.stringify({ type: "subscribe", v: 1, hub }),
          );
          if (slot === 0)
            publishers.push({
              connection,
              signal: JSON.stringify({
                type: "presence",
                v: 1,
                hub,
                state: "active",
                in_draft: false,
              }),
            });
        }
      }
      const bootMs = performance.now() - bootStart;
      const boot = process.cpuUsage(bootCpu);
      const loaded = memory();

      const latencies: number[] = [];
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();
      for (let round = 0; round < rounds; round++) {
        for (const { connection, signal } of publishers) {
          const start = performance.now();
          yield* connection.receive(signal);
          latencies.push(performance.now() - start);
        }
      }
      const wallMs = performance.now() - wallStart;
      const { user, system } = process.cpuUsage(cpuStart);
      if (signals !== hubs * subscribers * rounds) {
        throw new Error(
          `Expected ${hubs * subscribers * rounds} deliveries, observed ${signals}`,
        );
      }
      latencies.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          hubs,
          subscribersPerHub: subscribers,
          rounds,
          signals,
          bootMs,
          bootCpuMs: (boot.user + boot.system) / 1000,
          heapDeltaBytes: loaded.heapUsed - baseline.heapUsed,
          rssDeltaBytes: loaded.rss - baseline.rss,
          wallMs,
          cpuMs: (user + system) / 1000,
          p95PublishMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
        }),
      );
    }),
    { queueCapacity: 64, signalTtlMs: 15_000, handshakeMs: 5_000 },
  ),
);
