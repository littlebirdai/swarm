import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startMachine } from "@codecast/edge-supervisor";
import { defaultConfigDir } from "./config/configDir.js";
import {
  ensureManagedSessionHeartbeat,
  flushHeartbeatMembershipForTests,
  heartbeatFlushHostForTests,
  isLegacyHeartbeatFlushLoopRunningForTests,
  runHeartbeatFlush,
  setEdgeMachineForTests,
  setSyncServiceForTests,
  stopLegacyHeartbeatFlushLoopForTests,
  stopManagedSessionHeartbeat,
  trackSessionPaneForTests,
} from "./daemon.js";
import type { SyncService } from "./syncService.js";

describe("daemon heartbeat flush supervisor flag", () => {
  const previousFlag = process.env.CODECAST_EDGE_SUPERVISOR_V1;
  const cleanupSessions: string[] = [];

  afterEach(async () => {
    for (const id of cleanupSessions.splice(0)) {
      stopManagedSessionHeartbeat(id);
      trackSessionPaneForTests(id, null);
    }
    await flushHeartbeatMembershipForTests();
    stopLegacyHeartbeatFlushLoopForTests();
    setEdgeMachineForTests(undefined);
    setSyncServiceForTests(null);
    if (previousFlag === undefined)
      delete process.env.CODECAST_EDGE_SUPERVISOR_V1;
    else process.env.CODECAST_EDGE_SUPERVISOR_V1 = previousFlag;
  });

  test("with CODECAST_EDGE_SUPERVISOR_V1 off, the legacy heartbeat flush loop runs unchanged", async () => {
    delete process.env.CODECAST_EDGE_SUPERVISOR_V1;
    const sessionId = "sup-flag-off-1";
    cleanupSessions.push(sessionId);
    const batches: unknown[] = [];

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (rows: unknown[]) => {
        batches.push(rows);
      },
    } as unknown as SyncService);

    trackSessionPaneForTests(sessionId, "tmux-off", { status: "working" });
    ensureManagedSessionHeartbeat(sessionId);
    expect(isLegacyHeartbeatFlushLoopRunningForTests()).toBe(true);
    expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(true);

    await runHeartbeatFlush();
    expect(batches).toEqual([
      [
        expect.objectContaining({
          session_id: sessionId,
          agent_status: "working",
        }),
      ],
    ]);

    stopManagedSessionHeartbeat(sessionId);
    expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(false);
  });

  test("with CODECAST_EDGE_SUPERVISOR_V1 on, daemon delegates to MachineLive HeartbeatFlush and never arms the legacy loop", async () => {
    process.env.CODECAST_EDGE_SUPERVISOR_V1 = "1";
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
      Promise.resolve({
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
      expect(isLegacyHeartbeatFlushLoopRunningForTests()).toBe(false);

      await runHeartbeatFlush();
      expect(isLegacyHeartbeatFlushLoopRunningForTests()).toBe(false);
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

  test("with CODECAST_EDGE_SUPERVISOR_V1 on, transcript-sourced sessions are owned by the service and pruned when their process dies", async () => {
    process.env.CODECAST_EDGE_SUPERVISOR_V1 = "1";
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
    setEdgeMachineForTests(Promise.resolve(supervisor));

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

  test("with CODECAST_EDGE_SUPERVISOR_V1 on, ensure and stop serialize in call order even with a delayed ensure", async () => {
    process.env.CODECAST_EDGE_SUPERVISOR_V1 = "1";
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
      Promise.resolve({
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

  test("with CODECAST_EDGE_SUPERVISOR_V1 on, supervisor startup rejection falls back once without rejecting runHeartbeatFlush", async () => {
    process.env.CODECAST_EDGE_SUPERVISOR_V1 = "1";
    const sessionId = "sup-start-fail";
    cleanupSessions.push(sessionId);
    const batches: unknown[] = [];

    setSyncServiceForTests({
      heartbeatManagedSessionsBatch: async (rows: unknown[]) => {
        batches.push(rows);
      },
    } as unknown as SyncService);

    trackSessionPaneForTests(sessionId, "tmux-fail", { status: "working" });
    setEdgeMachineForTests(Promise.reject(new Error("supervisor failed")));

    await expect(runHeartbeatFlush()).resolves.toBeUndefined();
    await expect(runHeartbeatFlush()).resolves.toBeUndefined();
    expect(batches).toHaveLength(2);
  });

  test("sendBatch captures syncServiceRef once before the batch loop", async () => {
    delete process.env.CODECAST_EDGE_SUPERVISOR_V1;
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

    for (const id of fleet) {
      trackSessionPaneForTests(id, `tmux-${id}`, { status: "working" });
    }
    await runHeartbeatFlush();
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(25);
    expect(batches[1]).toHaveLength(1);
  });
});
