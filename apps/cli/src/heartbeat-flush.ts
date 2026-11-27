import {
  HEARTBEAT_FLUSH_INTERVAL_MS,
  deadTranscriptBeats,
  strikeUnknownBeats,
  type AgentStatus,
} from "@codecast/sessions/agentStatus";
import type {
  HeartbeatFlushHost,
  HeartbeatLogEntry,
  HeartbeatSessionPayload,
  MachineSupervisor,
} from "@codecast/edge-supervisor";

export type LegacyHeartbeatFlushHost = HeartbeatFlushHost & {
  scheduleInterval(fn: () => void, ms: number): NodeJS.Timeout;
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOG_THROTTLE_MS = 5 * 60 * 1000;

export function createHeartbeatFlushController(host: LegacyHeartbeatFlushHost) {
  const transcriptHeartbeatSessions = new Set<string>();
  const unknownBeatStrikes = new Map<string, number>();
  const lastLogged = host.lastLogged ?? new Map<string, HeartbeatLogEntry>();
  const batchSize = host.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = host.flushIntervalMs ?? HEARTBEAT_FLUSH_INTERVAL_MS;
  const logThrottleMs = host.logThrottleMs ?? DEFAULT_LOG_THROTTLE_MS;
  let heartbeatFlushTimer: NodeJS.Timeout | null = null;
  let heartbeatFlushInProgress = false;
  let heartbeatMaintenanceInProgress = false;
  let lastHeartbeatSendAt = 0;

  function logHeartbeatStatus(
    sessionId: string,
    status: AgentStatus | undefined,
  ): void {
    if (!status) return;
    const now = Date.now();
    const prev = lastLogged.get(sessionId);
    const since = prev && prev.status === status ? prev.since : now;
    if (prev && prev.status === status && now - prev.ts < logThrottleMs) return;
    lastLogged.set(sessionId, { status, ts: now, since });
    const stuckSec = Math.round((now - since) / 1000);
    host.log(
      `[HEARTBEAT] session=${sessionId.slice(0, 8)} status=${status} stuck=${stuckSec}s`,
    );
  }

  function stopSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    host.sessions.delete(sessionId);
    transcriptHeartbeatSessions.delete(sessionId);
  }

  function pruneDeadTranscriptHeartbeats(): void {
    const dead = deadTranscriptBeats(transcriptHeartbeatSessions, {
      hasPane: host.hasPane,
      parked: host.isParked,
      processAlive: host.isProcessAlive,
    });
    for (const id of dead) stopSession(id);
    if (dead.length > 0)
      host.log(
        `[HEARTBEAT-FLUSH] stopped beating ${dead.length} session(s) whose process exited`,
      );
  }

  function ensureLoop(): void {
    if (heartbeatFlushTimer || !host.isReady()) return;
    heartbeatFlushTimer = host.scheduleInterval(() => {
      void flushManagedHeartbeats();
    }, flushIntervalMs);
  }

  function ensureSession(sessionId: string, source?: "transcript"): void {
    if (!host.isReady() || host.isOwnedOrSuperseded(sessionId)) return;
    if (source !== "transcript") transcriptHeartbeatSessions.delete(sessionId);
    else if (!host.sessions.has(sessionId))
      transcriptHeartbeatSessions.add(sessionId);
    host.sessions.add(sessionId);
    ensureLoop();
  }

  async function flushManagedHeartbeats(): Promise<void> {
    if (!host.isReady() || host.sessions.size === 0) return;
    if (!heartbeatFlushInProgress) {
      heartbeatFlushInProgress = true;
      try {
        await runHeartbeatFlush();
      } finally {
        heartbeatFlushInProgress = false;
      }
    }
    if (host.onTick && !heartbeatMaintenanceInProgress) {
      heartbeatMaintenanceInProgress = true;
      void host
        .onTick()
        .catch(() => {})
        .finally(() => {
          heartbeatMaintenanceInProgress = false;
        });
    }
  }

  async function runHeartbeatFlush(): Promise<void> {
    const sendBatch = host.prepareBatchSender
      ? host.prepareBatchSender()
      : host.isReady()
        ? host.sendBatch
        : null;
    if (!sendBatch) return;
    host.beforeFlush?.();
    pruneDeadTranscriptHeartbeats();
    const ids = host.currentSessions();
    const now = Date.now();
    if (
      lastHeartbeatSendAt &&
      now - lastHeartbeatSendAt > flushIntervalMs * 2
    ) {
      host.log(
        `[HEARTBEAT-FLUSH] WARNING: ${Math.round((now - lastHeartbeatSendAt) / 1000)}s since last send (interval ${flushIntervalMs / 1000}s) — liveness sends are being starved`,
      );
    }
    lastHeartbeatSendAt = now;
    const batchCount = Math.ceil(ids.length / batchSize);
    for (let i = 0; i < ids.length; i += batchSize) {
      const payload: HeartbeatSessionPayload[] = ids
        .slice(i, i + batchSize)
        .map((sessionId) => {
          const status = host.agentStatus(sessionId);
          logHeartbeatStatus(sessionId, status);
          return status
            ? { session_id: sessionId, agent_status: status, client_ts: now }
            : { session_id: sessionId };
        });
      try {
        const answer = await sendBatch(payload);
        const disowned = strikeUnknownBeats(
          unknownBeatStrikes,
          payload.map((p) => p.session_id),
          answer?.unknown,
        ).filter((id) => !host.isParked(id));
        for (const id of disowned) stopSession(id);
        if (disowned.length > 0)
          host.log(
            `[HEARTBEAT-FLUSH] stopped beating ${disowned.length} session(s) the server has no row for`,
          );
      } catch (err) {
        host.log(
          `[HEARTBEAT-FLUSH] batch of ${payload.length} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    host.log(`[HEARTBEAT-FLUSH] sessions=${ids.length} batches=${batchCount}`);
  }

  function stopLoop(): void {
    if (!heartbeatFlushTimer) return;
    clearInterval(heartbeatFlushTimer);
    heartbeatFlushTimer = null;
  }

  return {
    ensureSession,
    stopSession,
    ensureLoop,
    stopLoop,
    isLoopRunning: () => heartbeatFlushTimer !== null,
    runFlush: runHeartbeatFlush,
    flushTick: flushManagedHeartbeats,
  };
}

export function createHeartbeatSupervisorCoordinator(deps: {
  log: (msg: string) => void;
  createHost: () => LegacyHeartbeatFlushHost;
  getEdgeMachine: () => Promise<MachineSupervisor | undefined> | undefined;
  setEdgeMachine: (
    machine: Promise<MachineSupervisor | undefined> | undefined,
  ) => void;
}) {
  let legacyHeartbeatFlush:
    | ReturnType<typeof createHeartbeatFlushController>
    | undefined;
  let edgeSupervisorFailed = false;
  let edgeSupervisorStartFailureLogged = false;
  let edgeSupervisorStopped = false;
  let pendingSupervisedMembershipOps = 0;
  let heartbeatMembershipChain: Promise<void> = Promise.resolve();

  const isEdgeSupervisorEnabled = () =>
    process.env.CODECAST_EDGE_SUPERVISOR_V1 === "1";

  const shouldUseEdgeSupervisor = () =>
    Boolean(deps.getEdgeMachine()) ||
    (isEdgeSupervisorEnabled() && !edgeSupervisorFailed);

  const getLegacy = () =>
    (legacyHeartbeatFlush ??= createHeartbeatFlushController(
      deps.createHost(),
    ));

  function noteStartFailure(): void {
    if (!edgeSupervisorStartFailureLogged) {
      edgeSupervisorStartFailureLogged = true;
      deps.log("[EDGE] Supervisor start failed");
    }
    deps.setEdgeMachine(undefined);
    edgeSupervisorFailed = true;
  }

  function enqueueSupervisedOp(
    op: (machine: MachineSupervisor) => Promise<void>,
    fallback: () => void,
  ): void {
    pendingSupervisedMembershipOps++;
    heartbeatMembershipChain = heartbeatMembershipChain
      .then(async () => {
        if (edgeSupervisorStopped) return;
        const machinePromise = deps.getEdgeMachine();
        if (!machinePromise) {
          if (edgeSupervisorFailed && !edgeSupervisorStopped) fallback();
          return;
        }
        let machine: MachineSupervisor | undefined;
        try {
          machine = await machinePromise;
        } catch {
          noteStartFailure();
          if (!edgeSupervisorStopped) fallback();
          return;
        }
        if (!machine) {
          noteStartFailure();
          if (!edgeSupervisorStopped) fallback();
          return;
        }
        if (edgeSupervisorStopped) return;
        try {
          await op(machine);
        } catch (err) {
          if (!edgeSupervisorStopped) {
            deps.log(
              `[EDGE] Supervisor heartbeat op failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      })
      .finally(() => {
        pendingSupervisedMembershipOps--;
      });
  }

  function runMembershipOp(
    op: (machine: MachineSupervisor) => Promise<void>,
    legacy: () => void,
  ): void {
    if (edgeSupervisorStopped) return;
    if (shouldUseEdgeSupervisor()) {
      enqueueSupervisedOp(op, legacy);
      return;
    }
    if (pendingSupervisedMembershipOps > 0) {
      pendingSupervisedMembershipOps++;
      heartbeatMembershipChain = heartbeatMembershipChain
        .then(() => {
          if (!edgeSupervisorStopped) legacy();
        })
        .catch(() => {})
        .finally(() => {
          pendingSupervisedMembershipOps--;
        });
      return;
    }
    legacy();
  }

  return {
    shouldUseEdgeSupervisor,
    noteStartFailure,
    stopSession: (sessionId: string | undefined) => {
      if (!sessionId) return;
      runMembershipOp(
        (m) => m.stopSessionHeartbeat(sessionId),
        () => getLegacy().stopSession(sessionId),
      );
    },
    ensureSession: (sessionId: string, source?: "transcript") => {
      runMembershipOp(
        (m) => m.ensureSessionHeartbeat(sessionId, source),
        () => getLegacy().ensureSession(sessionId, source),
      );
    },
    ensureLoop: () => {
      runMembershipOp(
        (m) => m.armHeartbeatFlush(),
        () => getLegacy().ensureLoop(),
      );
    },
    runFlush: async () => {
      if (edgeSupervisorStopped) return;
      await heartbeatMembershipChain;
      if (edgeSupervisorStopped) return;
      const machinePromise = deps.getEdgeMachine();
      if (machinePromise) {
        try {
          const machine = await machinePromise;
          if (edgeSupervisorStopped) return;
          if (machine) {
            await machine.flushHeartbeats();
            return;
          }
        } catch {
          noteStartFailure();
        }
      }
      if (edgeSupervisorStopped) return;
      if (isEdgeSupervisorEnabled() && !edgeSupervisorFailed) return;
      await getLegacy().runFlush();
    },
    close: async () => {
      edgeSupervisorStopped = true;
      const machine = deps.getEdgeMachine();
      deps.setEdgeMachine(undefined);
      if (machine) await machine.then((m) => m?.close()).catch(() => {});
    },
    setEdgeMachineForTests: (
      machine: Promise<MachineSupervisor | undefined> | undefined,
    ) => {
      deps.setEdgeMachine(machine);
      edgeSupervisorFailed = false;
      edgeSupervisorStartFailureLogged = false;
      edgeSupervisorStopped = false;
      pendingSupervisedMembershipOps = 0;
      heartbeatMembershipChain = Promise.resolve();
    },
    flushMembershipForTests: () => heartbeatMembershipChain,
    isLegacyLoopRunningForTests: () =>
      legacyHeartbeatFlush?.isLoopRunning() ?? false,
    stopLegacyLoopForTests: () => {
      legacyHeartbeatFlush?.stopLoop();
    },
  };
}
