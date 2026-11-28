import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow, type RunOptions } from "./runner.js";

isolateCodecastDirEachTest("cast-wf-claims-");

describe("workflow/runner task claim lifecycle", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let origError: typeof console.error;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-claims-dir-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    origError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    console.error = origError;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reopen before implement binds hand conversation with take instead of minting a sessionless claim", async () => {
    const calls: Array<{ route: string; body: Record<string, any> }> = [];
    let taskStatus = "in_review";
    let executionStatus = "done";
    let claimHolder: string | undefined;
    let handStarted = false;

    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      const reply = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status });

      if (route === "/cli/work/get") {
        return reply({
          short_id: "ct-1",
          title: "Fix thing",
          status: taskStatus,
          execution_status: executionStatus,
        });
      }
      if (route === "/cli/spawn") {
        return reply({
          conversation_id: "conv-hand-1",
          short_id: "hnd1",
        });
      }
      if (route === "/cli/work/update") {
        if (body.status === "in_progress") {
          if (!body.conversation_id) {
            return reply(
              {
                code: "CONFLICT",
                reason: "busy",
                error: "sessionless reopen forbidden",
              },
              409,
            );
          }
          taskStatus = "in_progress";
          executionStatus = "";
          claimHolder = body.conversation_id;
          return reply({ success: true, claim_token: 2 });
        }
        return reply({ success: true });
      }
      if (route === "/cli/inbox") {
        if (claimHolder === "conv-hand-1" && !handStarted) {
          handStarted = true;
          taskStatus = "in_review";
          executionStatus = "done";
          claimHolder = undefined;
        }
        return reply({
          sessions: [
            {
              id: "conv-hand-1",
              work_state: "idle",
              is_live: true,
              message_count: 2,
            },
          ],
        });
      }
      return reply({ ok: true });
    }) as typeof fetch;

    const g = parseWorkflowSource(`digraph reopen_test {
      start [shape=Mdiamond]
      implement [shape=box, label="Implement", backend=session, agent=claude, prompt="Fix $task_id"]
      exit [shape=Msquare]
      start -> implement
      implement -> exit [condition="handoff == 'done'"]
    }`);

    const outcome = await runWorkflow(g, {
      cwd: tmpDir,
      taskId: "ct-1",
      runId: "run-reopen-1",
      apiToken: "tok",
      convexSiteUrl: "https://convex.test",
      pollIntervalMs: 1,
      stationPollMs: 1,
    } as RunOptions);

    expect(outcome).toBe("completed");
    expect(handStarted).toBe(true);
    const reopenUpdate = calls.find(
      (c) => c.route === "/cli/work/update" && c.body.status === "in_progress",
    );
    expect(reopenUpdate?.body).toMatchObject({
      short_id: "ct-1",
      status: "in_progress",
      conversation_id: "conv-hand-1",
      take: true,
    });
    expect(
      calls.some(
        (c) =>
          c.route === "/cli/workflow-runs/progress" &&
          typeof c.body.log_note === "string",
      ),
    ).toBe(false);
  });

  test("failure cleanup with a held hand claim transitions via workflow-runs/task-transition on both failure and stop", async () => {
    for (const mode of ["failure", "stop"] as const) {
      const calls: Array<{ route: string; body: Record<string, any> }> = [];
      let taskStatus = "in_progress";
      let claimHolder: string | undefined = "conv-hand-held";

      globalThis.fetch = (async (url: any, init: any) => {
        const route = String(url).replace(/^https?:\/\/[^/]+/, "");
        const body = JSON.parse(init?.body || "{}");
        calls.push({ route, body });
        const reply = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status });

        if (route === "/cli/work/get") {
          return reply({
            short_id: "ct-2",
            title: "Broken task",
            status: taskStatus,
            execution_status: "",
          });
        }
        if (route === "/cli/spawn") {
          return reply({
            conversation_id: "conv-hand-held",
            short_id: "hnd2",
          });
        }
        if (route === "/cli/inbox") {
          return reply({
            sessions: [
              {
                id: "conv-hand-held",
                work_state: "stopped",
                is_live: false,
                is_killed: true,
                message_count: 1,
              },
            ],
          });
        }
        if (route === "/cli/work/update") {
          if (claimHolder && body.conversation_id !== claimHolder) {
            return reply(
              {
                code: "CONFLICT",
                reason: "wrong_holder",
                error: "ct-2 is claimed by another holder",
              },
              409,
            );
          }
          taskStatus = body.status ?? taskStatus;
          return reply({ success: true });
        }
        if (route === "/cli/workflow-runs/task-transition") {
          claimHolder = undefined;
          taskStatus = body.status;
          return reply({ success: true, status: body.status });
        }
        return reply({ ok: true });
      }) as typeof fetch;

      const onFailure = mode === "stop" ? 'on_failure="stop"' : "";
      const g = parseWorkflowSource(`digraph cleanup_test {
        graph [${onFailure}]
        start [shape=Mdiamond]
        implement [shape=box, label="Implement", backend=session, agent=claude, prompt="Fix $task_id"]
        exit [shape=Msquare]
        start -> implement
        implement -> exit [condition="handoff == 'done'"]
      }`);

      const outcome = await runWorkflow(g, {
        cwd: tmpDir,
        taskId: "ct-2",
        runId: `run-${mode}`,
        apiToken: "tok",
        convexSiteUrl: "https://convex.test",
        pollIntervalMs: 1,
        stationPollMs: 1,
      } as RunOptions);

      expect(outcome).toBe("failed");
      expect(claimHolder).toBeUndefined();
      expect(taskStatus).toBe("open");
      const transitions = calls.filter(
        (c) => c.route === "/cli/workflow-runs/task-transition",
      );
      expect(transitions.length).toBeGreaterThanOrEqual(1);
      expect(transitions[0]?.body).toMatchObject({
        run_id: `run-${mode}`,
        short_id: "ct-2",
        status: "open",
      });
      expect(
        calls.some(
          (c) => c.route === "/cli/work/update" && c.body.status === "open",
        ),
      ).toBe(false);
    }
  });
});
