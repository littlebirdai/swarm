import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexError } from "convex/values";
import { SyncService } from "./syncService.js";
import {
  readTaskClaimToken,
  readTaskPulseFor,
  storeTaskClaim,
} from "./taskPulse.js";
import { parseWorkflowSource } from "./workflow/parser.js";
import { runWorkflow } from "./workflow/runner.js";

function withTempCodecastDir(fn: () => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "claim-renew-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    });
}

describe("heartbeat task claim renewal and workflow claim propagation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("heartbeatManagedSessionsBatch renews expiring task pulses and clears stale tokens on CONFLICT", async () => {
    await withTempCodecastDir(async () => {
      const calls: Array<{ name: string; args: Record<string, any> }> = [];
      const sync = new SyncService({
        convexUrl: "http://localhost:0",
        userId: "u-test",
        authToken: "tok-test",
      });
      const futureRenewed = Date.now() + 300_000;
      (sync as any).client = {
        mutation: async (name: string, args: Record<string, any>) => {
          calls.push({ name, args });
          if (name === "managedSessions:heartbeatBatch") {
            return { updated: args.sessions.length, unknown: [] };
          }
          if (name === "tasks:heartbeat" && args.short_id === "ct-1") {
            return {
              success: true,
              claim_token: 2,
              lease_until: futureRenewed,
            };
          }
          if (name === "tasks:heartbeat" && args.short_id === "ct-2") {
            throw new ConvexError({
              code: "CONFLICT",
              reason: "expired",
              message: "ct-2 claim lease has expired",
            });
          }
          return null;
        },
      };

      storeTaskClaim("sess-1", "ct-1", 2, Date.now() + 60_000);
      storeTaskClaim("sess-2", "ct-2", 5, Date.now() + 60_000);

      await sync.heartbeatManagedSessionsBatch([
        { session_id: "sess-1", agent_status: "working" },
        { session_id: "sess-2", agent_status: "idle" },
      ]);

      const taskHeartbeats = calls.filter((c) => c.name === "tasks:heartbeat");
      expect(taskHeartbeats).toEqual([
        {
          name: "tasks:heartbeat",
          args: {
            api_token: "tok-test",
            short_id: "ct-1",
            claim_token: 2,
            conversation_id: "sess-1",
          },
        },
        {
          name: "tasks:heartbeat",
          args: {
            api_token: "tok-test",
            short_id: "ct-2",
            claim_token: 5,
            conversation_id: "sess-2",
          },
        },
      ]);
      expect(readTaskPulseFor("sess-1")).toMatchObject({
        task: "ct-1",
        claim_token: 2,
        lease_until: futureRenewed,
      });
      expect(readTaskClaimToken("sess-2", "ct-2")).toBeUndefined();
    });
  });

  test("workflow runner attaches stored claim_token on task updates and clears on 409 CONFLICT", async () => {
    await withTempCodecastDir(async () => {
      const requests: Array<{ route: string; body: Record<string, any> }> = [];
      let failConflict = false;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const route = new URL(url).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        requests.push({ route, body });
        if (route === "/cli/work/get") {
          return new Response(
            JSON.stringify({ short_id: "ct-77", status: "in_progress" }),
            { status: 200 },
          );
        }
        if (route === "/cli/work/update" && failConflict) {
          return new Response(
            JSON.stringify({
              code: "CONFLICT",
              reason: "stale_token",
              error: "ct-77 claim token is stale",
            }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch;

      storeTaskClaim("run-sess-1", "ct-77", 11, Date.now() + 300_000);

      const dir = mkdtempSync(join(tmpdir(), "wf-claim-"));
      try {
        const failingGraph = parseWorkflowSource(`
          digraph fail_claim {
            start [shape=Mdiamond]
            cmd [shape=parallelogram, script="exit 1"]
            exit [shape=Msquare]
            start -> cmd
            cmd -> exit [condition="outcome=success"]
          }
        `);

        await runWorkflow(failingGraph, {
          cwd: dir,
          taskId: "ct-77",
          runSession: "run-sess-1",
          convexSiteUrl: "https://example.invalid",
          apiToken: "tok-wf",
        });

        const firstUpdate = requests.find(
          (r) => r.route === "/cli/work/update",
        );
        expect(firstUpdate?.body).toMatchObject({
          short_id: "ct-77",
          status: "open",
          claim_token: 11,
          conversation_id: "run-sess-1",
        });
        expect(readTaskClaimToken("run-sess-1", "ct-77")).toBeUndefined();

        storeTaskClaim("run-sess-2", "ct-77", 12, Date.now() + 300_000);
        failConflict = true;
        await runWorkflow(failingGraph, {
          cwd: dir,
          taskId: "ct-77",
          runSession: "run-sess-2",
          convexSiteUrl: "https://example.invalid",
          apiToken: "tok-wf",
        });
        expect(readTaskClaimToken("run-sess-2", "ct-77")).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
