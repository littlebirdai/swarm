import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import schema from "../schema";
import { allModules } from "../testModules.testkit";
import { heartbeatOf, heartbeatsForUser } from "./sessionHeartbeat";

test("both daemon heartbeats maintain one side row per managed session with a legacy fallback", async () => {
  const t = convexTest(schema, allModules);
  const { user, first, second } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const seed = (session_id: string) => ctx.db.insert("managed_sessions", {
      session_id, user_id: user, pid: 1, started_at: 1, last_heartbeat: 123,
    });
    return { user, first: await seed("first"), second: await seed("second") };
  });
  const asUser = t.withIdentity({ subject: user });
  await t.run(async (ctx) => {
    expect(await heartbeatOf(ctx, (await ctx.db.get(first))!)).toBe(123);
  });

  expect(await asUser.mutation(api.managedSessions.heartbeat, { session_id: "first" })).toEqual({
    found: true, dismissed: false,
  });
  expect(await asUser.mutation(api.managedSessions.heartbeatBatch, {
    sessions: [{ session_id: "first" }, { session_id: "second" }],
  })).toEqual({ updated: 1, unknown: [] });

  await t.run(async (ctx) => {
    const sessions = [(await ctx.db.get(first))!, (await ctx.db.get(second))!];
    const rows = await ctx.db.query("session_heartbeats").collect();
    expect(rows).toHaveLength(2);
    for (const session of sessions) {
      expect(session.last_heartbeat).toBeGreaterThan(123);
      expect(rows.find((row) => row.managed_session_id === session._id)?.heartbeat_at).toBe(session.last_heartbeat);
    }

    // Deliberately diverge the mirror so the tests catch readers bypassing the side table.
    const legacy = { ...sessions[0], last_heartbeat: 123 };
    expect(await heartbeatOf(ctx, legacy)).toBe(sessions[0].last_heartbeat);
    expect(await heartbeatsForUser(ctx, user, [legacy])).toEqual([sessions[0].last_heartbeat]);
  });

  await asUser.mutation(api.managedSessions.unregisterManagedSession, { session_id: "first" });
  expect((await t.run((ctx) => ctx.db.query("session_heartbeats").collect())).map((row) => row.managed_session_id)).toEqual([second]);
});
