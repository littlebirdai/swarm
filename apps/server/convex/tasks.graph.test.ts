// The task graph on the server (docs/architecture/task-graph.md): readiness
// resolves blockers and parents the page dropped from the database (TG1), an
// edge that closes a loop is refused with its path (TG4), and every graph and
// label change writes task_history through one helper (TG11).
import { describe, expect, test } from "bun:test";
import { isUnblocked } from "@codecast/tasks/graph";
import type { FunctionArgs } from "convex/server";
import {
  scheduledJobs,
  type ServerTest,
} from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { taskTest } from "../test-helpers/tasks.testkit";
import { api, internal } from "./_generated/api";
import { readinessLookups, stampGraphStatus } from "./lib/taskGraph";

const TOKEN = "task-graph-test-token";

async function setup(
  tasks: (Partial<NewRow<"tasks">> & Pick<NewRow<"tasks">, "short_id">)[],
) {
  const world = await taskTest("task graph", TOKEN, tasks);
  const taskIds = Object.fromEntries(
    tasks.map(({ short_id }, i) => [short_id, world.taskIds[i]]),
  );
  return {
    ...world,
    taskIds,
    row: (shortId: string) =>
      world.t.run(async ({ db }) => (await db.get(taskIds[shortId]))!),
  };
}

const ids = (rows: { short_id: string }[]) =>
  rows.map((t) => t.short_id).sort();
const list = (
  t: ServerTest,
  args: Partial<FunctionArgs<typeof api.tasks.list>> = {},
) => t.query(api.tasks.list, { api_token: TOKEN, ...args });

describe("ready (TG1)", () => {
  // The bug: list's page drops done tasks before the ready filter, which then
  // looked each blocker up in that page, so a finished blocker never cleared.
  test("cast task ready lists a task whose blocker finished", async () => {
    const { t } = await setup([
      { short_id: "ct-1", status: "done" },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
      { short_id: "ct-3", blocked_by: ["ct-4"] },
      { short_id: "ct-4" },
    ]);
    expect(ids(await list(t, { ready: true }))).toEqual(["ct-2", "ct-4"]);
  });

  test("a blocker the filters dropped is read, not assumed: open blocks, dropped clears", async () => {
    const { t } = await setup([
      { short_id: "ct-1", labels: ["other"] },
      { short_id: "ct-2", labels: ["x"], blocked_by: ["ct-1"] },
      { short_id: "ct-3", status: "dropped", labels: ["other"] },
      { short_id: "ct-4", labels: ["x"], blocked_by: ["ct-3"] },
    ]);
    expect(ids(await list(t, { ready: true, label: "x" }))).toEqual(["ct-4"]);
  });

  test("a blocker that names nothing does not block; an _id ref resolves by _id", async () => {
    const { t, taskIds } = await setup([
      { short_id: "ct-1", status: "done" },
      { short_id: "ct-2", blocked_by: ["ct-999"] },
      { short_id: "ct-3" },
      { short_id: "ct-5" },
      { short_id: "ct-4" },
    ]);
    await t.run(async ({ db }) => {
      await db.patch(taskIds["ct-3"], { blocked_by: [taskIds["ct-1"]] });
      await db.patch(taskIds["ct-4"], { blocked_by: [taskIds["ct-5"]] });
    });
    expect(ids(await list(t, { ready: true }))).toEqual([
      "ct-2",
      "ct-3",
      "ct-5",
    ]);
  });

  test("a subtask of a parent being worked waits unless subtasks are asked for", async () => {
    const { t, taskIds } = await setup([
      { short_id: "ct-1", status: "in_progress" },
      { short_id: "ct-2" },
    ]);
    await t.run(({ db }) =>
      db.patch(taskIds["ct-2"], { parent_id: taskIds["ct-1"] }),
    );
    expect(ids(await list(t, { ready: true }))).toEqual([]);
    const withSubtasks = await list(t, {
      ready: true,
      include_subtasks: true,
    });
    expect(ids(withSubtasks)).toEqual(["ct-2"]);
    expect(withSubtasks[0].parent_short_id).toBe("ct-1");
  });

  // The CLI tags a row blocked from what the server says still holds it, never
  // from the raw blocked_by, which keeps naming a blocker after it finished.
  test("every listed row carries its verdict and its open blockers", async () => {
    const { t } = await setup([
      { short_id: "ct-1", status: "done" },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
      { short_id: "ct-3", blocked_by: ["ct-2", "ct-404"] },
    ]);
    const rows = await list(t, {});
    const by = (id: string) => rows.find((t) => t.short_id === id)!;
    expect([by("ct-2").ready, by("ct-2").open_blockers]).toEqual([true, []]);
    expect([by("ct-3").ready, by("ct-3").open_blockers]).toEqual([
      false,
      [{ kind: "task", ref: "ct-2", status: "open" }],
    ]);
  });

  test("a blocker in another workspace is never read: it stays unknown and blocks", async () => {
    const { t } = await setup([{ short_id: "ct-2", blocked_by: ["ct-9"] }]);
    await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "foreign blocker");
      const team = await rows.team();
      await rows.task(await rows.user(), {
        short_id: "ct-9",
        status: "done",
        team_id: team,
        workspace: `team:${team}`,
      });
    });
    const rows = await list(t, {});
    expect(rows.map((t) => [t.short_id, t.ready, t.open_blockers])).toEqual([
      ["ct-2", false, [{ kind: "task", ref: "ct-9", status: "unknown" }]],
    ]);
    expect(ids(await list(t, { ready: true }))).toEqual([]);
  });

  test("plans.get returns the blockers and parents its tasks name outside the plan", async () => {
    const { t, owner, taskIds } = await setup([
      { short_id: "ct-1", status: "done" },
      { short_id: "ct-2", blocked_by: ["ct-1", "ct-404"] },
    ]);
    await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "graph plan");
      const task_ids = [taskIds["ct-2"]];
      const plan_id = await rows.plan(owner, { short_id: "pl-1", task_ids });
      for (const id of task_ids) await db.patch(id, { plan_id });
    });
    const plan = await t.query(api.plans.get, {
      api_token: TOKEN,
      short_id: "pl-1",
    });
    expect(plan?.graph_outside).toEqual({
      tasks: [{ _id: taskIds["ct-1"], short_id: "ct-1", status: "done" }],
      searched: ["ct-1", "ct-404"],
    });
  });

  test("plans.webGet stamps each row's blockers, so the plan list's marks agree with /tasks", async () => {
    const { t, web, owner, taskIds } = await setup([
      { short_id: "ct-1", status: "dropped" },
      { short_id: "ct-2", blocked_by: ["ct-1", "ct-3"] },
      { short_id: "ct-3", status: "done" },
    ]);
    await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "graph plan");
      const task_ids = [taskIds["ct-2"], taskIds["ct-3"]];
      const plan_id = await rows.plan(owner, { short_id: "pl-1", task_ids });
      for (const id of task_ids) await db.patch(id, { plan_id });
    });
    const plan = await web.query(api.plans.webGet, { short_id: "pl-1" });
    const step = plan?.tasks.find((t) => t.short_id === "ct-2");
    expect(
      step && "graph_status" in step ? step.graph_status : undefined,
    ).toEqual([
      { ref: "ct-1", short_id: "ct-1", status: "dropped" },
      { ref: "ct-3", short_id: "ct-3", status: "done" },
    ]);
  });

  test("getReadyTasks applies the same rule", async () => {
    const { t, taskIds } = await setup([
      { short_id: "ct-1", status: "done" },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
      { short_id: "ct-3", blocked_by: ["ct-2"] },
      { short_id: "ct-4", triage_status: "suggested" },
      { short_id: "ct-5", status: "in_review" },
      { short_id: "ct-6" },
    ]);
    await t.run(({ db }) =>
      db.patch(taskIds["ct-6"], { parent_id: taskIds["ct-5"] }),
    );
    expect(
      ids(await t.query(api.tasks.getReadyTasks, { api_token: TOKEN })),
    ).toEqual(["ct-2"]);
  });

  // A page can mix workspaces (the web's team view holds a viewer's private
  // rows routed to the team): an edge into another workspace stays unknown
  // even when the page holds the row, so every viewer judges it alike.
  test("a row the page holds in another workspace than its referrer reads as unknown", async () => {
    const { t, owner } = await setup([]);
    await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "mixed workspace page");
      const team_id = await rows.team();
      const team = { team_id, workspace: `team:${team_id}` };
      const first = await rows.task(owner, {
        short_id: "ct-1",
        ...team,
        status: "done",
      });
      const personal = await rows.task(owner, {
        short_id: "ct-2",
        team_id,
        blocked_by: ["ct-1"],
      });
      const shared = await rows.task(owner, {
        short_id: "ct-3",
        ...team,
        blocked_by: ["ct-1"],
      });
      const page: Parameters<typeof stampGraphStatus>[1] = [
        (await ctx.db.get(first))!,
        (await ctx.db.get(personal))!,
        (await ctx.db.get(shared))!,
      ];
      await stampGraphStatus(ctx, page);
      expect(page[1].graph_status).toEqual([]);
      expect(page[2].graph_status).toEqual([
        { ref: "ct-1", short_id: "ct-1", status: "done" },
      ]);
      const lookupsFor = await readinessLookups(ctx, page);
      expect([
        isUnblocked(page[1], lookupsFor(page[1]).statusOf),
        isUnblocked(page[2], lookupsFor(page[2]).statusOf),
      ]).toEqual([false, true]);
    });
  });

  test("webList ready reads the finished blocker its status filter dropped", async () => {
    const { web } = await setup([
      { short_id: "ct-1", status: "done" },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
      { short_id: "ct-3", blocked_by: ["ct-2"] },
    ]);
    const { items } = await web.query(api.tasks.webList, {
      ready: true,
      status: "open",
    });
    expect(ids(items)).toEqual(["ct-2"]);
  });
});

describe("edges that cannot loop (TG4)", () => {
  // ct-1 <- ct-2 <- ct-3: ct-3 waits on ct-2, which waits on ct-1.
  const chain = (): (Partial<NewRow<"tasks">> &
    Pick<NewRow<"tasks">, "short_id">)[] => [
    { short_id: "ct-1", blocks: ["ct-2"] },
    { short_id: "ct-2", blocked_by: ["ct-1"], blocks: ["ct-3"] },
    { short_id: "ct-3", blocked_by: ["ct-2"] },
  ];
  const LOOP =
    "ct-3 already waits on ct-1 (ct-3 → ct-2 → ct-1, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-3 needs ct-1, that edge already exists.";

  test("addDep --blocked-by refuses the closing edge and names the path", async () => {
    const { t, row } = await setup(chain());
    await expect(
      t.mutation(api.tasks.addDep, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocked_by: "ct-3",
      }),
    ).rejects.toThrow(LOOP);
    expect((await row("ct-1")).blocked_by).toBeUndefined();
  });

  test("addDep --blocks refuses it from the other side", async () => {
    const { t } = await setup(chain());
    await expect(
      t.mutation(api.tasks.addDep, {
        api_token: TOKEN,
        short_id: "ct-3",
        blocks: "ct-1",
      }),
    ).rejects.toThrow(LOOP);
  });

  test("a task cannot wait on itself", async () => {
    const { t } = await setup(chain());
    await expect(
      t.mutation(api.tasks.addDep, {
        api_token: TOKEN,
        short_id: "ct-2",
        blocked_by: "ct-2",
      }),
    ).rejects.toThrow("ct-2 cannot wait on itself.");
  });

  test("a finished task in the chain holds nothing back, so the edge is allowed", async () => {
    const tasks = chain().map((task) =>
      task.short_id === "ct-2" ? { ...task, status: "done" as const } : task,
    );
    const { t, row } = await setup(tasks);
    await t.mutation(api.tasks.addDep, {
      api_token: TOKEN,
      short_id: "ct-1",
      blocked_by: "ct-3",
    });
    expect((await row("ct-1")).blocked_by).toEqual(["ct-3"]);
    expect((await row("ct-3")).blocks).toContain("ct-1");
  });

  test("update refuses a loop through blocked_by and through blocks", async () => {
    const { t, row } = await setup(chain());
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocked_by: ["ct-3"],
      }),
    ).rejects.toThrow(LOOP);
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-3",
        blocks: ["ct-1"],
      }),
    ).rejects.toThrow(LOOP);
    // Edges already on the row are not re-judged.
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-3",
      blocked_by: ["ct-2"],
    });
  });

  test("update judges a task private inside a team by its access key, as addDep does", async () => {
    const { t, taskIds } = await setup(chain());
    await t.run(async ({ db }) => {
      const team = await fixtureRows(db, "routed private work").team();
      for (const id of Object.values(taskIds))
        await db.patch(id, { team_id: team });
    });
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocked_by: ["ct-3"],
      }),
    ).rejects.toThrow(LOOP);
  });

  // Readiness never reads across workspaces, so such a blocker would stay
  // unknown and hold the task forever; addDep already refused it.
  test("create and update refuse a dependency in another workspace; a ref naming nothing is kept", async () => {
    const { t } = await setup([{ short_id: "ct-1" }]);
    await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "task outside workspace");
      const team = await rows.team();
      await rows.task(await rows.user(), {
        short_id: "ct-9",
        team_id: team,
        workspace: `team:${team}`,
      });
      await db.insert("counters", { name: "ct", value: 20 });
    });
    const FORBIDDEN = "dependency task belongs to another workspace";
    await expect(
      t.mutation(api.tasks.create, {
        api_token: TOKEN,
        title: "New",
        blocked_by: ["ct-9"],
      }),
    ).rejects.toThrow(FORBIDDEN);
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocked_by: ["ct-9"],
      }),
    ).rejects.toThrow(FORBIDDEN);
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocks: ["ct-9"],
      }),
    ).rejects.toThrow(FORBIDDEN);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      blocked_by: ["ct-404"],
    });
  });

  // A stored ref that names no task reads as missing and blocks nothing, so
  // every ref is stored canonical, or as a wait, or refused (TG3).
  test("create and update store blocker refs canonical and refuse what is no task", async () => {
    const { t, row, taskIds } = await setup([
      { short_id: "ct-1" },
      { short_id: "ct-2" },
    ]);
    await t.run(({ db }) => db.insert("counters", { name: "ct", value: 20 }));
    const { short_id } = await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "New",
      blocked_by: ["CT-01", " ct-1 ", taskIds["ct-2"]],
    });
    expect(
      (await t.run(({ db }) =>
        db
          .query("tasks")
          .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
          .unique(),
      ))!.blocked_by,
    ).toEqual(["ct-1", taskIds["ct-2"]]);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      blocks: ["CT-002"],
    });
    expect((await row("ct-1")).blocks).toEqual(["ct-2"]);
    await expect(
      t.mutation(api.tasks.create, {
        api_token: TOKEN,
        title: "Step",
        blocked_by: ["Design the schema"],
      }),
    ).rejects.toThrow("is not a blocker");
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocked_by: ["#42"],
      }),
    ).rejects.toThrow(
      '"#42" is a wait, not a task: add it with cast task dep ct-1 --blocked-by "#42"',
    );
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        blocks: ["sd-4"],
      }),
    ).rejects.toThrow('"sd-4" is not a task');
  });

  test("create turns a wait-shaped blocked_by ref into a wait, as an older CLI sends it", async () => {
    const { t } = await setup([{ short_id: "ct-1" }]);
    await t.run(({ db }) => db.insert("counters", { name: "ct", value: 20 }));
    const { short_id } = await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "Later",
      blocked_by: ["ct-1", "2h"],
    });
    const row = (await t.run(({ db }) =>
      db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .unique(),
    ))!;
    expect(row.blocked_by).toEqual(["ct-1"]);
    expect(row.waits).toMatchObject([{ kind: "time", state: "waiting" }]);
    expect(
      await scheduledJobs(t, internal.taskWaits.settleTimeWait),
    ).toHaveLength(1);
  });

  test("a graph too large to walk whole is refused, not half checked", async () => {
    const wide = Array.from({ length: 2000 }, (_, i) => ({
      short_id: `ct-${i + 1}`,
      blocked_by: ["ct-5000"],
    }));
    const { t } = await setup([
      ...wide,
      { short_id: "ct-5000" },
      { short_id: "ct-6000" },
    ]);
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-6000",
        blocked_by: wide.map((t) => t.short_id),
      }),
    ).rejects.toThrow(
      "Cannot check ct-6000's dependencies for a loop: more than 2000 open tasks wait behind it.",
    );
  });

  test("create refuses blockers that already wait on the id it takes", async () => {
    // The counter hands out ct-2, which ct-1 already names as its blocker.
    const { t } = await setup([{ short_id: "ct-1", blocked_by: ["ct-2"] }]);
    await t.run(({ db }) => db.insert("counters", { name: "ct", value: 1 }));
    await expect(
      t.mutation(api.tasks.create, {
        api_token: TOKEN,
        title: "New",
        blocked_by: ["ct-1"],
      }),
    ).rejects.toThrow(
      "ct-1 already waits on ct-2 (ct-1 → ct-2, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-1 needs ct-2, that edge already exists.",
    );
  });
});

describe("history (TG11)", () => {
  const history = async (t: ServerTest, field: string) =>
    (await t.run(({ db }) => db.query("task_history").collect())).filter(
      (h) => h.field === field,
    );

  test("addDep and removeDep record the blocked task's blocked_by, whichever side was named", async () => {
    const { t, taskIds } = await setup([
      { short_id: "ct-1" },
      { short_id: "ct-2" },
    ]);
    await t.mutation(api.tasks.addDep, {
      api_token: TOKEN,
      short_id: "ct-2",
      blocked_by: "ct-1",
    });
    await t.mutation(api.tasks.removeDep, {
      api_token: TOKEN,
      short_id: "ct-1",
      blocks: "ct-2",
    });
    expect(
      (await history(t, "blocked_by")).map((h) => [
        h.task_id,
        h.old_value,
        h.new_value,
        h.actor_type,
      ]),
    ).toEqual([
      [taskIds["ct-2"], "", "ct-1", "user"],
      [taskIds["ct-2"], "ct-1", "", "user"],
    ]);
  });

  test("update records labels and blocked_by, and skips a write that changed nothing", async () => {
    const { t } = await setup([
      { short_id: "ct-1", labels: ["a"] },
      { short_id: "ct-2" },
    ]);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      labels: ["a", "b"],
      blocked_by: ["ct-2"],
    });
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      labels: ["a", "b"],
    });
    expect(
      (await history(t, "labels")).map((h) => [h.old_value, h.new_value]),
    ).toEqual([["a", "a, b"]]);
    expect(
      (await history(t, "blocked_by")).map((h) => [h.old_value, h.new_value]),
    ).toEqual([["", "ct-2"]]);
  });

  test("status keeps the row shape it always had", async () => {
    const { t, owner, taskIds } = await setup([{ short_id: "ct-1" }]);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "in_progress",
    });
    const [row] = await history(t, "status");
    expect(row).toMatchObject({
      task_id: taskIds["ct-1"],
      user_id: owner,
      actor_type: "user",
      action: "updated",
      old_value: "open",
      new_value: "in_progress",
    });
  });
});
