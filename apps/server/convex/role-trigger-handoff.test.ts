import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  countDatabaseReads,
  scheduledJobs,
  serverTest,
  type ServerTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import type { Doc } from "./_generated/dataModel";
import { handRoleTriggersToRunner } from "./lib/agentTaskRows";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function seedSeat(
  t: ServerTest,
  triggerCount: number,
  prompt = "Check in",
) {
  return t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "role-trigger-handoff");
    const oldRunner = await fixtures.user();
    const runner = await fixtures.user();
    const otherSeat = await fixtures.conversation(oldRunner);
    const seat = await fixtures.conversation(runner, {
      armed_trigger_kind: "once",
    });
    async function roleAt(conversation: typeof seat, handle: string) {
      const anchor = await db.insert("anchors", {
        conversation_id: conversation,
        scope_type: "user",
        scope_user_id: oldRunner,
        host_user_id: oldRunner,
        bot_user_id: oldRunner,
        name: handle,
        status: "active",
        created_at: 1,
      });
      return db.insert("org_roles", {
        anchor_id: anchor,
        short_id: handle,
        scope_type: "user",
        scope_user_id: oldRunner,
        host_user_id: oldRunner,
        name: handle,
        handle,
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "user", user_id: oldRunner },
        status: "active",
        created_by: oldRunner,
        created_at: 1,
        updated_at: 1,
      });
    }
    const role = await roleAt(seat, "seated-role");
    const otherRole = await roleAt(otherSeat, "other-role");
    const trigger = (data: Partial<Doc<"agent_tasks">> = {}) =>
      db.insert("agent_tasks", {
        user_id: oldRunner,
        originating_conversation_id: seat,
        title: "Follow up",
        prompt,
        mode: "apply",
        schedule_type: "once",
        status: "scheduled",
        created_at: 1,
        retry_count: 0,
        run_count: 0,
        ...data,
      });
    const personal = await trigger();
    const offSeat = await trigger({ role_id: otherRole });
    const alreadyOwned = await trigger({ user_id: runner, role_id: role });
    const moved = [];
    for (let i = 0; i < triggerCount; i++) {
      moved.push(
        await trigger({
          role_id: role,
          schedule_type: i === triggerCount - 1 ? "recurring" : "once",
        }),
      );
    }
    return { seat, runner, oldRunner, moved, personal, offSeat, alreadyOwned };
  });
}

test("handoff keeps owner writes in trigger order and repairs the kind after the first write", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved, personal, offSeat, alreadyOwned } =
    await seedSeat(t, 3);
  await t.run(async (ctx) => {
    const writes: unknown[] = [];
    const dbReads = countDatabaseReads(ctx.db);
    const db = {
      ...dbReads.db,
      patch: (async (id, patch) => {
        writes.push([id, patch]);
        await ctx.db.patch(id, patch);
      }) as typeof ctx.db.patch,
    };
    await handRoleTriggersToRunner({ ...ctx, db }, seat);
    expect(
      dbReads.reads.filter((table) => table === "agent_tasks"),
    ).toHaveLength(1);
    expect(writes).toEqual([
      [moved[0], { user_id: runner }],
      [seat, { armed_trigger_kind: "standing" }],
      [moved[1], { user_id: runner }],
      [moved[2], { user_id: runner }],
    ]);
    writes.length = 0;
    await handRoleTriggersToRunner({ ...ctx, db }, seat);
    expect(writes).toEqual([]);
    expect((await ctx.db.get(personal))?.user_id).toBe(oldRunner);
    expect((await ctx.db.get(offSeat))?.user_id).toBe(oldRunner);
    expect((await ctx.db.get(alreadyOwned))?.user_id).toBe(runner);
  });
});

test("500 role triggers hand off under the default transaction limits", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved, personal, offSeat, alreadyOwned } =
    await seedSeat(t, 500);
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  expect(await scheduledJobs(t)).toHaveLength(1);
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  await t.run(async ({ db }) => {
    const tasks = await db
      .query("agent_tasks")
      .withIndex("by_originating_conversation", (q) =>
        q.eq("originating_conversation_id", seat),
      )
      .collect();
    expect(
      tasks.filter((task) => task.user_id === runner).map((t) => t._id),
    ).toEqual([alreadyOwned, ...moved]);
    expect(
      tasks.filter((task) => task.user_id === oldRunner).map((t) => t._id),
    ).toEqual([personal, offSeat]);
    expect((await db.get(seat))?.armed_trigger_kind).toBe("standing");
  });
});

test("a standing trigger beyond the byte budget repairs the kind on its own page", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved } = await seedSeat(
    t,
    120,
    "Check in ".repeat(5_000),
  );
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  await t.run(async ({ db }) => {
    expect((await db.get(moved[0]))?.user_id).toBe(runner);
    expect((await db.get(moved.at(-1)!))?.user_id).toBe(oldRunner);
    expect((await db.get(seat))?.armed_trigger_kind).toBe("once");
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  await t.run(async ({ db }) => {
    expect((await db.get(moved.at(-1)!))?.user_id).toBe(runner);
    expect((await db.get(seat))?.armed_trigger_kind).toBe("standing");
  });
});
