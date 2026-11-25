import { describe, expect, spyOn, test } from "bun:test";
import { serverTest } from "../../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../../test-helpers/rows.testkit";
import type { Id } from "../_generated/dataModel";
import { currentDecisions } from "./superseded";

async function setup(pinned = false) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "superseded decisions");
    const user = await rows.user();
    const first = await rows.task(user);
    const second = await rows.task(user);
    const workflow = await db.insert("workflows", {
      user_id: user,
      name: "Release",
      slug: "release",
      nodes: pinned
        ? []
        : [
            { id: "build", type: "agent", label: "Build", shape: "box" },
            { id: "ship", type: "human", label: "Ship", shape: "diamond" },
          ],
      edges: [],
      created_at: 1,
      updated_at: 1,
    });
    return { user, first, second, workflow };
  });
  const run = (fields: Partial<NewRow<"workflow_runs">>) =>
    t.run(({ db }) =>
      db.insert("workflow_runs", {
        user_id: ids.user,
        workflow_id: ids.workflow,
        status: "paused",
        node_statuses: [],
        created_at: 1,
        updated_at: 1,
        ...fields,
      }),
    );
  return { t, ...ids, run };
}

const decision = (
  _id: string,
  workflow_run_id: Id<"workflow_runs">,
  gate_node_id: string,
  task_id?: Id<"tasks">,
) => ({
  _id,
  status: "pending" as const,
  workflow_run_id,
  gate_node_id,
  task_id,
});

describe("currentDecisions", () => {
  test("a queue of one line's decisions reads the line's graph once and drops the card whose gate is gone", async () => {
    const c = await setup();
    const dropped = await c.run({
      gate_node_id: "decide",
      task_id: c.first,
      created_at: 10,
    });
    const current = await c.run({
      gate_node_id: "ship",
      task_id: c.second,
      created_at: 20,
    });
    const rows = [
      decision("d1", dropped, "decide", c.first),
      ...["d2", "d3", "d4"].map((id) =>
        decision(id, current, "ship", c.second),
      ),
    ];
    await c.t.query(async (ctx) => {
      const query = spyOn(ctx.db, "query");
      const get = spyOn(ctx.db, "get");
      const kept = await currentDecisions(ctx, rows);
      expect(kept.map((d) => d._id)).toEqual(["d2", "d3", "d4"]);
      expect(
        query.mock.calls.filter(([table]) => table === "workflow_versions"),
      ).toHaveLength(1);
      expect(
        query.mock.calls.filter(([table]) => table === "workflow_runs"),
      ).toHaveLength(5);
      expect(get.mock.calls.filter(([id]) => id === c.workflow)).toHaveLength(
        1,
      );
    });
  });

  test("a card whose problem has a later run is dropped; one whose run is its problem's newest stands", async () => {
    const c = await setup();
    const current = await c.run({
      gate_node_id: "ship",
      task_id: c.second,
      created_at: 20,
    });
    const rows = [decision("d2", current, "ship", c.second)];
    const read = () => c.t.query((ctx) => currentDecisions(ctx, rows));
    expect((await read()).map((d) => d._id)).toEqual(["d2"]);
    await c.run({ status: "running", task_id: c.second, created_at: 30 });
    expect(await read()).toEqual([]);
  });
});

describe("currentDecisions over pinned runs", () => {
  test("reads each pin's version row and the line once, never a graph or the row", async () => {
    const c = await setup(true);
    const { graph, versions, runs } = await c.t.run(async ({ db }) => {
      const graph = await db.insert("workflow_version_graphs", {
        workflow_id: c.workflow,
        key: "graph",
        snapshot: {
          name: "Release",
          source: "",
          nodes: [],
          edges: [],
          file: "",
          files: [],
        },
      });
      const versions = [];
      const runs = [];
      for (let i = 0; i < 40; i++) {
        const version = await db.insert("workflow_versions", {
          workflow_id: c.workflow,
          line: "builtin:team:codecast",
          at: i,
          graph_hash: "h",
          graph_id: graph,
          nodes: [
            { id: "build", h: "b" },
            { id: "decide", h: "d" },
          ],
          changed: [],
          by: c.user,
        });
        versions.push(version);
        runs.push(
          await db.insert("workflow_runs", {
            user_id: c.user,
            workflow_id: c.workflow,
            status: "paused",
            gate_node_id: "decide",
            graph_version_id: version,
            node_statuses: [],
            created_at: i,
            updated_at: i,
          }),
        );
      }
      return { graph, versions, runs };
    });
    const rows = runs.map((id, i) => decision(`d${i}`, id, "decide"));
    await c.t.query(async (ctx) => {
      const query = spyOn(ctx.db, "query");
      const get = spyOn(ctx.db, "get");
      expect(await currentDecisions(ctx, rows)).toEqual(rows);
      expect(
        query.mock.calls.filter(([table]) => table === "workflow_versions"),
      ).toHaveLength(1);
      const ids = get.mock.calls.map(([id]) => id);
      expect(ids.filter((id) => id === graph || id === c.workflow)).toEqual([]);
      expect(
        ids.filter((id) => versions.includes(id as Id<"workflow_versions">)),
      ).toEqual(versions);
    });
  });
});
