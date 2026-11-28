import type {
  MachineConnection,
  MachineSupervisor,
} from "@codecast/edge-supervisor";

const START_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

type Membership = { kind: "ensure"; source?: "transcript" } | { kind: "stop" };

export function createEdgeMachineCoordinator(deps: {
  log: (msg: string) => void;
  retryDelaysMs?: readonly number[];
}) {
  const retryDelaysMs = deps.retryDelaysMs ?? START_RETRY_DELAYS_MS;
  const pending = new Map<string, Membership>();
  let machine: MachineSupervisor | undefined;
  let stopped = false;
  let starting = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeRetry: (() => void) | undefined;
  let lastOp: Promise<void> = Promise.resolve();

  function send(op: (m: MachineSupervisor) => Promise<void>): void {
    const current = machine;
    if (!current || stopped) return;
    lastOp = lastOp.then(() => (stopped ? undefined : op(current))).catch((err) => {
      if (!stopped)
        deps.log(
          `[EDGE] Supervisor heartbeat op failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
  }

  function record(sessionId: string, membership: Membership): void {
    pending.delete(sessionId);
    pending.set(sessionId, membership);
  }

  function adopt(started: MachineSupervisor): void {
    machine = started;
    const replay = [...pending];
    pending.clear();
    for (const [sessionId, membership] of replay)
      send((m) =>
        membership.kind === "ensure"
          ? m.ensureSessionHeartbeat(sessionId, membership.source)
          : m.stopSessionHeartbeat(sessionId),
      );
  }

  function waitBeforeRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wakeRetry = resolve;
      retryTimer = setTimeout(resolve, ms);
      retryTimer.unref?.();
    }).then(() => {
      retryTimer = undefined;
      wakeRetry = undefined;
    });
  }

  async function start(open: () => Promise<MachineSupervisor>): Promise<void> {
    if (starting || machine || stopped) return;
    starting = true;
    try {
      for (let attempt = 0; !stopped; attempt++) {
        try {
          const started = await open();
          if (stopped) {
            await started.close().catch(() => {});
            return;
          }
          adopt(started);
          if (attempt > 0)
            deps.log(`[EDGE] Supervisor started after ${attempt + 1} attempts`);
          return;
        } catch (err) {
          const delay =
            retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 0;
          deps.log(
            `[EDGE] Supervisor start failed (attempt ${attempt + 1}), session heartbeats wait for it; retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
          );
          await waitBeforeRetry(delay);
        }
      }
    } finally {
      starting = false;
    }
  }

  return {
    start,
    isStarted: () => machine !== undefined,
    connect: (connection: MachineConnection): void => {
      if (stopped || !machine) return;
      void machine
        .connect(connection)
        .catch(() => deps.log("[EDGE] Supervisor link failed"));
    },
    ensureSession: (sessionId: string, source?: "transcript"): void => {
      if (stopped) return;
      if (machine) send((m) => m.ensureSessionHeartbeat(sessionId, source));
      else record(sessionId, { kind: "ensure", source });
    },
    stopSession: (sessionId: string | undefined): void => {
      if (!sessionId || stopped) return;
      if (machine) send((m) => m.stopSessionHeartbeat(sessionId));
      else record(sessionId, { kind: "stop" });
    },
    runFlush: async (): Promise<void> => {
      if (stopped || !machine) return;
      await lastOp;
      if (stopped || !machine) return;
      await machine.flushHeartbeats();
    },
    memoryParkingBudget: async (): Promise<number | undefined> =>
      stopped || !machine
        ? undefined
        : machine.memoryParkingBudget().catch(() => undefined),
    close: async (): Promise<void> => {
      stopped = true;
      pending.clear();
      if (retryTimer) clearTimeout(retryTimer);
      wakeRetry?.();
      const current = machine;
      machine = undefined;
      await current?.close().catch(() => {});
    },
    pendingForTests: () => new Map(pending),
    setMachineForTests: (next: MachineSupervisor | undefined): void => {
      machine = next;
      stopped = false;
      starting = false;
      pending.clear();
      lastOp = Promise.resolve();
    },
    flushMembershipForTests: () => lastOp,
  };
}
