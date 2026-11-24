import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { armedAndRecentlyFinished } from "./agentTasks";

const USER = "user_1" as any;
const row = (n: number, status: string, user = USER) => ({ _id: `t${n}`, _creationTime: n, user_id: user, status, retry_count: 0 });

test("returns every armed trigger and the newest finished ones up to the limit", async () => {
  const rows = [
    row(1, "completed"), row(2, "failed"), row(3, "scheduled"), row(4, "completed"),
    row(5, "cancelled"), row(6, "paused"), row(7, "completed"), row(8, "running"),
    row(9, "scheduled", "user_2"), row(10, "completed", "user_2"),
  ];
  const db = makeFakeDb({ agent_tasks: rows }, { indexes: schemaIndexes(schema) });
  const ids = (await armedAndRecentlyFinished({ db }, USER, 3)).map((t: any) => t._id);
  expect(ids.slice(0, 3).sort()).toEqual(["t3", "t6", "t8"]);
  expect(ids.slice(3)).toEqual(["t7", "t5", "t4"]);
});

test("a zero limit returns only the armed triggers", async () => {
  const db = makeFakeDb({ agent_tasks: [row(1, "completed"), row(2, "scheduled")] }, { indexes: schemaIndexes(schema) });
  expect((await armedAndRecentlyFinished({ db }, USER, 0)).map((t: any) => t._id)).toEqual(["t2"]);
});

async function seedHistory() {
  const t = convexTest(schema, allModules);
  const { user, armed, finished } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const other = await ctx.db.insert("users", {});
    const insert = (status: "scheduled" | "running" | "paused" | "completed" | "failed" | "cancelled", owner = user) =>
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
    const armed = [await insert("scheduled"), await insert("paused"), await insert("running")];
    const statuses = ["completed", "failed", "cancelled"] as const;
    const finished = [];
    for (let i = 0; i < 60; i++) finished.push(await insert(statuses[i % statuses.length]));
    await insert("completed", other);
    return { user, armed, finished };
  });
  return { viewer: t.withIdentity({ subject: `${user}|test` }), armed, finished };
}

test("webList defaults to all armed triggers and the newest 50 finished triggers", async () => {
  const { viewer, armed, finished } = await seedHistory();
  const rows = await viewer.query(anyApi.agentTasks.webList, {});
  expect(rows).toHaveLength(armed.length + 50);
  expect(rows.slice(0, armed.length).map((t: { _id: string }) => t._id).sort()).toEqual(armed.sort());
  expect(rows.slice(armed.length).map((t: { _id: string }) => t._id)).toEqual(finished.slice(-50).reverse());
});

test("webListHistory pages through owned triggers beyond the roster's default limit", async () => {
  const { viewer, armed, finished } = await seedHistory();
  const queryPage = (cursor: string | null) =>
    viewer.query(anyApi.agentTasks.webListHistory, { paginationOpts: { cursor, numItems: 50 } });
  const first = await queryPage(null);
  expect(first.page).toHaveLength(50);
  expect(first.isDone).toBeFalse();
  const second = await queryPage(first.continueCursor);
  expect(second.isDone).toBeTrue();
  expect([...first.page, ...second.page].map((t: { _id: string }) => t._id).sort()).toEqual([...armed, ...finished].sort());
});
