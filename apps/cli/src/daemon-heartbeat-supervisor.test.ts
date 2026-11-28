import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startMachine } from "@codecast/edge-supervisor";
import { defaultConfigDir } from "./config/configDir.js";
import {
  closeEdgeSupervisorForTests,
  ensureManagedSessionHeartbeat,
  flushHeartbeatMembershipForTests,
  heartbeatFlushHostForTests,
  parkHibernationTerminalForTests,
  pendingHeartbeatMembershipForTests,
  runHeartbeatFlush,
  setEdgeMachineForTests,
  setSyncServiceForTests,
  startEdgeMachineForTests,
  stopManagedSessionHeartbeat,
  trackSessionPaneForTests,
} from "./daemon.js";
import type { SyncService } from "./syncService.js";
import { pollUntil } from "./test-helpers/pollUntil.js";

function makeParkBoundary(
  sessionId: string,
): Parameters<typeof parkHibernationTerminalForTests>[4] {
  return {
    target: {
      session: "$1",
      pane: "%1",
      pid: process.pid,
      agentPid: process.pid,
      start: "0",
      stamp: sessionId,
      conversationStamp: "",
    },
    terminal: async (args) => {
      if (args[0] === "capture-pane") return { stdout: "❯ " };
      if (args[0] === "if-shell") return { stdout: "parked" };
      if (args[0] === "list-panes") return { stdout: "" };
      return { stdout: "" };
    },
    beginCommit: () => true,
    unchanged: () => true,
    revalidate: async () => true,
  };
}

function makeParkOps() {
  return {
    reapPlan: async () => ({
      roots: [],
      targets: [],
      terminals: [],
      panePids: [process.pid],
      sideSessions: [],
      complete: true,
    }),
    planRefusal: async () => null,
  };
}

describe("daemon heartbeat flush supervisor", () => {
  const cleanupSessions: string[] = [];

  afterEach(async () => {
    for (const id of cleanupSessions.splice(0)) {
      stopManagedSessionHeartbeat(id);
      trackSessionPaneForTests(id, null);
    }
    await flushHeartbeatMembershipForTests();
    await closeEdgeSupervisorForTests();
    setEdgeMachineForTests(undefined);
    setSyncServiceForTests(null);
  });

  test("the daemon delegates membership and flushes to MachineLive HeartbeatFlush", async () => {
    const sessionId = "sup-flag-on-1";
    cleanupSessions.push(sessionId);
    const batches: unknown[] = [];

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (rows: unknown[]) => {
        batches.push(rows);
      },
    } as unknown as SyncService);

    let supervisorEnsureCalls = 0;
    let supervisorFlushCalls = 0;
    let supervisorStopCalls = 0;
    const supervisor = await startMachine({
      log: () => {},
      heartbeatFlush: heartbeatFlushHostForTests(),
    });
    setEdgeMachineForTests(
      ({
        ...supervisor,
        ensureSessionHeartbeat: (id, source) => {
          supervisorEnsureCalls++;
          return supervisor.ensureSessionHeartbeat(id, source);
        },
        flushHeartbeats: () => {
          supervisorFlushCalls++;
          return supervisor.flushHeartbeats();
        },
        stopSessionHeartbeat: (id) => {
          supervisorStopCalls++;
          return supervisor.stopSessionHeartbeat(id);
        },
      }),
    );

    try {
      trackSessionPaneForTests(sessionId, "tmux-on", { status: "working" });
      ensureManagedSessionHeartbeat(sessionId);

      await runHeartbeatFlush();
      expect(supervisorEnsureCalls).toBe(1);
      expect(supervisorFlushCalls).toBe(1);
      expect(batches).toEqual([
        [
          expect.objectContaining({
            session_id: sessionId,
            agent_status: "working",
          }),
        ],
      ]);

      stopManagedSessionHeartbeat(sessionId);
      await flushHeartbeatMembershipForTests();
      expect(supervisorStopCalls).toBe(1);
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  test("transcript-sourced sessions are owned by the service and pruned when their process dies", async () => {
    const sessionId = `sup-transcript-prune-${Date.now()}`;
    cleanupSessions.push(sessionId);
    const registryDir = path.join(defaultConfigDir(), "session-registry");
    const registryFile = path.join(registryDir, `${sessionId}.json`);
    const batches: Array<Array<{ session_id: string }>> = [];

    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({ pid: process.pid }));

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (
        rows: Array<{ session_id: string }>,
      ) => {
        batches.push(rows);
      },
    } as unknown as SyncService);

    const supervisor = await startMachine({
      log: () => {},
      heartbeatFlush: heartbeatFlushHostForTests(),
    });
    setEdgeMachineForTests(supervisor);

    try {
      ensureManagedSessionHeartbeat(sessionId, "transcript");
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(false);

      await runHeartbeatFlush();
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(true);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toContainEqual(
        expect.objectContaining({ session_id: sessionId }),
      );

      fs.rmSync(registryFile, { force: true });
      await runHeartbeatFlush();
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(false);
      expect(batches).toHaveLength(1);
    } finally {
      fs.rmSync(registryFile, { force: true });
      await supervisor.close();
    }
  });

  test("ensure and stop serialize in call order even with a delayed ensure", async () => {
    const sessionId = "sup-order-race";
    cleanupSessions.push(sessionId);

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async () => {},
    } as unknown as SyncService);

    let releaseDelayedEnsure: (() => void) | undefined;
    let releaseDelayedStop: (() => void) | undefined;
    let delayEnsure = true;
    let delayStop = false;
    const order: string[] = [];
    const supervisor = await startMachine({
      log: () => {},
      heartbeatFlush: heartbeatFlushHostForTests(),
    });
    setEdgeMachineForTests(
      ({
        ...supervisor,
        ensureSessionHeartbeat: async (id, source) => {
          order.push("ensure:start");
          if (delayEnsure) {
            delayEnsure = false;
            await new Promise<void>((resolve) => {
              releaseDelayedEnsure = resolve;
            });
          }
          await supervisor.ensureSessionHeartbeat(id, source);
          order.push("ensure:end");
        },
        stopSessionHeartbeat: async (id) => {
          order.push("stop:start");
          if (delayStop) {
            delayStop = false;
            await new Promise<void>((resolve) => {
              releaseDelayedStop = resolve;
            });
          }
          await supervisor.stopSessionHeartbeat(id);
          order.push("stop:end");
        },
      }),
    );

    try {
      ensureManagedSessionHeartbeat(sessionId);
      stopManagedSessionHeartbeat(sessionId);
      while (!releaseDelayedEnsure) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      releaseDelayedEnsure();
      await flushHeartbeatMembershipForTests();
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(false);

      delayStop = true;
      stopManagedSessionHeartbeat(sessionId);
      ensureManagedSessionHeartbeat(sessionId);
      while (!releaseDelayedStop) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      releaseDelayedStop();
      await flushHeartbeatMembershipForTests();
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(true);
      expect(order).toEqual([
        "ensure:start",
        "ensure:end",
        "stop:start",
        "stop:end",
        "stop:start",
        "stop:end",
        "ensure:start",
        "ensure:end",
      ]);
    } finally {
      await supervisor.close();
    }
  });

  test("parkHibernationTerminal keeps transcript sessions beating and orders behind a queued stop", async () => {
    const transcriptSession = `sup-park-transcript-${Date.now()}`;
    const raceSession = `sup-park-race-${Date.now()}`;
    cleanupSessions.push(transcriptSession, raceSession);
    const registryDir = path.join(defaultConfigDir(), "session-registry");
    const registryFile = path.join(registryDir, `${transcriptSession}.json`);
    const batches: Array<Array<{ session_id: string; agent_status?: string }>> =
      [];

    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({ pid: process.pid }));

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (
        rows: Array<{ session_id: string; agent_status?: string }>,
      ) => {
        batches.push(rows);
      },
    } as unknown as SyncService);

    let releaseDelayedStop: (() => void) | undefined;
    let delayStop = false;
    const supervisor = await startMachine({
      log: () => {},
      heartbeatFlush: heartbeatFlushHostForTests(),
    });
    setEdgeMachineForTests(
      ({
        ...supervisor,
        stopSessionHeartbeat: async (id) => {
          if (delayStop && id === raceSession) {
            delayStop = false;
            await new Promise<void>((resolve) => {
              releaseDelayedStop = resolve;
            });
          }
          await supervisor.stopSessionHeartbeat(id);
        },
      }),
    );

    try {
      ensureManagedSessionHeartbeat(transcriptSession, "transcript");
      await flushHeartbeatMembershipForTests();
      expect(
        await parkHibernationTerminalForTests(
          transcriptSession,
          "tmux-park-1",
          undefined,
          1,
          makeParkBoundary(transcriptSession),
          makeParkOps(),
        ),
      ).toBe(true);
      await flushHeartbeatMembershipForTests();
      fs.rmSync(registryFile, { force: true });

      await runHeartbeatFlush();
      expect(heartbeatFlushHostForTests().sessions.has(transcriptSession)).toBe(
        true,
      );
      expect(batches[0]).toContainEqual(
        expect.objectContaining({
          session_id: transcriptSession,
          agent_status: "hibernated",
        }),
      );

      ensureManagedSessionHeartbeat(raceSession, "transcript");
      await flushHeartbeatMembershipForTests();

      delayStop = true;
      stopManagedSessionHeartbeat(raceSession);
      while (!releaseDelayedStop) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      expect(
        await parkHibernationTerminalForTests(
          raceSession,
          "tmux-park-2",
          undefined,
          1,
          makeParkBoundary(raceSession),
          makeParkOps(),
        ),
      ).toBe(true);
      releaseDelayedStop();
      await flushHeartbeatMembershipForTests();

      expect(heartbeatFlushHostForTests().sessions.has(raceSession)).toBe(true);
      await runHeartbeatFlush();
      expect(batches[1]).toContainEqual(
        expect.objectContaining({
          session_id: raceSession,
          agent_status: "hibernated",
        }),
      );
    } finally {
      fs.rmSync(registryFile, { force: true });
      await supervisor.close();
    }
  });

  test("an op rejection after start is contained and later ops still run", async () => {
    const failingSession = "sup-op-reject";
    const healthySession = "sup-op-ok";
    cleanupSessions.push(failingSession, healthySession);
    const batches: Array<Array<{ session_id: string }>> = [];
    let flushCalls = 0;

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (
        rows: Array<{ session_id: string }>,
      ) => {
        batches.push(rows);
      },
    } as unknown as SyncService);

    const supervisor = await startMachine({
      log: () => {},
      heartbeatFlush: heartbeatFlushHostForTests(),
    });
    setEdgeMachineForTests(
      ({
        ...supervisor,
        ensureSessionHeartbeat: async (id, source) => {
          if (id === failingSession) {
            throw new Error("membership op rejected");
          }
          await supervisor.ensureSessionHeartbeat(id, source);
        },
        flushHeartbeats: () => {
          flushCalls++;
          return supervisor.flushHeartbeats();
        },
      }),
    );

    try {
      ensureManagedSessionHeartbeat(failingSession);
      await flushHeartbeatMembershipForTests();
      expect(heartbeatFlushHostForTests().sessions.has(failingSession)).toBe(
        false,
      );

      ensureManagedSessionHeartbeat(healthySession);
      await flushHeartbeatMembershipForTests();
      await runHeartbeatFlush();

      expect(flushCalls).toBe(1);
      expect(batches).toEqual([[{ session_id: healthySession }]]);
    } finally {
      await supervisor.close();
    }
  });

  test("sendBatch captures syncServiceRef once before the batch loop", async () => {
    const fleet = Array.from({ length: 26 }, (_, i) => `sup-sync-snap-${i}`);
    cleanupSessions.push(...fleet);
    const batches: Array<Array<{ session_id: string }>> = [];

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (
        rows: Array<{ session_id: string }>,
      ) => {
        batches.push(rows);
        if (batches.length === 1) setSyncServiceForTests(null);
      },
    } as unknown as SyncService);

    const supervisor = await startMachine({
      log: () => {},
      heartbeatFlush: heartbeatFlushHostForTests(),
    });
    setEdgeMachineForTests(supervisor);
    try {
      for (const id of fleet) {
        trackSessionPaneForTests(id, `tmux-${id}`, { status: "working" });
        ensureManagedSessionHeartbeat(id);
      }
      await runHeartbeatFlush();
      expect(batches).toHaveLength(2);
      expect(batches[0]).toHaveLength(25);
      expect(batches[1]).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  test("a failed supervisor start is logged, retried, and replays the newest membership per session once it starts", async () => {
    const kept = "sup-retry-kept";
    const dropped = "sup-retry-dropped";
    cleanupSessions.push(kept, dropped);
    const batches: Array<Array<{ session_id: string }>> = [];
    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (
        rows: Array<{ session_id: string }>,
      ) => {
        batches.push(rows);
      },
    } as unknown as SyncService);
    setEdgeMachineForTests(undefined);
    const host = heartbeatFlushHostForTests();
    let attempts = 0;
    let real: Awaited<ReturnType<typeof startMachine>> | undefined;
    let releaseSecondAttempt!: () => void;
    const secondAttempt = new Promise<void>((resolve) => {
      releaseSecondAttempt = resolve;
    });
    const started = startEdgeMachineForTests(async () => {
      attempts++;
      if (attempts === 1) throw new Error("supervisor failed");
      await secondAttempt;
      real = await startMachine({ log: () => {}, heartbeatFlush: host });
      return real;
    });
    try {
      ensureManagedSessionHeartbeat(dropped);
      ensureManagedSessionHeartbeat(kept);
      stopManagedSessionHeartbeat(dropped);
      await runHeartbeatFlush();
      expect(batches).toEqual([]);
      expect(host.sessions.has(kept)).toBe(false);
      expect([...pendingHeartbeatMembershipForTests()]).toEqual([
        [kept, { kind: "ensure", source: undefined }],
        [dropped, { kind: "stop" }],
      ]);
      await pollUntil(() => attempts === 2, "second supervisor start attempt", {
        ms: 5_000,
      });
      releaseSecondAttempt();
      await started;
      await flushHeartbeatMembershipForTests();
      expect(pendingHeartbeatMembershipForTests().size).toBe(0);
      expect(host.sessions.has(kept)).toBe(true);
      expect(host.sessions.has(dropped)).toBe(false);
      await runHeartbeatFlush();
      expect(batches).toEqual([[{ session_id: kept }]]);
    } finally {
      await real?.close();
    }
  });

  test("closing during a start retry stops the retries and records nothing", async () => {
    const sessionId = "sup-close-during-retry";
    cleanupSessions.push(sessionId);
    setEdgeMachineForTests(undefined);
    let attempts = 0;
    const started = startEdgeMachineForTests(async () => {
      attempts++;
      throw new Error("supervisor failed");
    });
    await pollUntil(() => attempts === 1, "first supervisor start attempt");
    await closeEdgeSupervisorForTests();
    await started;
    ensureManagedSessionHeartbeat(sessionId);
    expect(pendingHeartbeatMembershipForTests().size).toBe(0);
    expect(attempts).toBe(1);
  });
});
