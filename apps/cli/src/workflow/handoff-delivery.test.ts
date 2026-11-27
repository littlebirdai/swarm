import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow } from "./runner.js";

isolateCodecastDirEachTest("cast-handoff-delivery-");

test("each visit asks the same session for a handoff even if its pin has not changed", async () => {
  const graph = parseWorkflowSource(`digraph line {
    start [shape=Mdiamond]
    implement [backend=session, agent=claude, prompt="build it"]
    verify [shape=parallelogram, script="true"]
    exit [shape=Msquare]
    start -> implement
    implement -> verify [condition="handoff = done"]
    verify -> implement [condition="implement.visits < 2"]
    verify -> exit [condition="implement.visits >= 2"]
  }`);
  const session = {
    id: "conv_hand",
    work_state: "needs_input",
    is_live: false,
    message_count: 22,
  };
  const ids = new Set<string>();
  const asks: string[] = [];
  let task: { status: string; execution_status?: string } = {
    status: "in_progress",
  };
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    switch (new URL(String(url)).pathname) {
      case "/cli/spawn":
        return Response.json({
          conversation_id: session.id,
          short_id: "jx7hand",
        });
      case "/cli/inbox":
        return Response.json({ sessions: [session] });
      case "/cli/sessions/state/get":
        return Response.json({ state: "", status: "", at: 42 });
      case "/cli/work/get":
        return Response.json(task);
      case "/cli/work/update":
        task = { status: body.status ?? task.status };
        break;
      case "/cli/messages/send":
        asks.push(body.to);
        if (!ids.has(body.client_id)) {
          ids.add(body.client_id);
          task = { status: "in_review", execution_status: "done" };
        }
        break;
    }
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch);
  const cwd = mkdtempSync(join(tmpdir(), "cast-handoff-"));
  try {
    expect(
      await runWorkflow(graph, {
        cwd,
        runId: "run-1",
        runSession: "conv_run",
        taskId: "ct-9",
        apiToken: "test",
        convexSiteUrl: "https://convex.test",
        pollIntervalMs: 1,
        handoffAskGraceMs: 50,
      }),
    ).toBe("completed");
    expect(asks).toEqual([session.id, session.id]);
    expect(ids.size).toBe(2);
  } finally {
    fetch.mockRestore();
    rmSync(cwd, { recursive: true });
  }
});
