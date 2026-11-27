import { afterEach, describe, expect, test } from "bun:test";
import { startMachine } from "@codecast/edge-supervisor";
import {
  ensureManagedSessionHeartbeat,
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
      await new Promise((r) => setTimeout(r, 0));
      expect(supervisorStopCalls).toBe(1);
      expect(heartbeatFlushHostForTests().sessions.has(sessionId)).toBe(false);
    } finally {
      await supervisor.close();
    }
  });
});
