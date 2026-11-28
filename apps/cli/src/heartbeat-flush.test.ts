import { expect, test } from "bun:test";
import type { MachineSupervisor } from "@codecast/edge-supervisor";
import { createEdgeMachineCoordinator } from "./heartbeat-flush.js";
import { pollUntil } from "./test-helpers/pollUntil.js";
import { strictStub } from "./test-helpers/strictStub.js";

function fakeMachine(calls: string[]) {
  return strictStub<MachineSupervisor>("edge machine", {
    ensureSessionHeartbeat: async (id, source) => {
      calls.push(`ensure:${id}:${source ?? "pane"}`);
    },
    stopSessionHeartbeat: async (id) => {
      calls.push(`stop:${id}`);
    },
    flushHeartbeats: async () => {
      calls.push("flush");
    },
    memoryParkingBudget: async () => 512,
    close: async () => {
      calls.push("close");
    },
  });
}

test("a failed start logs each attempt, retries, and replays one membership per session in order", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const edge = createEdgeMachineCoordinator({
    log: (line) => logs.push(line),
    retryDelaysMs: [1, 1],
  });
  let attempts = 0;
  edge.ensureSession("a");
  edge.ensureSession("b", "transcript");
  edge.stopSession("a");
  edge.ensureSession("c");
  edge.stopSession("c");
  edge.ensureSession("c");
  expect(edge.pendingForTests().size).toBe(3);
  await edge.runFlush();
  expect(await edge.memoryParkingBudget()).toBeUndefined();
  await edge.start(async () => {
    attempts++;
    if (attempts < 3) throw new Error(`down ${attempts}`);
    return fakeMachine(calls);
  });
  await edge.flushMembershipForTests();
  expect(attempts).toBe(3);
  expect(logs).toEqual([
    "[EDGE] Supervisor start failed (attempt 1), session heartbeats wait for it; retrying in 1ms: down 1",
    "[EDGE] Supervisor start failed (attempt 2), session heartbeats wait for it; retrying in 1ms: down 2",
    "[EDGE] Supervisor started after 3 attempts",
  ]);
  expect(calls).toEqual(["ensure:b:transcript", "stop:a", "ensure:c:pane"]);
  expect(edge.pendingForTests().size).toBe(0);
  await edge.runFlush();
  expect(calls.at(-1)).toBe("flush");
  expect(await edge.memoryParkingBudget()).toBe(512);
});

test("membership ops run one after another in call order", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const edge = createEdgeMachineCoordinator({ log: () => {} });
  edge.setMachineForTests(
    strictStub<MachineSupervisor>("edge machine", {
      ensureSessionHeartbeat: async () => {
        order.push("ensure:start");
        await gate;
        order.push("ensure:end");
      },
      stopSessionHeartbeat: async () => {
        order.push("stop");
      },
    }),
  );
  edge.ensureSession("a");
  edge.stopSession("a");
  await pollUntil(() => order.length === 1, "the first op starts");
  release();
  await edge.flushMembershipForTests();
  expect(order).toEqual(["ensure:start", "ensure:end", "stop"]);
});

test("an op that throws is logged and the next op still runs", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const edge = createEdgeMachineCoordinator({ log: (line) => logs.push(line) });
  edge.setMachineForTests(
    strictStub<MachineSupervisor>("edge machine", {
      ensureSessionHeartbeat: (id) => {
        if (id === "bad") throw new Error("sync failure");
        calls.push(id);
        return Promise.resolve();
      },
    }),
  );
  edge.ensureSession("bad");
  edge.ensureSession("good");
  await edge.flushMembershipForTests();
  expect(calls).toEqual(["good"]);
  expect(logs).toEqual(["[EDGE] Supervisor heartbeat op failed: sync failure"]);
});

test("close during a retry wait stops the retries, and a late start is closed", async () => {
  const edge = createEdgeMachineCoordinator({
    log: () => {},
    retryDelaysMs: [60_000],
  });
  let attempts = 0;
  const started = edge.start(async () => {
    attempts++;
    throw new Error("down");
  });
  await pollUntil(() => attempts === 1, "the first start attempt");
  await edge.close();
  await started;
  expect(attempts).toBe(1);
  edge.ensureSession("after-close");
  expect(edge.pendingForTests().size).toBe(0);

  const calls: string[] = [];
  const late = createEdgeMachineCoordinator({ log: () => {} });
  let open!: (machine: MachineSupervisor) => void;
  const opening = late.start(
    () =>
      new Promise<MachineSupervisor>((resolve) => {
        open = resolve;
      }),
  );
  await late.close();
  open(fakeMachine(calls));
  await opening;
  expect(calls).toEqual(["close"]);
});
