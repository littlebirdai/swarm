import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { allModules } from "../testModules.testkit";
import { heartbeatOf, heartbeatsForUser, managedSessionsBeatingSince } from "./sessionHeartbeat";

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

test("point, whole-user and recent reads use the newer timestamp during expand", async () => {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const seed = async (session_id: string, last_heartbeat: number, heartbeat_at: number) => {
      const id = await ctx.db.insert("managed_sessions", { session_id, user_id: user, pid: 1, started_at: 1, last_heartbeat });
      await ctx.db.insert("session_heartbeats", { managed_session_id: id, user_id: user, heartbeat_at });
      return (await ctx.db.get(id))!;
    };
    const legacyNewer = await seed("legacy-newer", 300, 100);
    const sideNewer = await seed("side-newer", 100, 200);
    await seed("stale", 100, 100);

    expect(await heartbeatOf(ctx, legacyNewer)).toBe(300);
    expect(await heartbeatsForUser(ctx, user, [legacyNewer, sideNewer])).toEqual([300, 200]);
    for (const owner of [user, undefined]) {
      expect((await managedSessionsBeatingSince(ctx, 150, owner)).map((session) => session._id)).toEqual([sideNewer._id, legacyNewer._id]);
    }
  });
});

test("the managed-session reaper removes the side row and protects a fresher side heartbeat", async () => {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const stale = now - 2 * 60 * 60 * 1000;
  const { dead, deadBeat, live, liveBeat } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const seed = async (session_id: string, heartbeat_at: number) => {
      const id = await ctx.db.insert("managed_sessions", {
        session_id, user_id: user, pid: 1, started_at: stale, last_heartbeat: stale,
      });
      return {
        id,
        beat: await ctx.db.insert("session_heartbeats", { managed_session_id: id, user_id: user, heartbeat_at }),
      };
    };
    const dead = await seed("dead", stale);
    const live = await seed("live", now);
    return { dead: dead.id, deadBeat: dead.beat, live: live.id, liveBeat: live.beat };
  });

  expect(await t.mutation(internal.managedSessions.reapStaleManagedSessions, {})).toEqual({ deleted: 1, more: false });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(dead)).toBeNull();
    expect(await ctx.db.get(deadBeat)).toBeNull();
    expect(await ctx.db.get(live)).not.toBeNull();
    expect(await ctx.db.get(liveBeat)).not.toBeNull();
  });
});

test("empty conversation cleanup removes the managed session and its heartbeat", async () => {
  const t = convexTest(schema, allModules);
  const { conversation, session, beat, createdAt } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const now = Date.now();
    const conversation = await ctx.db.insert("conversations", {
      user_id: user, session_id: "empty", status: "active", message_count: 0, started_at: now, updated_at: now,
    });
    const session = await ctx.db.insert("managed_sessions", {
      session_id: "empty", conversation_id: conversation, user_id: user, pid: 1, started_at: now, last_heartbeat: now,
    });
    const beat = await ctx.db.insert("session_heartbeats", { managed_session_id: session, user_id: user, heartbeat_at: now });
    return { conversation, session, beat, createdAt: (await ctx.db.get(conversation))!._creationTime };
  });

  const clock = spyOn(Date, "now").mockReturnValue(createdAt + 26 * 60 * 60 * 1000);
  try {
    expect(await t.mutation(internal.cleanup.gcEmptyConversations, { since: createdAt - 1, until: createdAt + 1 }))
      .toMatchObject({ scanned: 1, deleted: 1, killed: 0 });
  } finally {
    clock.mockRestore();
  }
  await t.run(async (ctx) => {
    expect(await ctx.db.get(conversation)).toBeNull();
    expect(await ctx.db.get(session)).toBeNull();
    expect(await ctx.db.get(beat)).toBeNull();
  });
});
