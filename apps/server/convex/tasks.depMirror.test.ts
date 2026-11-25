// blocked_by/blocks are a stored mirror: every accepted edge write must land
// on both sides. addDep/removeDep always did; these tests pin the paths that
// used to bypass the mirror — create (raw blocked_by, referenced tasks
// untouched) and update (raw overwrite of either array).
import { describe, expect, test } from "bun:test";
import { serverTest, type ServerTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const TOKEN = "dep-mirror-test-token";

async function setup(
  tasks: (Partial<NewRow<"tasks">> & Pick<NewRow<"tasks">, "short_id">)[],
) {
  const t = serverTest();
  await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "dependency mirror");
    const user = await rows.user();
    await rows.token(user, TOKEN);
    for (const fields of tasks) await rows.task(user, fields);
  });
  return t;
}

const byShortId = (t: ServerTest, shortId: string) =>
  t.run(
    async ({ db }) =>
      (await db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", shortId))
        .unique())!,
  );

describe("create dependency mirror", () => {
  test("blocked_by populates each referenced task's blocks", async () => {
    const t = await setup([{ short_id: "ct-12" }, { short_id: "ct-13" }]);
    const { short_id } = await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "New task",
      blocked_by: ["ct-12", "ct-13"],
    });
    expect((await byShortId(t, short_id)).blocked_by).toEqual([
      "ct-12",
      "ct-13",
    ]);
    expect((await byShortId(t, "ct-12")).blocks).toEqual([short_id]);
    expect((await byShortId(t, "ct-13")).blocks).toEqual([short_id]);
  });

  test("an unresolvable reference is skipped, not a failure", async () => {
    const t = await setup([{ short_id: "ct-12" }]);
    const { short_id } = await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "New task",
      blocked_by: ["ct-99", "ct-12"],
    });
    expect((await byShortId(t, "ct-12")).blocks).toEqual([short_id]);
  });
});

describe("update dependency mirror", () => {
  test("adding and removing a blocked_by entry patches both referenced tasks", async () => {
    const t = await setup([
      { short_id: "ct-11", blocked_by: ["ct-12"] },
      { short_id: "ct-12", blocks: ["ct-11"] },
      { short_id: "ct-13" },
    ]);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-11",
      blocked_by: ["ct-13"],
    });
    expect((await byShortId(t, "ct-11")).blocked_by).toEqual(["ct-13"]);
    expect((await byShortId(t, "ct-12")).blocks).toEqual([]);
    expect((await byShortId(t, "ct-13")).blocks).toEqual(["ct-11"]);
  });

  test("overwriting blocks patches referenced tasks' blocked_by symmetrically", async () => {
    const t = await setup([
      { short_id: "ct-11", blocked_by: ["ct-12"] },
      { short_id: "ct-12", blocks: ["ct-11"] },
      { short_id: "ct-14" },
    ]);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-12",
      blocks: ["ct-14"],
    });
    expect((await byShortId(t, "ct-12")).blocks).toEqual(["ct-14"]);
    expect((await byShortId(t, "ct-11")).blocked_by).toEqual([]);
    expect((await byShortId(t, "ct-14")).blocked_by).toEqual(["ct-12"]);
  });

  test("an unchanged entry is left alone", async () => {
    const t = await setup([
      { short_id: "ct-11", blocked_by: ["ct-12"] },
      { short_id: "ct-12", blocks: ["ct-11"] },
      { short_id: "ct-13" },
    ]);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-11",
      blocked_by: ["ct-12", "ct-13"],
    });
    expect((await byShortId(t, "ct-12")).blocks).toEqual(["ct-11"]);
    expect((await byShortId(t, "ct-13")).blocks).toEqual(["ct-11"]);
  });

  // An older plan row names its blocker by `_id`; a write naming it by short
  // id is the same edge, so the blocker's mirror stays.
  test("swapping a blocker's _id for its short id keeps the mirror", async () => {
    const t = await setup([
      { short_id: "ct-11" },
      { short_id: "ct-12", blocks: ["ct-11"] },
    ]);
    const source = await byShortId(t, "ct-11");
    const blocker = await byShortId(t, "ct-12");
    await t.run(({ db }) =>
      db.patch(source._id, { blocked_by: [blocker._id] }),
    );
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-11",
      blocked_by: ["ct-12"],
    });
    expect((await byShortId(t, "ct-11")).blocked_by).toEqual(["ct-12"]);
    expect((await byShortId(t, "ct-12")).blocks).toEqual(["ct-11"]);
  });

  // Readiness never reads across workspaces, so the edge could never clear.
  test("a reference into another workspace is refused and nothing is written", async () => {
    const t = await setup([{ short_id: "ct-11" }]);
    await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "foreign blocker");
      await rows.task(await rows.user(), { short_id: "ct-24", blocks: [] });
    });
    await expect(
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-11",
        blocked_by: ["ct-24"],
      }),
    ).rejects.toThrow("dependency task belongs to another workspace");
    expect((await byShortId(t, "ct-11")).blocked_by).toBeUndefined();
    expect((await byShortId(t, "ct-24")).blocks).toEqual([]);
  });
});
