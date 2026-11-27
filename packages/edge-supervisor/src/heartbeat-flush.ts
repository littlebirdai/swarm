import {
  HEARTBEAT_FLUSH_INTERVAL_MS,
  deadTranscriptBeats,
  strikeUnknownBeats,
  type AgentStatus,
} from "@codecast/sessions/agentStatus";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

export type HeartbeatSessionPayload =
  | { session_id: string; agent_status: AgentStatus; client_ts: number }
  | { session_id: string };

export type HeartbeatLogEntry = {
  status: string;
  ts: number;
  since: number;
};

export type HeartbeatBatchSender = (
  payload: ReadonlyArray<HeartbeatSessionPayload>,
) => Promise<{ unknown?: readonly string[] } | void>;

export interface HeartbeatFlushHost {
  log(message: string): void;
  isReady(): boolean;
  sessions: Set<string>;
  currentSessions(): string[];
  agentStatus(sessionId: string): AgentStatus | undefined;
  isParked(sessionId: string): boolean;
  hasPane(sessionId: string): boolean;
  isProcessAlive(sessionId: string): boolean;
  isOwnedOrSuperseded(sessionId: string): boolean;
  sendBatch: HeartbeatBatchSender;
  prepareBatchSender?: () => HeartbeatBatchSender | null;
  beforeFlush?(): void;
  onTick?(): Promise<void>;
  lastLogged?: Map<string, HeartbeatLogEntry>;
  batchSize?: number;
  flushIntervalMs?: number;
  logThrottleMs?: number;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOG_THROTTLE_MS = 5 * 60 * 1000;

export class HeartbeatFlush extends Context.Service<
  HeartbeatFlush,
  {
    ensureSession(
      sessionId: string,
      source?: "transcript",
    ): Effect.Effect<void>;
    stopSession(sessionId: string | undefined): Effect.Effect<void>;
    arm(): Effect.Effect<void>;
    flushNow(): Effect.Effect<void>;
    tick(): Effect.Effect<void>;
    logStatus(
      sessionId: string,
      status: AgentStatus | undefined,
    ): Effect.Effect<void>;
  }
>()("@codecast/edge-supervisor/HeartbeatFlush") {
  static readonly noop = Layer.effect(
    HeartbeatFlush,
    Effect.sync(() =>
      HeartbeatFlush.of({
        ensureSession: () => Effect.void,
        stopSession: () => Effect.void,
        arm: () => Effect.void,
        flushNow: () => Effect.void,
        tick: () => Effect.void,
        logStatus: () => Effect.void,
      }),
    ),
  );

  static layer(host: HeartbeatFlushHost) {
    return Layer.effect(
      HeartbeatFlush,
      Effect.gen(function* () {
        const flushLock = yield* Semaphore.make(1);
        const membershipLock = yield* Semaphore.make(1);
        const armed = yield* Latch.make(
          host.isReady() && host.sessions.size > 0,
        );
        const transcriptSessions = new Set<string>();
        const unknownStrikes = new Map<string, number>();
        const lastLogged =
          host.lastLogged ?? new Map<string, HeartbeatLogEntry>();
        const batchSize = host.batchSize ?? DEFAULT_BATCH_SIZE;
        const flushIntervalMs =
          host.flushIntervalMs ?? HEARTBEAT_FLUSH_INTERVAL_MS;
        const logThrottleMs = host.logThrottleMs ?? DEFAULT_LOG_THROTTLE_MS;
        let lastSendAt: number | undefined;
        let flushInProgress = false;
        let maintenanceInProgress = false;

        const logStatus = Effect.fn("HeartbeatFlush.logStatus")(function* (
          sessionId: string,
          status: AgentStatus | undefined,
        ) {
          if (!status) return;
          const now = yield* Clock.currentTimeMillis;
          const prev = lastLogged.get(sessionId);
          const since = prev && prev.status === status ? prev.since : now;
          if (prev && prev.status === status && now - prev.ts < logThrottleMs)
            return;
          lastLogged.set(sessionId, { status, ts: now, since });
          const stuckSec = Math.round((now - since) / 1000);
          host.log(
            `[HEARTBEAT] session=${sessionId.slice(0, 8)} status=${status} stuck=${stuckSec}s`,
          );
        });

        const deleteSession = Effect.fn("HeartbeatFlush.deleteSession")(
          function* (sessionId: string | undefined) {
            if (!sessionId) return;
            host.sessions.delete(sessionId);
            transcriptSessions.delete(sessionId);
          },
        );

        const stopSession = Effect.fn("HeartbeatFlush.stopSession")(function* (
          sessionId: string | undefined,
        ) {
          yield* membershipLock.withPermit(deleteSession(sessionId));
        });

        const arm = Effect.fn("HeartbeatFlush.arm")(function* () {
          if (!host.isReady()) return;
          yield* Latch.open(armed);
        });

        const ensureSession = Effect.fn("HeartbeatFlush.ensureSession")(
          function* (sessionId: string, source?: "transcript") {
            yield* membershipLock.withPermit(
              Effect.gen(function* () {
                if (!host.isReady() || host.isOwnedOrSuperseded(sessionId))
                  return;
                if (source !== "transcript")
                  transcriptSessions.delete(sessionId);
                else if (!host.sessions.has(sessionId))
                  transcriptSessions.add(sessionId);
                host.sessions.add(sessionId);
                yield* arm();
              }),
            );
          },
        );

        const runFlush = Effect.fn("HeartbeatFlush.runFlush")(function* () {
          const sendBatch = host.prepareBatchSender
            ? host.prepareBatchSender()
            : host.isReady()
              ? host.sendBatch
              : null;
          if (!sendBatch) return;
          host.beforeFlush?.();
          const dead = deadTranscriptBeats(transcriptSessions, {
            hasPane: host.hasPane,
            parked: host.isParked,
            processAlive: host.isProcessAlive,
          });
          for (const id of dead) yield* stopSession(id);
          if (dead.length > 0)
            host.log(
              `[HEARTBEAT-FLUSH] stopped beating ${dead.length} session(s) whose process exited`,
            );

          const ids = host.currentSessions();
          const now = yield* Clock.currentTimeMillis;
          if (
            lastSendAt !== undefined &&
            now - lastSendAt > flushIntervalMs * 2
          ) {
            host.log(
              `[HEARTBEAT-FLUSH] WARNING: ${Math.round((now - lastSendAt) / 1000)}s since last send (interval ${flushIntervalMs / 1000}s) — liveness sends are being starved`,
            );
          }
          lastSendAt = now;

          const batchCount = Math.ceil(ids.length / batchSize);
          for (let i = 0; i < ids.length; i += batchSize) {
            const slice = ids.slice(i, i + batchSize);
            const payload: HeartbeatSessionPayload[] = [];
            for (const sessionId of slice) {
              const status = host.agentStatus(sessionId);
              yield* logStatus(sessionId, status);
              payload.push(
                status
                  ? {
                      session_id: sessionId,
                      agent_status: status,
                      client_ts: now,
                    }
                  : { session_id: sessionId },
              );
            }
            const outcome = yield* Effect.result(
              Effect.tryPromise({
                try: () => sendBatch(payload),
                catch: (error) => error,
              }),
            );
            if (outcome._tag === "Failure") {
              const err = outcome.failure;
              host.log(
                `[HEARTBEAT-FLUSH] batch of ${payload.length} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              continue;
            }
            const answer = outcome.success;
            const disowned = strikeUnknownBeats(
              unknownStrikes,
              payload.map((p) => p.session_id),
              answer?.unknown,
            ).filter((id) => !host.isParked(id));
            for (const id of disowned) yield* stopSession(id);
            if (disowned.length > 0)
              host.log(
                `[HEARTBEAT-FLUSH] stopped beating ${disowned.length} session(s) the server has no row for`,
              );
          }
          host.log(
            `[HEARTBEAT-FLUSH] sessions=${ids.length} batches=${batchCount}`,
          );
        });

        const flushNow = Effect.fn("HeartbeatFlush.flushNow")(function* () {
          yield* flushLock.withPermit(runFlush());
        });

        const tick = Effect.fn("HeartbeatFlush.tick")(function* () {
          if (!host.isReady() || host.sessions.size === 0) return;
          if (!flushInProgress) {
            flushInProgress = true;
            yield* Effect.forkChild(
              flushLock.withPermit(runFlush()).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    flushInProgress = false;
                  }),
                ),
              ),
              { startImmediately: true },
            );
          }
          if (host.onTick && !maintenanceInProgress) {
            maintenanceInProgress = true;
            yield* Effect.forkChild(
              Effect.tryPromise(() => host.onTick!()).pipe(
                Effect.catch(() => Effect.void),
                Effect.ensuring(
                  Effect.sync(() => {
                    maintenanceInProgress = false;
                  }),
                ),
              ),
              { startImmediately: true },
            );
          }
        });

        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* armed.await;
            yield* Effect.sleep(flushIntervalMs);
            yield* Effect.repeat(tick(), Schedule.fixed(flushIntervalMs));
          }),
          { startImmediately: true },
        );

        return HeartbeatFlush.of({
          ensureSession,
          stopSession,
          arm,
          flushNow,
          tick,
          logStatus,
        });
      }),
    );
  }
}
