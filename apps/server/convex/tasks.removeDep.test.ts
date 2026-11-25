// Removing a dependency edge (`cast task dep --remove`, the web's Blocked by
// row; both reach removeDepCore) clears both sides of the mirror, and removing
// a task's last open blocker unblocks it the way a closing blocker does
// (docs/architecture/task-graph.md TG2): the task says so, once.
import { describe, expect, test } from "bun:test";
import { serverTest, type ServerTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { addDepCore, removeDepCore, type DepEdge } from "./tasks";

const TOKEN = "dep-test-token";

async function setup(
  tasks: (Partial<NewRow<"tasks">> & Pick<NewRow<"tasks">, "short_id">)[],
  options: { legacy?: boolean; owned?: boolean; foreign?: boolean } = {},
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "remove dependency");
    const owner = await rows.user();
    await rows.token(owner, TOKEN);
    const user = options.foreign ? await rows.user() : owner;
    const taskIds: Record<string, Id<"tasks">> = {};
    for (const fields of tasks)
      taskIds[fields.short_id] = await rows.task(user, fields);
    const session = await rows.conversation(owner, {
      short_id: "jx7own",
      session_id: "sess_owner",
      active_task_id: taskIds["ct-2"],
    });
    if (options.legacy)
      await db.patch(taskIds["ct-2"], { blocked_by: [taskIds["ct-1"]] });
    if (options.owned)
      await db.patch(taskIds["ct-2"], { conversation_ids: [session] });
    return { owner, taskIds, session };
  });
  return {
    t,
    ...ids,
    row: (shortId: string) =>
      t.run(async ({ db }) => (await db.get(ids.taskIds[shortId]))!),
    unblockedNotes: async () =>
      (await t.run(({ db }) => db.query("task_comments").collect())).filter(
        (c) => c.text.startsWith("Unblocked:"),
      ),
    addInApp: (args: DepEdge) =>
      t.run((ctx) => addDepCore(ctx, ids.owner, args)),
    removeInApp: (args: DepEdge) =>
      t.run((ctx) => removeDepCore(ctx, ids.owner, args)),
  };
}

const remove = (t: ServerTest, args: DepEdge & { conversation_id?: string }) =>
  t.mutation(api.tasks.removeDep, { api_token: TOKEN, ...args });

describe("removeDep", () => {
  test("--remove-blocked-by clears the edge on both sides and unblocks the task", async () => {
    const { t, row, unblockedNotes } = await setup([
      { short_id: "ct-1", blocks: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
    ]);
    await remove(t, { short_id: "ct-2", blocked_by: "ct-1" });
    expect((await row("ct-2")).blocked_by).toEqual([]);
    expect((await row("ct-1")).blocks).toEqual([]);
    expect((await unblockedNotes()).map((c) => c.text)).toEqual([
      "Unblocked: the blocker ct-1 was removed",
    ]);
  });

  test("--remove-blocks clears the edge on both sides, and the dependent is the one unblocked", async () => {
    const { t, row, unblockedNotes, taskIds } = await setup([
      { short_id: "ct-1", blocks: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
    ]);
    await remove(t, { short_id: "ct-1", blocks: "ct-2" });
    expect((await row("ct-1")).blocks).toEqual([]);
    expect((await row("ct-2")).blocked_by).toEqual([]);
    expect((await unblockedNotes()).map((c) => String(c.task_id))).toEqual([
      taskIds["ct-2"],
    ]);
  });

  test("errors clearly when the edge does not exist", async () => {
    const { t } = await setup([
      { short_id: "ct-1", blocks: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
    ]);
    await expect(
      remove(t, { short_id: "ct-2", blocked_by: "ct-nope" }),
    ).rejects.toThrow("ct-2 has no blocked-by dependency on ct-nope");
    await expect(
      remove(t, { short_id: "ct-2", blocks: "ct-1" }),
    ).rejects.toThrow("ct-2 has no blocks dependency on ct-1");
  });

  // The usual cause is the edge named the other way round.
  test("a remove naming the edge backwards says which way it points", async () => {
    const { t } = await setup([
      { short_id: "ct-1", blocks: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
    ]);
    await expect(
      remove(t, { short_id: "ct-1", blocked_by: "ct-2" }),
    ).rejects.toThrow(
      "ct-1 has no blocked-by dependency on ct-2; ct-2 waits on ct-1 instead (cast task dep ct-2 --remove-blocked-by ct-1)",
    );
    await expect(
      remove(t, { short_id: "ct-2", blocks: "ct-1" }),
    ).rejects.toThrow(
      "ct-2 has no blocks dependency on ct-1; ct-2 waits on ct-1 instead (cast task dep ct-2 --remove-blocked-by ct-1)",
    );
  });

  test("removes a dangling edge whose other task no longer exists", async () => {
    const { t, row } = await setup([
      { short_id: "ct-2", blocked_by: ["ct-404"] },
    ]);
    await remove(t, { short_id: "ct-2", blocked_by: "ct-404" });
    expect((await row("ct-2")).blocked_by).toEqual([]);
  });

  test("an older plan row's blocker, stored by _id, is removed by either name", async () => {
    for (const useId of [false, true]) {
      const { t, row, unblockedNotes, taskIds } = await setup(
        [{ short_id: "ct-1", blocks: ["ct-2"] }, { short_id: "ct-2" }],
        { legacy: true },
      );
      await remove(t, {
        short_id: "ct-2",
        blocked_by: useId ? taskIds["ct-1"] : "ct-1",
      });
      expect((await row("ct-2")).blocked_by).toEqual([]);
      expect((await row("ct-1")).blocks).toEqual([]);
      expect((await unblockedNotes()).map((c) => c.text)).toEqual([
        "Unblocked: the blocker ct-1 was removed",
      ]);
    }
  });

  test("removed from the blocker's side, a dependent naming it by its _id is unblocked", async () => {
    const { row, unblockedNotes, taskIds, removeInApp } = await setup(
      [{ short_id: "ct-1", blocks: ["ct-2"] }, { short_id: "ct-2" }],
      { legacy: true },
    );
    await removeInApp({ short_id: "ct-1", blocks: "ct-2" });
    expect((await row("ct-1")).blocks).toEqual([]);
    expect((await row("ct-2")).blocked_by).toEqual([]);
    expect((await unblockedNotes()).map((c) => String(c.task_id))).toEqual([
      taskIds["ct-2"],
    ]);
  });

  test("a short id and its _id are one edge: adding never doubles it, and removing takes every form", async () => {
    const { t, row, unblockedNotes, taskIds, addInApp } = await setup(
      [{ short_id: "ct-1", blocks: ["ct-2"] }, { short_id: "ct-2" }],
      { legacy: true },
    );
    await addInApp({
      short_id: "ct-2",
      blocked_by: "ct-1",
    });
    await addInApp({ short_id: "ct-1", blocks: "ct-2" });
    expect([
      (await row("ct-2")).blocked_by,
      (await row("ct-1")).blocks,
    ]).toEqual([[taskIds["ct-1"]], ["ct-2"]]);

    // A row that already holds both forms loses both.
    await t.run(({ db }) =>
      db.patch(taskIds["ct-2"], { blocked_by: [taskIds["ct-1"], "ct-1"] }),
    );
    await remove(t, { short_id: "ct-2", blocked_by: "ct-1" });
    expect([
      (await row("ct-2")).blocked_by,
      (await row("ct-1")).blocks,
    ]).toEqual([[], []]);
    expect((await unblockedNotes()).map((c) => c.text)).toEqual([
      "Unblocked: the blocker ct-1 was removed",
    ]);
  });

  test("only touches the named edge; another open blocker keeps it blocked", async () => {
    const { t, row, unblockedNotes } = await setup([
      { short_id: "ct-1", blocks: ["ct-2"] },
      { short_id: "ct-3", blocks: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1", "ct-3"] },
    ]);
    await remove(t, { short_id: "ct-2", blocked_by: "ct-1" });
    expect((await row("ct-2")).blocked_by).toEqual(["ct-3"]);
    expect((await row("ct-3")).blocks).toEqual(["ct-2"]);
    expect(await unblockedNotes()).toEqual([]);
  });

  test("a done blocker's removal releases nothing", async () => {
    const { unblockedNotes, removeInApp } = await setup([
      { short_id: "ct-4", status: "done" },
      { short_id: "ct-5", blocked_by: ["ct-4"] },
    ]);
    await removeInApp({
      short_id: "ct-5",
      blocked_by: "ct-4",
    });
    expect(await unblockedNotes()).toEqual([]);
  });

  test("the owning session removing its own blocker is not woken, and the history names it", async () => {
    const graph = () => [
      { short_id: "ct-1", blocks: ["ct-2"] },
      { short_id: "ct-2", blocked_by: ["ct-1"] },
    ];
    const own = await setup(graph(), { owned: true });
    await remove(own.t, {
      short_id: "ct-2",
      blocked_by: "ct-1",
      conversation_id: "sess_owner",
    });
    expect(await own.unblockedNotes()).toHaveLength(1);
    expect(
      await own.t.run(({ db }) => db.query("pending_messages").collect()),
    ).toEqual([]);
    expect(
      (await own.t.run(({ db }) => db.query("task_history").collect())).map(
        (h) => h.actor_type,
      ),
    ).toEqual(["agent"]);

    const person = await setup(graph(), { owned: true });
    await remove(person.t, { short_id: "ct-2", blocked_by: "ct-1" });
    expect(
      (
        await person.t.run(({ db }) => db.query("pending_messages").collect())
      ).map((m) => m.conversation_id),
    ).toEqual([person.session]);
  });

  test("round-trips with addDep", async () => {
    const { t, row } = await setup([
      { short_id: "ct-1" },
      { short_id: "ct-2" },
    ]);
    await t.mutation(api.tasks.addDep, {
      api_token: TOKEN,
      short_id: "ct-2",
      blocked_by: "ct-1",
    });
    expect([
      (await row("ct-2")).blocked_by,
      (await row("ct-1")).blocks,
    ]).toEqual([["ct-1"], ["ct-2"]]);
    await remove(t, { short_id: "ct-2", blocked_by: "ct-1" });
    expect([
      (await row("ct-2")).blocked_by,
      (await row("ct-1")).blocks,
    ]).toEqual([[], []]);
  });

  test("the web's add goes through the same loop check as the CLI", async () => {
    const { addInApp } = await setup([
      { short_id: "ct-1", blocked_by: ["ct-2"] },
      { short_id: "ct-2", blocks: ["ct-1"] },
    ]);
    await expect(
      addInApp({ short_id: "ct-2", blocked_by: "ct-1" }),
    ).rejects.toThrow(/loop/);
  });

  test("a ref that names no task is named in the error", async () => {
    const { t, row, taskIds, addInApp, removeInApp } = await setup([
      { short_id: "ct-1" },
      { short_id: "ct-2" },
    ]);
    await expect(
      addInApp({ short_id: "ct-2", blocked_by: "ct-999" }),
    ).rejects.toThrow("Task ct-999 not found");
    await expect(
      removeInApp({
        short_id: "ct-404",
        blocked_by: "ct-1",
      }),
    ).rejects.toThrow("Task ct-404 not found");
    await addInApp({ short_id: "ct-2", blocks: "ct-1" });
    expect([
      (await row("ct-2")).blocks,
      (await row("ct-1")).blocked_by,
    ]).toEqual([["ct-1"], ["ct-2"]]);
    expect(
      (await t.run(({ db }) => db.query("task_history").collect())).map((h) => [
        String(h.task_id),
        h.field,
        h.new_value,
      ]),
    ).toEqual([[taskIds["ct-1"], "blocked_by", "ct-2"]]);
  });

  test("rejects a task the caller cannot access", async () => {
    const { t } = await setup([{ short_id: "ct-x", blocked_by: ["ct-1"] }], {
      foreign: true,
    });
    await expect(
      remove(t, { short_id: "ct-x", blocked_by: "ct-1" }),
    ).rejects.toThrow("Task ct-x not found");
  });
});
