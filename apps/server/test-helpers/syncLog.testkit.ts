import { serverTest } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";
import type { MutationCtx, DatabaseWriter } from "../convex/_generated/server";

export async function withSyncStore(
  run: (store: Awaited<ReturnType<typeof syncStore>>) => Promise<void>,
) {
  const t = serverTest();
  await t.run(async (ctx) => run(await syncStore(ctx)));
}

async function syncStore(ctx: MutationCtx) {
  const { db } = ctx;
  const rows = fixtureRows(db, "sync principals");
  const users = {
    one: await rows.user(),
    two: await rows.user(),
    three: await rows.user(),
    five: await rows.user(),
    seven: await rows.user(),
    eight: await rows.user(),
    nine: await rows.user(),
  };
  const teams = {
    a: await rows.team(),
    b: await rows.team(),
    c: await rows.team(),
    shared: await rows.team(),
    routed: await rows.team(),
    member: await rows.team(),
  };
  const project = await db.insert("projects", {
    user_id: users.one,
    title: "Release",
    status: "active",
    created_at: 1,
    updated_at: 1,
  });
  let source = 0;
  return {
    ctx,
    db,
    users,
    teams,
    project,
    rowsFor: (writer: DatabaseWriter) =>
      fixtureRows(writer, `sync writer ${source++}`),
    actions: async (scope?: string) =>
      scope
        ? db
            .query("sync_actions")
            .withIndex("by_scope_position", (q) => q.eq("scope_key", scope))
            .collect()
        : (await db.query("sync_actions").collect()).sort(
            (a, b) => a.position - b.position,
          ),
    head: (scope: string) =>
      db
        .query("sync_heads")
        .withIndex("by_scope", (q) => q.eq("scope_key", scope))
        .unique(),
  };
}
