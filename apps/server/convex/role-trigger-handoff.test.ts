import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  asUser,
  countDatabaseReads,
  scheduledJobs,
  serverTest,
  type ServerTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  cancelTasksOriginatingFrom,
  handRoleTriggersToRunner,
  patchTask,
} from "./lib/agentTaskRows";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const continuation = internal.lib.agentTaskRows.continueRoleTriggerHandoff;

async function oldRunnerClaims(
  t: ServerTest,
  role: Id<"org_roles">,
  oldRunner: Id<"users">,
  due: Id<"agent_tasks">[],
) {
  const token = "old-trigger-runner";
  await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "role-trigger-handoff-claims");
    const team = await fixtures.team({ features: { org: true } });
    await fixtures.membership(oldRunner, team);
    await fixtures.token(oldRunner, token);
    await db.patch(role, { team_id: team });
    for (const id of due) await db.patch(id, { run_at: 1 });
  });
  return (task_id: Id<"agent_tasks">) =>
    t.mutation(api.agentTasks.claimTask, {
      api_token: token,
      daemon_id: "old-daemon",
      task_id,
    });
}

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
    return {
      seat,
      runner,
      oldRunner,
      moved,
      personal,
      offSeat,
      alreadyOwned,
      role,
      otherSeat,
    };
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
  await t.run(({ db }) => db.patch(seat, { armed_trigger_kind: "none" }));
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

test("a bounded scan repairs a seat armed only with once triggers", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved } = await seedSeat(
    t,
    120,
    "Check in ".repeat(5_000),
  );
  await t.run(async ({ db }) => {
    await db.patch(seat, { armed_trigger_kind: "none" });
    await db.patch(moved.at(-1)!, { schedule_type: "once" });
  });
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  await t.run(async ({ db }) => {
    expect((await db.get(moved.at(-1)!))?.user_id).toBe(oldRunner);
    expect((await db.get(seat))?.armed_trigger_kind).toBe("once");
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  await t.run(async ({ db }) => {
    expect((await db.get(moved.at(-1)!))?.user_id).toBe(runner);
    expect((await db.get(seat))?.armed_trigger_kind).toBe("once");
  });
});

test("a later witness page repairs once when the initial scan found no armed trigger", async () => {
  const t = serverTest({});
  const { seat, moved, personal, offSeat, alreadyOwned } = await seedSeat(
    t,
    120,
    "Check in ".repeat(5_000),
  );
  await t.run(async ({ db }) => {
    await db.patch(seat, { armed_trigger_kind: "none" });
    await db.patch(moved.at(-1)!, { schedule_type: "once" });
    for (const id of [personal, offSeat, alreadyOwned, ...moved.slice(0, -1)]) {
      await db.patch(id, { status: "completed" });
    }
  });
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  expect((await t.run(({ db }) => db.get(seat)))?.armed_trigger_kind).toBe(
    "none",
  );
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await t.run(({ db }) => db.get(seat)))?.armed_trigger_kind).toBe(
    "once",
  );
});

test("the original continuation stops when a third runner takes the seat", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved, alreadyOwned } = await seedSeat(
    t,
    500,
  );
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  const nextRunner = await t.run(async ({ db }) => {
    expect((await db.get(moved[0]))?.user_id).toBe(runner);
    const user = await db.insert("users", { name: "Third runner" });
    await db.patch(seat, { user_id: user });
    return user;
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await scheduledJobs(t, continuation)).toHaveLength(2);
  await t.run(async (ctx) => {
    expect((await ctx.db.get(moved[0]))?.user_id).toBe(runner);
    expect((await ctx.db.get(moved.at(-1)!))?.user_id).toBe(oldRunner);
    await handRoleTriggersToRunner(ctx, seat);
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  await t.run(async ({ db }) => {
    const owners = await Promise.all(
      [alreadyOwned, ...moved].map(async (id) => (await db.get(id))?.user_id),
    );
    expect(new Set(owners)).toEqual(new Set([nextRunner]));
  });
});

test.each(["seat a role", "adopt a trigger"] as const)(
  "an explicit handoff revisits page one when it must %s",
  async (change) => {
    const t = serverTest({});
    const { seat, runner, oldRunner, role, offSeat, moved } = await seedSeat(
      t,
      500,
    );
    await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
    await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
    expect(await scheduledJobs(t, continuation)).toHaveLength(1);
    jest.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    await t.run(async (ctx) => {
      const task = (await ctx.db.get(offSeat))!;
      expect(task.user_id).toBe(oldRunner);
      expect((await ctx.db.get(moved[0]))?.user_id).toBe(runner);
      if (change === "seat a role") {
        const otherRole = (await ctx.db.get(task.role_id!))!;
        await ctx.db.patch(otherRole.anchor_id!, { conversation_id: seat });
      } else {
        await ctx.db.patch(offSeat, { role_id: role });
      }
      await handRoleTriggersToRunner(ctx, seat);
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect((await t.run(({ db }) => db.get(offSeat)))?.user_id).toBe(runner);
    expect((await t.run(({ db }) => db.get(moved.at(-1)!)))?.user_id).toBe(
      runner,
    );
    expect(await scheduledJobs(t, continuation)).toHaveLength(6);
  },
);

test.each(["moved", "unseated"])(
  "a continuation skips its role after the anchor is %s",
  async (change) => {
    const t = serverTest({});
    const { seat, runner, oldRunner, moved, role, otherSeat } = await seedSeat(
      t,
      150,
    );
    await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
    jest.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    await t.run(async ({ db }) => {
      expect((await db.get(moved[0]))?.user_id).toBe(runner);
      const anchor = (await db.get(role))!.anchor_id!;
      await db.patch(anchor, {
        conversation_id: change === "moved" ? otherSeat : undefined,
      });
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    await t.run(async ({ db }) => {
      expect((await db.get(moved[0]))?.user_id).toBe(runner);
      expect((await db.get(moved.at(-1)!))?.user_id).toBe(oldRunner);
    });
  },
);

test("old-runner polls hand off due triggers immediately and share one continuation chain", async () => {
  const t = serverTest({});
  const { runner, oldRunner, moved, role, alreadyOwned } = await seedSeat(
    t,
    500,
  );
  const due = moved.slice(-20);
  const claim = await oldRunnerClaims(t, role, oldRunner, due);
  for (const id of [...due, ...due]) {
    expect(await claim(id)).toBeNull();
  }
  expect(await scheduledJobs(t, continuation)).toHaveLength(1);
  await t.run(async ({ db }) => {
    const owners = await Promise.all(
      due.map(async (id) => (await db.get(id))?.user_id),
    );
    expect(new Set(owners)).toEqual(new Set([runner]));
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await scheduledJobs(t, continuation)).toHaveLength(4);
  await t.run(async ({ db }) => {
    const owners = await Promise.all(
      [alreadyOwned, ...moved].map(async (id) => (await db.get(id))?.user_id),
    );
    expect(new Set(owners)).toEqual(new Set([runner]));
  });
});

test("a claim of the last stale trigger leaves projection repair on the queued chain", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved, role } = await seedSeat(t, 150);
  const last = moved.at(-1)!;
  const claim = await oldRunnerClaims(t, role, oldRunner, [last]);
  await t.run(async (ctx) => {
    await ctx.db.patch(seat, { armed_trigger_kind: "none" });
    for (const id of moved.slice(0, -1)) {
      await ctx.db.patch(id, { user_id: runner });
    }
    await handRoleTriggersToRunner(ctx, seat);
  });
  expect(await claim(last)).toBeNull();
  expect((await t.run(({ db }) => db.get(last)))?.user_id).toBe(runner);
  expect(await scheduledJobs(t, continuation)).toHaveLength(1);
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await t.run(({ db }) => db.get(seat)))?.armed_trigger_kind).toBe(
    "standing",
  );
});

test("an explicit restart carries projection repair from a claim on the old chain", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, moved, role } = await seedSeat(t, 150);
  const last = moved.at(-1)!;
  const claim = await oldRunnerClaims(t, role, oldRunner, [last]);
  await t.run(async ({ db }) => {
    for (const id of moved.slice(0, -1))
      await db.patch(id, { user_id: runner });
  });
  expect(await claim(last)).toBeNull();
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  await t.run(async (ctx) => {
    await ctx.db.patch(seat, { armed_trigger_kind: "none" });
    await handRoleTriggersToRunner(ctx, seat);
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await t.run(({ db }) => db.get(seat)))?.armed_trigger_kind).toBe(
    "standing",
  );
});

test("replaying a completed handoff page does not queue another successor", async () => {
  const t = serverTest({});
  const { seat, runner, moved } = await seedSeat(t, 500);
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  const [firstPage] = await scheduledJobs(t, continuation);
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  expect(await scheduledJobs(t, continuation)).toHaveLength(2);
  await t.mutation(
    continuation,
    firstPage.args[0] as FunctionArgs<typeof continuation>,
  );
  expect(await scheduledJobs(t, continuation)).toHaveLength(2);
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await t.run(({ db }) => db.get(moved.at(-1)!)))?.user_id).toBe(
    runner,
  );
});

test.each(["none", "once"] as const)(
  "the last witness page lowers stale standing to %s using the earlier pages",
  async (expected) => {
    const t = serverTest({});
    const { seat, moved, personal, offSeat, alreadyOwned } = await seedSeat(
      t,
      120,
      "Check in ".repeat(5_000),
    );
    await t.run(async ({ db }) => {
      await db.patch(seat, { armed_trigger_kind: "standing" });
      for (const id of [personal, offSeat, alreadyOwned, ...moved]) {
        if (expected === "once" && id === moved[0]) continue;
        await db.patch(id, { status: "completed" });
      }
    });
    await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
    jest.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    expect((await t.run(({ db }) => db.get(seat)))?.armed_trigger_kind).toBe(
      "standing",
    );
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect((await t.run(({ db }) => db.get(seat)))?.armed_trigger_kind).toBe(
      expected,
    );
  },
);

test("handoff retains a standing witness beyond the scan budget before the first owner write", async () => {
  const t = serverTest({});
  const { seat, runner, moved, personal, offSeat, alreadyOwned } =
    await seedSeat(t, 140, "Check in ".repeat(5_000));
  const standing = moved[105];
  const last = moved.at(-1)!;
  await t.run(async ({ db }) => {
    await db.patch(seat, { armed_trigger_kind: "standing" });
    for (const id of [personal, offSeat, alreadyOwned, ...moved]) {
      if (id === last) await db.patch(id, { status: "completed" });
      else
        await db.patch(id, {
          user_id: runner,
          ...(id === standing
            ? { schedule_type: "recurring" as const }
            : { status: "completed" as const }),
        });
    }
  });
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  await t.run(async ({ db }) => {
    expect((await db.get(last))?.user_id).toBe(runner);
    expect((await db.get(seat))?.armed_trigger_kind).toBe("standing");
  });
});

test("small retirement cancels in trigger order and repairs the kind after each change", async () => {
  const t = serverTest({});
  const { seat, role, moved, alreadyOwned } = await seedSeat(t, 3);
  await t.run(async (ctx) => {
    await ctx.db.patch(seat, { armed_trigger_kind: "standing" });
    await ctx.db.patch(alreadyOwned, { status: "failed" });
    await ctx.db.patch(moved[0], { schedule_type: "recurring" });
    await ctx.db.patch(moved[2], { schedule_type: "once" });
    const writes: unknown[] = [];
    const dbReads = countDatabaseReads(ctx.db);
    const db = {
      ...dbReads.db,
      patch: (async (id, patch) => {
        writes.push([id, patch]);
        await ctx.db.patch(id, patch);
      }) as typeof ctx.db.patch,
    };
    const owner = (await ctx.db.get(role))!.host_user_id;
    await cancelTasksOriginatingFrom(
      { ...ctx, db },
      seat,
      {
        role,
        by: owner,
        keepTitle: "Seat routine",
      },
      async () => {
        throw new Error("Small retirement scheduled work");
      },
    );
    const patch = { status: "cancelled" };
    expect(writes).toEqual([
      [moved[0], patch],
      [seat, { armed_trigger_kind: "once" }],
      [moved[1], patch],
      [moved[2], patch],
    ]);
    expect(
      dbReads.reads.filter((table) => table === "agent_tasks"),
    ).toHaveLength(1);
  });
});

test.each(["keep", "retire"] as const)(
  "a 500-trigger retirement that chooses %s finishes under default limits and is repeatable",
  async (standing_session) => {
    const t = serverTest({});
    const {
      seat,
      runner,
      oldRunner,
      role,
      moved,
      alreadyOwned,
      personal,
      offSeat,
    } = await seedSeat(t, 500);
    const retire = () =>
      asUser(t, oldRunner).mutation(api.orgRoles.retire, {
        role_id: role,
        standing_session,
      });
    await t.run(async ({ db }) => {
      await db.patch(alreadyOwned, { status: "completed" });
      await db.patch(moved[0], { status: "paused" });
      await db.patch(moved[1], { status: "running" });
    });
    expect(await retire()).toMatchObject({
      status: "retired",
      pending_trigger_cancellation: true,
    });
    expect(
      (await t.run(({ db }) => db.get(seat)))?.inbox_killed_at,
    ).toBeUndefined();
    const cancel = internal.orgRoles.continueRoleTriggerCancellation;
    expect(await scheduledJobs(t, cancel)).toHaveLength(1);
    expect((await retire()).cancelled_triggers).toBe(0);
    expect(await scheduledJobs(t, cancel)).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect(await scheduledJobs(t, cancel)).toHaveLength(4);
    await t.run(async ({ db }) => {
      const tasks = await db
        .query("agent_tasks")
        .withIndex("by_originating_conversation", (q) =>
          q.eq("originating_conversation_id", seat),
        )
        .collect();
      const kept = standing_session === "keep";
      const cancelled = tasks.filter((task) => task.status === "cancelled");
      expect(cancelled.map((task) => task._id)).toEqual(
        kept ? moved : [personal, offSeat, ...moved],
      );
      expect(tasks.find((task) => task._id === alreadyOwned)).toMatchObject({
        user_id: runner,
        status: "completed",
      });
      const standing = await db.get(seat);
      expect(standing?.armed_trigger_kind).toBe(kept ? "once" : "none");
      expect(Boolean(standing?.inbox_killed_at)).toBe(!kept);
      const changes = await db
        .query("org_changes")
        .withIndex("by_subject", (q) => q.eq("subject.id", role))
        .collect();
      expect(new Set(changes.map((change) => change.batch)).size).toBe(1);
      expect(
        changes.flatMap((change) =>
          (change.writes ?? [])
            .filter(
              (write) =>
                write.table === "agent_tasks" &&
                write.after.status === "cancelled",
            )
            .map((write) => write.id),
        ),
      ).toEqual(cancelled.map((task) => task._id));
    });
    expect((await retire()).cancelled_triggers).toBe(0);
    expect(await scheduledJobs(t, cancel)).toHaveLength(4);
  },
);

test("retirement during a paged handoff cancels the rest under their existing owner", async () => {
  const t = serverTest({});
  const { seat, runner, oldRunner, role, moved } = await seedSeat(t, 500);
  const last = moved.at(-1)!;
  const claim = await oldRunnerClaims(t, role, oldRunner, [last]);
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  expect((await t.run(({ db }) => db.get(moved[0])))?.user_id).toBe(runner);
  await asUser(t, oldRunner).mutation(api.orgRoles.retire, {
    role_id: role,
    standing_session: "retire",
  });
  expect(await claim(last)).toBeNull();
  expect((await t.run(({ db }) => db.get(last)))?.status).toBe("scheduled");
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await scheduledJobs(t, continuation)).toHaveLength(2);
  await t.run(async ({ db }) => {
    expect(await db.get(moved[0])).toMatchObject({
      status: "cancelled",
      user_id: runner,
    });
    expect(await db.get(last)).toMatchObject({
      status: "cancelled",
      user_id: oldRunner,
    });
    expect((await db.get(seat))?.armed_trigger_kind).toBe("none");
  });
});

test("a repeated cancellation cursor does not schedule a second chain", async () => {
  const t = serverTest({});
  const { role, oldRunner, moved } = await seedSeat(t, 500);
  const cancel = internal.orgRoles.continueRoleTriggerCancellation;
  await asUser(t, oldRunner).mutation(api.orgRoles.retire, { role_id: role });
  const [first] = await scheduledJobs(t, cancel);
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  expect(await scheduledJobs(t, cancel)).toHaveLength(2);
  await t.mutation(cancel, first.args[0]);
  expect(await scheduledJobs(t, cancel)).toHaveLength(2);
  const late = await t.run(async ({ db }) => {
    const { _id, _creationTime, ...task } = (await db.get(moved.at(-1)!))!;
    return db.insert("agent_tasks", task);
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await scheduledJobs(t, cancel)).toHaveLength(4);
  expect((await t.run(({ db }) => db.get(late)))?.status).toBe("cancelled");
});

test("the cancellation projection follows a kept trigger edited after its page", async () => {
  const t = serverTest({});
  const { seat, role, oldRunner, personal, offSeat } = await seedSeat(t, 500);
  await t.run(({ db }) => db.patch(personal, { schedule_type: "recurring" }));
  await asUser(t, oldRunner).mutation(api.orgRoles.retire, {
    role_id: role,
    standing_session: "keep",
  });
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  const late = await t.run(async (ctx) => {
    const personalRow = (await ctx.db.get(personal))!;
    const { _id, _creationTime, ...copy } = personalRow;
    const lateId = await ctx.db.insert("agent_tasks", {
      ...copy,
      role_id: role,
      schedule_type: "once",
    });
    await patchTask(ctx, personalRow, { status: "paused" });
    return lateId;
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  await t.run(async ({ db }) => {
    expect((await db.get(personal))?.status).toBe("paused");
    expect((await db.get(offSeat))?.status).toBe("scheduled");
    expect((await db.get(late))?.status).toBe("scheduled");
    expect((await db.get(seat))?.armed_trigger_kind).toBe("once");
  });
});
