import "./test-helpers/isolatedTmuxServer.js";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFunctionName } from "convex/server";
import {
  cacheSessionProcess,
  flushHibernationStamps,
  hibernationConcurrencyForTests as internals,
  inspectHibernationTarget,
  reconcileSessionLiveness,
  runHibernationPass,
  sessionParkStateForTests,
  setActiveConfigForTests,
  setEdgeMachineForTests,
  setSyncServiceForTests,
  trackSessionPaneForTests,
  type HibernationPassIo,
} from "./daemon.js";
import type { MachineSupervisor } from "@codecast/edge-supervisor";
import { sampleParkingMemory } from "./memory-parking.js";
import { buildShimScript } from "./test-helpers/fakeClaudeShim.js";
import { strictStub } from "./test-helpers/strictStub.js";
import {
  spawnHarness,
  waitFor,
  type Harness,
} from "./test-helpers/messagingHarness.js";
import { hasTmux, tmuxRun, tmuxRunAsync } from "./tmux.js";
import type { SyncService } from "./syncService.js";

const harnesses: Harness[] = [];
const roots: string[] = [];

const alive = (h: Harness) =>
  tmuxRun(["has-session", "-t", `=${h.tmuxSession}`]).status === 0;

async function terminal(args: string[]) {
  const result = await tmuxRunAsync(args, { timeout: 3000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result;
}

async function fixture() {
  const id = crypto.randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-park-pane-"));
  roots.push(root);
  const script = path.join(root, "claude");
  fs.writeFileSync(script, buildShimScript({ sessionId: id }), { mode: 0o755 });
  const h = spawnHarness({
    sessionId: id,
    home: os.homedir(),
    tmuxPrefix: `cc-memory-park-${process.pid}`,
    command: `exec '${script}' --session-id ${id}`,
  });
  harnesses.push(h);
  await waitFor(() => h.paneHasPrompt(), { timeoutMs: 5000 });
  trackSessionPaneForTests(id, h.tmuxSession, { status: "idle" });
  const { stdout } = await terminal([
    "display-message",
    "-p",
    "-t",
    `=${h.tmuxSession}:`,
    "#{pane_pid}",
  ]);
  const pid = Number(stdout.trim());
  const conv = `conv-${id}`;
  const life = {
    status: "active",
    source: "lifecycle" as const,
    hideStateKnown: true,
    inboxPinnedAt: null,
    hasPendingMessages: false,
  };
  const sync = {
    registerManagedSession: async () => undefined,
    updateSessionAgentStatus: async () => true,
    getConversationLifecycle: async () => life,
  };
  setSyncServiceForTests(sync as unknown as SyncService);
  const io: Partial<HibernationPassIo> = {
    awakeIdleMs: () => 10_000,
    conversationIds: () => ({ [id]: conv }),
    inspectTarget: (id, name, conv) =>
      inspectHibernationTarget(id, name, conv, root),
  };
  fs.writeFileSync(
    path.join(root, `${id}.json`),
    JSON.stringify({ pid, ts: Date.now() / 1000, term: "tmux" }),
  );
  return { id, h, pid, conv, io, sync };
}

afterEach(async () => {
  internals.setResumeInner(null);
  setSyncServiceForTests(null);
  for (const h of harnesses.splice(0)) {
    trackSessionPaneForTests(h.sessionId, null);
    h.tearDown();
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  await flushHibernationStamps();
});

test.skipIf(!hasTmux())(
  "live parking follows the edge budget, prompt and safety interlock",
  async () => {
    const f = await fixture();
    cacheSessionProcess(
      f.id,
      { pid: f.pid, tty: "", sessionId: f.id },
      f.h.tmuxSession,
    );
    const roots = new Map([[f.id, { pid: f.pid }]]);
    const before = (await sampleParkingMemory(1, roots))?.usedBytes;
    expect(before).toBeGreaterThan(0);
    let budget: number | undefined = 10 ** 12;
    const queries: unknown[] = [];
    let networkDown = false;
    let permitted = true;
    let listed = 0;
    let inspected = 0;
    let dryRun = true;
    let now = Date.now();
    const inspect = f.io.inspectTarget!;
    f.io.inspectTarget = (...args) => {
      inspected++;
      return inspect(...args);
    };
    f.io.tmuxSessions = async () => {
      listed++;
      const { stdout } = await terminal([
        "list-sessions",
        "-F",
        "#{session_name}|#{session_attached}",
      ]);
      return new Map(
        stdout
          .trim()
          .split("\n")
          .map((row) => {
            const [name, count] = row.split("|");
            return [name!, Number(count)];
          }),
      );
    };
    f.io.now = () => now;
    f.io.policy = () => ({ maxLive: 1, idleMs: 1, maxPerPass: 5, dryRun });
    setSyncServiceForTests({
      ...f.sync,
      getClient: () => ({
        query: async (
          ref: Parameters<typeof getFunctionName>[0],
          args: unknown,
        ) => {
          queries.push([getFunctionName(ref), args]);
          if (networkDown) throw new TypeError("fetch failed");
          return permitted
            ? { status: "allowed" }
            : { status: "refused", reason: "prompt" };
        },
      }),
    } as unknown as SyncService);
    setActiveConfigForTests({ auth_token: "fixture-token" });
    setEdgeMachineForTests(
      strictStub<MachineSupervisor>("edge machine", {
        memoryParkingBudget: async () => budget,
        ensureSessionHeartbeat: async () => {},
        stopSessionHeartbeat: async () => {},
        close: async () => {},
      }),
    );
    const pass = () => runHibernationPass(f.io, true);
    try {
      expect(await pass()).toBe(0);
      expect(listed).toBe(0);
      expect(queries).toEqual([]);

      budget = undefined;
      expect(await pass()).toBe(0);
      expect(listed).toBe(0);

      budget = 1;
      internals.openPermissionDialogs.add(f.id);
      expect(await pass()).toBe(0);
      expect(listed).toBe(1);
      expect(queries).toEqual([]);
      expect(inspected).toBe(0);
      expect(alive(f.h)).toBe(true);

      internals.openPermissionDialogs.delete(f.id);
      networkDown = true;
      permitted = false;
      now += 3_600_000;
      expect(await pass()).toBe(0);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toEqual([
        "edgeLink:canParkSession",
        { bearer: "fixture-token", conversation_id: f.conv, session_id: f.id },
      ]);
      expect(inspected).toBe(0);
      expect(await pass()).toBe(0);
      expect(queries).toHaveLength(1);

      now += 30_000;
      expect(await pass()).toBe(0);
      expect(queries).toHaveLength(1);
      now += 30_000;
      networkDown = false;
      dryRun = false;
      expect(await pass()).toBe(0);
      expect(queries).toHaveLength(2);
      expect(alive(f.h)).toBe(true);

      now += 60_000;
      permitted = true;
      expect(await pass()).toBe(0);
      expect(queries).toHaveLength(2);
      expect(alive(f.h)).toBe(true);
      now += 3_540_000;
      expect(await pass()).toBe(1);
      expect(inspected).toBeGreaterThan(0);
      expect(alive(f.h)).toBe(false);
      expect(internals.agentProcessPid(f.id)).toBeUndefined();
      expect((await sampleParkingMemory(1, roots))?.usedBytes).toBe(0);
    } finally {
      internals.openPermissionDialogs.delete(f.id);
      setEdgeMachineForTests(undefined);
      setActiveConfigForTests(null);
    }
  },
  30_000,
);

test.skipIf(!hasTmux())(
  "Linux liveness and a confirmed wake with an empty park cache track a quiet agent",
  async () => {
    const id = crypto.randomUUID();
    const h = spawnHarness({
      sessionId: id,
      command: `exec '${process.execPath}' -e 'console.log("❯"); setInterval(() => {}, 10000);' -- --session-id ${id}`,
    });
    harnesses.push(h);
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: 5000 });
    const pid = Number(
      tmuxRun([
        "display-message",
        "-p",
        "-t",
        `=${h.tmuxSession}:`,
        "#{pane_pid}",
      ]).stdout.trim(),
    );
    let catalogReads = 0;
    setSyncServiceForTests({
      listManagedSessions: async () => {
        catalogReads++;
        return [{ session_id: id, tmux_session: h.tmuxSession }];
      },
      registerManagedSession: async () => undefined,
      updateSessionAgentStatus: async () => true,
    } as unknown as SyncService);
    try {
      await reconcileSessionLiveness("linux");
      expect(catalogReads).toBe(1);
      expect(internals.agentProcessPid(id)).toBe(pid);

      trackSessionPaneForTests(id, null);
      trackSessionPaneForTests(id, h.tmuxSession, { status: "idle" });
      expect(sessionParkStateForTests(id).parked).toBe(false);
      expect(internals.agentProcessPid(id)).toBeUndefined();
      internals.setResumeInner(async () => true);
      expect(
        await internals.autoResumeSession(
          id,
          "",
          {},
          h.cwd,
          undefined,
          "claude",
        ),
      ).toBe(true);
      expect(internals.agentProcessPid(id)).toBe(pid);
    } finally {
      setSyncServiceForTests(null);
    }
  },
  15_000,
);
