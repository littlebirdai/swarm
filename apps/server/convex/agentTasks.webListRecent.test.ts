import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
async function seedHistory() {
  const t = convexTest(schema, allModules);
  const { user, armed, finished } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const other = await ctx.db.insert("users", {});
    const insert = (
      status:
        | "scheduled"
        | "running"
        | "paused"
        | "completed"
        | "failed"
        | "cancelled",
      owner = user,
    ) =>
      ctx.db.insert("agent_tasks", {
        user_id: owner,
        title: "Check status",
        prompt: "Check status",
        schedule_type: "once",
        mode: "apply",
        run_at: 0,
        status,
        retry_count: 0,
        max_retries: 3,
        run_count: 0,
        created_at: 0,
      });
    const armed = [
      await insert("scheduled"),
      await insert("paused"),
      await insert("running"),
    ];
    const statuses = ["completed", "failed", "cancelled"] as const;
    const finished = [];
    for (let i = 0; i < 60; i++)
      finished.push(await insert(statuses[i % statuses.length]));
    await insert("completed", other);
    return { user, armed, finished };
  });
  return {
    viewer: t.withIdentity({ subject: `${user}|test` }),
    armed,
    finished,
  };
}

test.each([undefined, 3, 0])(
  "webList returns all armed triggers and the newest finished triggers with limit %s",
  async (limit) => {
    const { viewer, armed, finished } = await seedHistory();
    const rows = await viewer.query(
      anyApi.agentTasks.webList,
      limit === undefined ? {} : { recent_finished: limit },
    );
    const count = limit ?? 50;
    expect(rows).toHaveLength(armed.length + count);
    expect(
      rows
        .slice(0, armed.length)
        .map((t: { _id: string }) => t._id)
        .sort(),
    ).toEqual(armed.sort());
    expect(rows.slice(armed.length).map((t: { _id: string }) => t._id)).toEqual(
      count === 0 ? [] : finished.slice(-count).reverse(),
    );
  },
);

test("webListHistory pages through owned triggers beyond the roster's default limit", async () => {
  const { viewer, armed, finished } = await seedHistory();
  const queryPage = (cursor: string | null) =>
    viewer.query(anyApi.agentTasks.webListHistory, {
      paginationOpts: { cursor, numItems: 50 },
    });
  const first = await queryPage(null);
  expect(first.page).toHaveLength(50);
  expect(first.isDone).toBeFalse();
  const second = await queryPage(first.continueCursor);
  expect(second.isDone).toBeTrue();
  expect(
    [...first.page, ...second.page].map((t: { _id: string }) => t._id).sort(),
  ).toEqual([...armed, ...finished].sort());
});
