// the-line.md L7: a chain step reports its output head through updateProgress
// as result_preview, and the run panel shows it on the node. A later report
// for the same node without a preview keeps the stored one.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const TOKEN = "chain-progress-token";

async function setup() {
  const t = serverTest();
  const runId = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "chain progress");
    const owner = await rows.user();
    await rows.token(owner, TOKEN);
    return db.insert("workflow_runs", {
      user_id: owner,
      workflow_name: "chain-implement",
      status: "running",
      node_statuses: [],
      created_at: 1,
      updated_at: 1,
    });
  });

  return {
    report: (
      fields: Partial<FunctionArgs<typeof api.workflow_runs.updateProgress>>,
    ) =>
      t.mutation(api.workflow_runs.updateProgress, {
        api_token: TOKEN,
        run_id: runId,
        current_node_id: "step-1",
        node_id: "step-1",
        ...fields,
      }),
    readRun: () => t.run(async ({ db }) => (await db.get(runId))!),
  };
}

describe("workflow_runs.updateProgress result_preview (the-line.md L7)", () => {
  test("stores the step's output head on the node and keeps it on a later report", async () => {
    const { report, readRun } = await setup();
    await report({ node_status: "running" });
    await report({
      node_status: "completed",
      outcome: "success",
      result_preview: "the plan",
    });
    const node = (await readRun()).node_statuses.find(
      (n) => n.node_id === "step-1",
    );
    expect(node).toMatchObject({
      status: "completed",
      outcome: "success",
      result_preview: "the plan",
    });

    await report({
      node_status: "failed",
      run_status: "failed",
      fail_reason: "planner exited 2",
    });
    const run = await readRun();
    expect(run.status).toBe("failed");
    expect(run.fail_reason).toBe("planner exited 2");
    expect(run.node_statuses[0].result_preview).toBe("the plan");
  });

  test("a progress line while the node runs keeps its entry time; a new visit restarts it and drops the last visit's line", async () => {
    const { report, readRun } = await setup();
    const node = async () =>
      (await readRun()).node_statuses.find((n) => n.node_id === "step-1")!;
    const realNow = Date.now;
    try {
      Date.now = () => 1_000;
      await report({ node_status: "running", visits: 1 });
      Date.now = () => 61_000;
      await report({
        node_status: "running",
        visits: 1,
        result_preview: "CI: 9 of 14 jobs",
      });
      expect(await node()).toMatchObject({
        started_at: 1_000,
        result_preview: "CI: 9 of 14 jobs",
      });
      Date.now = () => 120_000;
      await report({
        node_status: "completed",
        outcome: "success",
        result_preview: "CI red on #12: 2 failures in web",
      });
      Date.now = () => 300_000;
      await report({ node_status: "running", visits: 2 });
      expect((await node()).started_at).toBe(300_000);
      expect((await node()).result_preview).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});
