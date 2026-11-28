import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTaskClaimFor,
  clearTaskPulseIfBound,
  readTaskClaimToken,
  readTaskPulseFor,
  recordTaskFiled,
  recordTaskStart,
  storeTaskClaim,
  updateTaskPulseLease,
  writeTaskPulse,
} from "./taskPulse.js";

function withConfigDir(fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "task-pulse-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("filing a task and the session's pulse (task-graph.md TG5, TG10)", () => {
  test("a session bound on the server keeps its pulse, --found-during none included", () => {
    withConfigDir(() => {
      recordTaskFiled("s1", "ct-9", undefined, true);
      expect(readTaskPulseFor("s1")).toBeNull();
      writeTaskPulse("s1", "ct-1", "pl-1");
      recordTaskFiled("s1", "ct-9", undefined, true);
      expect(readTaskPulseFor("s1")).toEqual({ task: "ct-1", plan: "pl-1" });
    });
  });

  test("a started task keeps the pulse even when the filing is not linked to it", () => {
    withConfigDir(() => {
      writeTaskPulse("s1", "ct-1", "pl-1", { started: true });
      recordTaskFiled("s1", "ct-9", undefined);
      expect(readTaskPulseFor("s1")?.task).toBe("ct-1");
    });
  });

  test("an unbound session takes the newest filed task and keeps its plan", () => {
    withConfigDir(() => {
      writeTaskPulse("s1", "", "pl-4");
      recordTaskFiled("s1", "ct-5", undefined);
      expect(readTaskPulseFor("s1")).toEqual({ task: "ct-5", plan: "pl-4" });
      recordTaskFiled("s1", "ct-6", "pl-7");
      expect(readTaskPulseFor("s1")).toEqual({ task: "ct-6", plan: "pl-7" });
      recordTaskFiled(null, "ct-8", undefined);
      expect(readTaskPulseFor("s1")?.task).toBe("ct-6");
    });
  });
});

describe("closing a task and the session's pulse", () => {
  test("clears only when the closed task is the one the session holds", () => {
    withConfigDir(() => {
      writeTaskPulse("s1", "ct-1", "pl-1", { started: true });
      clearTaskPulseIfBound("s1", "ct-2");
      expect(readTaskPulseFor("s1")?.task).toBe("ct-1");
      clearTaskPulseIfBound("s1", "ct-1");
      expect(readTaskPulseFor("s1")).toBeNull();
    });
  });
});

describe("task claim tokens in taskPulse", () => {
  test("stores, reads, updates lease, and clears per-session and standalone claim tokens", async () => {
    let lease: number | undefined;
    await (async () => {
      const dir = mkdtempSync(join(tmpdir(), "task-pulse-claim-"));
      const prev = process.env.CODECAST_DIR;
      process.env.CODECAST_DIR = dir;
      try {
        await recordTaskStart("s1", "ct-1", "pl-1", async () => {}, {
          claim_token: 7,
          lease_until: 1000,
        });
        expect(readTaskPulseFor("s1")).toEqual({
          task: "ct-1",
          plan: "pl-1",
          started: true,
          claim_token: 7,
          lease_until: 1000,
        });
        expect(readTaskClaimToken("s1", "ct-1")).toBe(7);
        expect(readTaskClaimToken("s1", "ct-2")).toBeUndefined();

        updateTaskPulseLease("s1", "ct-1", 7, 2500);
        lease = readTaskPulseFor("s1")?.lease_until;
        expect(lease).toBe(2500);

        clearTaskClaimFor("s1", "ct-1");
        expect(readTaskClaimToken("s1", "ct-1")).toBeUndefined();
        expect(readTaskPulseFor("s1")?.task).toBe("ct-1");

        storeTaskClaim(null, "ct-9", 3, 5000);
        expect(readTaskClaimToken(null, "ct-9")).toBe(3);
        clearTaskClaimFor(null, "ct-9");
        expect(readTaskClaimToken(null, "ct-9")).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.CODECAST_DIR;
        else process.env.CODECAST_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  });
});
