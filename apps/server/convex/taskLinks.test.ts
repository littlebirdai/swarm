// Links that do not block (docs/architecture/task-graph.md TG5): found_during
// fills itself from the creating session's bound task, superseding and
// marking a duplicate move the old task's dependents to the replacement (and
// refuse a loop) and reopening or unmarking moves them back, related is
// mirrored on both rows, and every link reaches `cast task show`/`context`
// resolved.
import { describe, expect, test } from "bun:test";
import {
  OTHER,
  SESSION,
  TOKEN,
  setup,
  task,
} from "../test-helpers/taskLinks.testkit";
import { api } from "./_generated/api";

describe("found_during (TG5)", () => {
  test("fills from the creating session's bound task and records it", async () => {
    const c = await setup([task("ct-1")], {
      active_task_id: "task_ct-1",
    });
    const { short_id } = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "Found bug",
      conversation_id: SESSION,
    });
    expect((await c.row(short_id)).found_during).toBe("ct-1");
    expect(
      (await c.read("task_history"))
        .filter((h: any) => h.field === "found_during")
        .map((h: any) => h.new_value),
    ).toEqual(["ct-1"]);
  });

  test("skips the bound task's own subtasks, deep ones included, and its plan's steps", async () => {
    const c = await setup(
      [
        task("ct-1", { plan_id: "plan_1" }),
        task("ct-2", { parent_id: "task_ct-1" }),
      ],
      { active_task_id: "task_ct-1" },
    );
    const sub = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "Sub",
      conversation_id: SESSION,
      parent_id: "ct-1",
    });
    const deep = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "Deeper",
      conversation_id: SESSION,
      parent_id: "ct-2",
    });
    const step = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "Step",
      conversation_id: SESSION,
      plan_id: "pl-1",
    });
    for (const r of [sub, deep, step])
      expect((await c.row(r.short_id)).found_during).toBeUndefined();
  });

  test("an explicit value wins, and none skips the default", async () => {
    const c = await setup([task("ct-1"), task("ct-5")], {
      active_task_id: "task_ct-1",
    });
    const explicit = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "A",
      conversation_id: SESSION,
      found_during: "ct-5",
    });
    const none = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "B",
      conversation_id: SESSION,
      found_during: "none",
    });
    expect((await c.row(explicit.short_id)).found_during).toBe("ct-5");
    expect((await c.row(none.short_id)).found_during).toBeUndefined();
  });

  test("an explicit task in another workspace is refused; a bound one there is skipped", async () => {
    const foreign = task("ct-9", {
      user_id: OTHER,
      team_id: "team_x",
      workspace: "team:team_x",
    });
    const c = await setup([foreign], {
      active_task_id: "task_ct-9",
    });
    await c.join("team_x");
    await expect(
      c.t.mutation(api.tasks.create, {
        api_token: TOKEN,
        title: "A",
        found_during: "ct-9",
      }),
    ).rejects.toThrow(/another workspace|not found/i);
    const auto = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "B",
      conversation_id: SESSION,
    });
    expect((await c.row(auto.short_id)).found_during).toBeUndefined();
  });

  test("the source lists what was found there; show and context resolve every link", async () => {
    const c = await setup([
      task("ct-1", { related: ["ct-3"] }),
      task("ct-2", {
        found_during: "ct-1",
        superseded_by: "ct-3",
        status: "dropped",
      }),
      task("ct-3", { related: ["ct-1"] }),
    ]);
    const shown = await c.t.query(api.tasks.get, {
      api_token: TOKEN,
      short_id: "ct-2",
    });
    expect(shown.links.found_during.short_id).toBe("ct-1");
    expect(shown.links.superseded_by.short_id).toBe("ct-3");
    const ctx1 = await c.t.query(api.tasks.context, {
      api_token: TOKEN,
      short_id: "ct-1",
    });
    expect(ctx1.links.found_here).toEqual([
      { short_id: "ct-2", title: "Title ct-2", status: "dropped" },
    ]);
    expect(ctx1.links.related.map((r: any) => r.short_id)).toEqual(["ct-3"]);
  });

  test("show lists every blocker with its live state, done, gone and another workspace's alike", async () => {
    const c = await setup([
      task("ct-1", { status: "done", blocks: ["ct-4"] }),
      task("ct-2", { workspace: `user:${OTHER}`, user_id: OTHER }),
      task("ct-4", {
        blocked_by: ["ct-1", "task_ct-1", "ct-9", "ct-2"],
        blocks: ["ct-5"],
      }),
      task("ct-5", { blocked_by: ["ct-4"] }),
    ]);
    const shown = await c.t.query(api.tasks.get, {
      api_token: TOKEN,
      short_id: "ct-4",
    });
    expect(shown.links.blocked_by).toEqual([
      { kind: "task", ref: "ct-1", status: "done", title: "Title ct-1" },
      { kind: "task", ref: "ct-9", missing: true },
      { kind: "task", ref: "ct-2", status: "unknown" },
    ]);
    expect(shown.links.blocks).toEqual([
      { short_id: "ct-5", title: "Title ct-5", status: "open" },
    ]);
  });

  test("a blocks entry whose task no longer waits on this one is not listed", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2", "ct-3", "ct-4"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["task_ct-1"] }),
      task("ct-4", { blocked_by: ["ct-9"] }),
    ]);
    const shown = await c.t.query(api.tasks.get, {
      api_token: TOKEN,
      short_id: "ct-1",
    });
    expect(shown.links.blocks.map((r: any) => r.short_id)).toEqual([
      "ct-2",
      "ct-3",
    ]);
  });
});

describe("supersede (TG5)", () => {
  test("drops the old task with a note, sets superseded_by, and moves its dependents", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2", "ct-3", "ct-4"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["task_ct-1", "ct-9"] }),
      task("ct-4", { blocked_by: ["ct-1"], status: "done" }),
      task("ct-5"),
      task("ct-9"),
    ]);
    const res = await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
      note: "Rewritten scope.",
    });
    expect(res.moved).toEqual(["ct-2", "ct-3"]);
    const old = await c.row("ct-1");
    expect([old.status, old.superseded_by, old.blocks]).toEqual([
      "dropped",
      "ct-5",
      ["ct-4"],
    ]);
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-5"]);
    expect((await c.row("ct-3")).blocked_by).toEqual(["ct-9", "ct-5"]);
    // A finished dependent keeps its history.
    expect((await c.row("ct-4")).blocked_by).toEqual(["ct-1"]);
    expect((await c.row("ct-5")).blocks).toEqual(["ct-2", "ct-3"]);
    expect((await c.read("task_comments")).map((c: any) => c.text)).toEqual([
      "Superseded by ct-5. Rewritten scope. Its dependents now wait on it: ct-2, ct-3.",
    ]);
    expect(await c.history("ct-1", "superseded_by")).toEqual([["", "ct-5"]]);
    expect(await c.history("ct-2", "blocked_by")).toEqual([["ct-1", "ct-5"]]);
  });

  test("a move that would close a loop is refused and nothing is written", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-2"] }),
    ]);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-1",
        by: "ct-5",
      }),
    ).rejects.toThrow(/loop/);
    expect([
      (await c.row("ct-1")).status,
      (await c.row("ct-2")).blocked_by,
    ]).toEqual(["open", ["ct-1"]]);
  });

  test("the replacement's own edge to the old task just goes", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-1"] }),
    ]);
    const res = await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect(res.moved).toEqual([]);
    expect((await c.row("ct-5")).blocked_by).toEqual([]);
    expect((await c.row("ct-5")).blocks ?? []).toEqual([]);
    expect((await c.row("ct-1")).blocks).toEqual([]);
    expect(await c.comments("ct-1")).toEqual(["Superseded by ct-5."]);
    // That edge was its last blocker, so it is released and told.
    expect(await c.comments("ct-5")).toEqual([
      "Unblocked: ct-1 superseded by ct-5",
    ]);
  });

  test("a blocks entry whose task no longer waits on the old task gains no edge and is dropped", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: [] }),
      task("ct-3", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    const res = await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect(res.moved).toEqual(["ct-3"]);
    expect((await c.row("ct-2")).blocked_by).toEqual([]);
    expect(await c.history("ct-2", "blocked_by")).toEqual([]);
    expect((await c.row("ct-5")).blocks).toEqual(["ct-3"]);
    expect((await c.row("ct-1")).blocks).toEqual([]);
  });

  test("a done replacement releases the moved dependents and tells them", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-1", "ct-9"] }),
      task("ct-5", { status: "done" }),
      task("ct-9"),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-5"]);
    expect(await c.comments("ct-2")).toEqual([
      "Unblocked: ct-1 superseded by ct-5",
    ]);
    // Still waits on ct-9.
    expect(await c.comments("ct-3")).toEqual([]);
  });

  test("superseding an already dropped task re-blocks without an unblocked note", async () => {
    const c = await setup([
      task("ct-1", { status: "dropped", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5", { status: "done" }),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-5"]);
    expect(await c.comments("ct-2")).toEqual([]);
  });

  test("superseding a dropped task tells a released dependent it is blocked again", async () => {
    const c = await setup([
      task("ct-1", { status: "dropped", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], status: "in_progress" }),
      task("ct-5"),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect(await c.comments("ct-2")).toEqual([
      "Blocked again: ct-1 superseded by ct-5, so it waits on ct-5",
    ]);
  });

  test("a dependent that already names the replacement by _id gains no second edge", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1", "task_ct-5"] }),
      task("ct-5"),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual([c.id("ct-5")]);
  });

  test("a dependent the replacement's mirror names by _id is not added a second time", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1", "ct-5"] }),
      task("ct-5", { blocks: ["task_ct-2"] }),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-5"]);
    expect((await c.row("ct-5")).blocks).toEqual([c.id("ct-2")]);
  });

  test("a session bound to the old task is released, and its next task is not found there", async () => {
    const c = await setup(
      [task("ct-1", { conversation_ids: ["conv_1"] }), task("ct-5")],
      { active_task_id: "task_ct-1" },
    );
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
      conversation_id: SESSION,
    });
    expect((await c.read("conversations"))[0].active_task_id).toBeUndefined();
    await c.t.run(({ db }) =>
      db.patch(c.conversation, { active_task_id: c.id("ct-1") }),
    );
    const { short_id } = await c.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "Later",
      conversation_id: SESSION,
    });
    expect((await c.row(short_id)).found_during).toBeUndefined();
  });

  test("reopening a superseded task clears superseded_by and takes its dependents back", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-1", "ct-5"] }),
      task("ct-5", { blocks: ["ct-3"] }),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "open",
    });
    const old = await c.row("ct-1");
    expect([old.status, old.superseded_by, old.blocks]).toEqual([
      "open",
      undefined,
      ["ct-3", "ct-2"],
    ]);
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    // It waited on the replacement before the move too, so it keeps it.
    expect((await c.row("ct-3")).blocked_by).toEqual(["ct-5", "ct-1"]);
    expect((await c.row("ct-5")).blocks).toEqual(["ct-3"]);
    expect(await c.history("ct-1", "superseded_by")).toEqual([
      ["", "ct-5"],
      ["ct-5", ""],
    ]);
  });

  test("a supersede from a session is recorded as the agent's", async () => {
    const c = await setup([task("ct-1"), task("ct-5")]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
      conversation_id: SESSION,
    });
    const h = (await c.read("task_history")).find(
      (r: any) => r.field === "superseded_by",
    );
    expect([h.actor_type, h.conversation_id]).toEqual([
      "agent",
      c.conversation,
    ]);
  });

  test("a dependent missing from the blocks mirror is found through the plan and moved", async () => {
    const c = await setup([
      task("ct-1", { plan_id: "plan_1" }),
      task("ct-2", { plan_id: "plan_1", blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    const res = await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect(res.moved).toEqual(["ct-2"]);
    expect([
      (await c.row("ct-2")).blocked_by,
      (await c.row("ct-5")).blocks,
    ]).toEqual([["ct-5"], ["ct-2"]]);
  });

  test("a plan made from a template writes the blocks mirror, so superseding its blocker moves the dependent", async () => {
    const c = await setup([task("ct-5")]);
    const template = await c.t.run(({ db }) =>
      db.insert("plan_templates", {
        user_id: c.owner,
        created_at: 1,
        updated_at: 1,
        name: "T",
        goal_template: "G",
        task_templates: [
          { title: "First" },
          { title: "Second", blocked_by_indices: [0] },
        ],
      }),
    );
    await c.t.mutation(api.plans.createFromTemplate, {
      api_token: TOKEN,
      template_id: template,
    });
    const [first, second] = (await c.read("tasks")).filter(
      (t: any) => t.source === "template",
    );
    expect(first.blocks).toEqual([second.short_id]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: first.short_id,
      by: "ct-5",
    });
    expect((await c.row(second.short_id)).blocked_by).toEqual(["ct-5"]);
  });

  test("reopening when the edge back would close a loop leaves that dependent on the replacement and says so", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    await c.t.run(({ db }) => db.patch(c.id("ct-1"), { blocked_by: ["ct-2"] }));
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "open",
    });
    expect([
      (await c.row("ct-1")).status,
      (await c.row("ct-2")).blocked_by,
    ]).toEqual(["open", ["ct-5"]]);
    expect((await c.comments("ct-2"))[0]).toMatch(
      /^Still waits on ct-5: ct-1 was reopened, but waiting on ct-1 again was refused\. .*loop/,
    );
  });

  test("a task already superseded by another is refused until reopened", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
      task("ct-6"),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-1",
        by: "ct-6",
      }),
    ).rejects.toThrow(/already superseded by ct-5/);
    expect((await c.row("ct-1")).superseded_by).toBe("ct-5");
  });

  test("refuses itself, a done task, a parent with open subtasks, and a replacement that was itself superseded", async () => {
    const c = await setup([
      task("ct-1"),
      task("ct-2", { status: "done" }),
      task("ct-3", { superseded_by: "ct-4" }),
      task("ct-4"),
      task("ct-6"),
      task("ct-7", { parent_id: "task_ct-6" }),
      task("ct-8", { status: "dropped" }),
    ]);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-1",
        by: "ct-8",
      }),
    ).rejects.toThrow(/ct-8 is dropped/);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-6",
        by: "ct-4",
      }),
    ).rejects.toThrow(/open subtasks \(ct-7\)/);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-1",
        by: "ct-1",
      }),
    ).rejects.toThrow(/itself/);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-2",
        by: "ct-4",
      }),
    ).rejects.toThrow(/done/);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-1",
        by: "ct-3",
      }),
    ).rejects.toThrow(/superseded by ct-4/);
  });

  test("a replacement that is the old task's own subtask is named as such", async () => {
    const c = await setup([
      task("ct-1"),
      task("ct-5", { parent_id: "task_ct-1" }),
    ]);
    await expect(
      c.t.mutation(api.taskLinks.supersede, {
        api_token: TOKEN,
        short_id: "ct-1",
        by: "ct-5",
      }),
    ).rejects.toThrow(
      /ct-5 is a subtask of ct-1, the task it would replace; move it to the top level first/,
    );
  });
});
