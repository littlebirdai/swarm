// tasks.update carries the ground node's fields (the-line-end-to-end.md LE5):
// `cast task update --goal-ref --category --risk --readiness --readiness-note`
// write through the one update path, and an empty string clears a field.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { DatabaseWriter } from "./_generated/server";

const TOKEN = "ground-token";

async function setup(
  fields: Partial<NewRow<"tasks">>,
  prepare?: (
    db: DatabaseWriter,
    owner: Id<"users">,
  ) => Promise<Partial<NewRow<"tasks">>>,
) {
  const t = serverTest();
  const task = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task ground");
    const owner = await rows.user();
    await rows.token(owner, TOKEN);
    return rows.task(owner, {
      short_id: "ct-1",
      ...fields,
      ...(await prepare?.(db, owner)),
    });
  });
  return {
    update: (args: Partial<FunctionArgs<typeof api.tasks.update>>) =>
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        ...args,
      }),
    readTask: () => t.run(async ({ db }) => (await db.get(task))!),
  };
}

describe("tasks.update ground fields", () => {
  test("writes all five", async () => {
    const { update, readTask } = await setup({
      status: "open",
      source: "agent",
    });
    await update({
      goal_ref: "in-3:week4_retention",
      category: "prompt",
      risk: "plan",
      readiness: "needs_context",
      readiness_note: "no repro yet",
    });
    expect(await readTask()).toMatchObject({
      goal_ref: "in-3:week4_retention",
      category: "prompt",
      risk: "plan",
      readiness: "needs_context",
      readiness_note: "no repro yet",
    });
  });

  test("--watch-days starts the watch now and records it; 0 ends it", async () => {
    const { update, readTask } = await setup({
      status: "done",
      source: "signal",
    });
    const before = Date.now();
    await update({ watch_days: 7 });
    const watched = await readTask();
    expect(watched.watch_from).toBeGreaterThanOrEqual(before);
    expect(watched.watch_until).toBe(watched.watch_from! + 7 * 86_400_000);
    await update({ watch_days: 0 });
    expect((await readTask()).watch_from).toBeUndefined();
    expect((await readTask()).watch_until).toBeUndefined();
  });

  test("an empty string clears a field; an absent one is left alone", async () => {
    const { update, readTask } = await setup({
      status: "open",
      source: "agent",
      goal_ref: "none",
      category: "code",
      risk: "low",
    });
    await update({ category: "", goal_ref: "pj-a" });
    expect((await readTask()).category).toBeUndefined();
    expect((await readTask()).goal_ref).toBe("pj-a");
    expect((await readTask()).risk).toBe("low");
  });

  test("a cause's goal must be one its own goals brief offers: its project, not another's", async () => {
    const { update, readTask } = await setup(
      { source: "signal" },
      async (db, owner) => {
        const team = await fixtureRows(db, "task goals workspace").team();
        const workspace = `team:${team}`;
        const common = {
          user_id: owner,
          workspace,
          team_id: team,
          status: "active",
          created_at: 1,
          updated_at: 1,
        } as const;
        const project = await db.insert("projects", {
          ...common,
          short_id: "pj-me",
          title: "Matching Engine",
          goal: "More intros",
        });
        await db.insert("projects", {
          ...common,
          short_id: "pj-aq",
          title: "Agent Quality",
          goal: "Zero clusters",
        });
        return { workspace, team_id: team, project_id: project };
      },
    );
    await expect(update({ goal_ref: "pj-aq" })).rejects.toThrow(
      /not one of ct-1's goals/,
    );
    expect((await readTask()).goal_ref).toBeUndefined();
    await update({ goal_ref: "pj-me" });
    expect((await readTask()).goal_ref).toBe("pj-me");
    await update({ goal_ref: "none" });
    expect((await readTask()).goal_ref).toBe("none");
  });
});
