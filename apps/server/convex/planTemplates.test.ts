// `cast plan template save|ls|rm` (docs/architecture/task-graph.md TG6): a
// plan's live steps and edges become a template whose blockers all point
// back, saving a name again replaces it, and only its author removes it.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const TOKEN = "plan-templates-test-token";
const OTHER_TOKEN = "plan-templates-other-token";

async function setup(
  tasks: (Partial<NewRow<"tasks">> & Pick<NewRow<"tasks">, "short_id">)[],
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "plan templates");
    const user = await rows.user();
    const other = await rows.user();
    await rows.token(user, TOKEN);
    await rows.token(other, OTHER_TOKEN);
    const tasksByShortId = Object.fromEntries(
      await Promise.all(
        tasks.map(
          async (fields) =>
            [
              fields.short_id,
              await rows.task(user, {
                title: `Title ${fields.short_id}`,
                ...fields,
              }),
            ] as const,
        ),
      ),
    );
    await rows.plan(user, {
      short_id: "pl-1",
      title: "Ship the thing",
      goal: "Shipped",
      task_ids: Object.values(tasksByShortId),
    });
    return { user, tasksByShortId };
  });

  return {
    t,
    ...ids,
    save: (
      fields: Partial<FunctionArgs<typeof api.planTemplates.save>> = {},
      token = TOKEN,
    ) =>
      t.mutation(api.planTemplates.save, {
        api_token: token,
        plan: "pl-1",
        ...fields,
      }),
    remove: (
      fields: Omit<FunctionArgs<typeof api.planTemplates.remove>, "api_token">,
      token = TOKEN,
    ) => t.mutation(api.planTemplates.remove, { api_token: token, ...fields }),
    list: (token = TOKEN) =>
      t.query(api.planTemplates.list, { api_token: token }),
    templates: () => t.run(({ db }) => db.query("plan_templates").collect()),
  };
}

describe("plan templates (TG6)", () => {
  test("save orders steps so every blocker points back, and leaves dropped steps out", async () => {
    const { t, tasksByShortId, save, templates } = await setup([
      {
        short_id: "ct-3",
        blocked_by: ["ct-1", "ct-2"],
        description: "Review it",
      },
      { short_id: "ct-1" },
      { short_id: "ct-2" },
      { short_id: "ct-4", status: "dropped", blocked_by: ["ct-3"] },
    ]);
    await t.run(({ db }) =>
      db.patch(tasksByShortId["ct-2"], {
        blocked_by: [tasksByShortId["ct-1"], "ct-40"],
      }),
    );
    const result = await save();
    expect(result).toMatchObject({
      name: "Ship the thing",
      steps: 3,
      edges: 3,
      replaced: false,
    });
    const [tpl] = await templates();
    expect(tpl.goal_template).toBe("Shipped");
    expect(
      tpl.task_templates.map((t) => [t.title, t.blocked_by_indices ?? []]),
    ).toEqual([
      ["Title ct-1", []],
      ["Title ct-2", [0]],
      ["Title ct-3", [0, 1]],
    ]);
    expect(tpl.task_templates[2].description).toBe("Review it");
    expect(tpl.team_id).toBeUndefined();
  });

  test("saving the same name replaces it; list and remove see it, only for its author", async () => {
    const { save, list, remove, templates } = await setup([
      { short_id: "ct-1" },
    ]);
    await save({ plan: "pl-1", name: "Release" });
    const again = await save({
      plan: "pl-1",
      name: "Release",
      description: "Weekly",
    });
    expect(again.replaced).toBe(true);
    expect(await templates()).toHaveLength(1);
    expect((await list()).map((t) => [t.name, t.description])).toEqual([
      ["Release", "Weekly"],
    ]);
    expect(await list(OTHER_TOKEN)).toEqual([]);
    await expect(remove({ name: "release" }, OTHER_TOKEN)).rejects.toThrow(
      /No template of yours/,
    );
    expect(await remove({ name: "release" })).toEqual({
      removed: 1,
    });
    expect(await templates()).toHaveLength(0);
  });

  test("a plan the caller cannot read, or one with no live steps, saves nothing", async () => {
    const { save, templates } = await setup([
      { short_id: "ct-1", status: "dropped" },
    ]);
    await expect(save({ plan: "pl-1" }, OTHER_TOKEN)).rejects.toThrow(
      /Plan not found/,
    );
    await expect(save({ plan: "pl-1" })).rejects.toThrow(/no steps to save/);
    expect(await templates()).toHaveLength(0);
  });

  test("a dropped step passes its blockers through, so its dependents keep their order", async () => {
    const { save, templates } = await setup([
      { short_id: "ct-1" },
      { short_id: "ct-2", status: "dropped", blocked_by: ["ct-1"] },
      { short_id: "ct-3", blocked_by: ["ct-2"] },
    ]);
    await save({ plan: "pl-1" });
    expect(
      (await templates())[0].task_templates.map((t) => [
        t.title,
        t.blocked_by_indices ?? [],
      ]),
    ).toEqual([
      ["Title ct-1", []],
      ["Title ct-3", [0]],
    ]);
  });

  test("names match in any case; a name in two workspaces is removed from the one --team names", async () => {
    const { t, user, save, remove, templates } = await setup([
      { short_id: "ct-1" },
    ]);
    await save({ plan: "pl-1", name: "Release" });
    expect((await save({ plan: "pl-1", name: "RELEASE" })).replaced).toBe(true);
    expect(await templates()).toHaveLength(1);
    const team = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "same template in team");
      const team = await rows.team();
      await rows.membership(user, team);
      const plan = await rows.plan(user, {
        short_id: "pl-2",
        title: "Release",
        team_id: team,
        workspace: `team:${team}`,
      });
      const task = await rows.task(user, {
        team_id: team,
        workspace: `team:${team}`,
        plan_id: plan,
      });
      await db.patch(plan, { task_ids: [task] });
      return team;
    });
    await save({ plan: "pl-2" });
    await expect(remove({ name: "release" })).rejects.toThrow(
      /in 2 workspaces; pass --team/,
    );
    expect(
      await remove({
        name: "release",
        workspace: "team",
        team_id: team,
      }),
    ).toEqual({ removed: 1 });
    expect((await templates()).map((t) => t.team_id)).toEqual([undefined]);
    expect(await remove({ name: "release" })).toEqual({
      removed: 1,
    });
  });
});
