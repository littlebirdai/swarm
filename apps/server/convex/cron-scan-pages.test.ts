import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { scheduledJobs, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";
import {
  STUCK_MESSAGE_PAGES_PER_RUN,
  STUCK_MESSAGES_PER_PAGE,
} from "./pendingMessages";

const NOW = Date.UTC(2026, 10, 26);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test("the daemon health scan resumes until every offline daemon has one alert", async () => {
  const t = serverTest({ documentsRead: 140 });
  const offline = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "daemon-health-pages");
    const offline = [];
    for (let i = 0; i < 129; i++) {
      offline.push(await rows.user({ last_heartbeat: NOW - 600_001 - i }));
      await rows.user({ last_heartbeat: NOW - i });
    }
    return offline;
  });

  const first = await t.mutation(internal.daemonLogs.checkDaemonHealth, {});
  expect(first).toEqual({ checked: 64, alertsCreated: 64 });
  const [next] = await scheduledJobs(t, internal.cronSweep.continuePage);
  expect(structuredClone(next.args[0].page)).toMatchObject({
    job: "health",
    startedAt: NOW,
    token: 1,
    cursor: expect.any(String),
  });
  await t.mutation(internal.daemonLogs.checkDaemonHealth, {});
  const stale = await t.mutation(internal.daemonLogs.checkDaemonHealth, {
    now: NOW,
    cursor: next.args[0].page.cursor,
    token: 1,
  });
  expect(stale).toEqual({ checked: 0, alertsCreated: 0 });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());

  const recipients = await t.run(async ({ db }) =>
    (await db.query("daemon_logs").collect()).map((row) => row.user_id),
  );
  expect(recipients.sort()).toEqual(offline.sort());
});

test("the lease reclaim cursor reaches later expired tasks without scanning future leases", async () => {
  const t = serverTest({ documentsRead: 96 });
  const tasks = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task-reclaim-pages");
    const owner = await rows.user();
    const task = (lease_expires_at: number) =>
      db.insert("agent_tasks", {
        user_id: owner,
        title: "Sweep lease",
        prompt: "Run",
        schedule_type: "once",
        mode: "apply",
        status: "running",
        lease_expires_at,
        run_at: NOW - 60_000,
        run_count: 0,
        retry_count: 0,
        created_at: NOW - 60_000,
      });
    const expired = [];
    for (let i = 0; i < 37; i++) expired.push(await task(NOW - 1));
    for (let i = 0; i < 110; i++)
      await rows.conversation(owner, { agent_task_id: expired[0] });
    const future = [];
    for (let i = 0; i < 110; i++) future.push(await task(NOW + 1));
    return { expired, lastFuture: future.at(-1)! };
  });

  expect(await t.mutation(internal.agentTasks.reclaimStaleTasks, {})).toBe(16);
  const [next] = await scheduledJobs(t, internal.cronSweep.continuePage);
  expect(structuredClone(next.args[0].page)).toMatchObject({
    job: "reclaim",
    startedAt: NOW,
    token: 1,
    cursor: expect.any(String),
  });
  await t.mutation(internal.agentTasks.reclaimStaleTasks, {});
  expect(
    await t.mutation(internal.agentTasks.reclaimStaleTasks, {
      through: NOW,
      cursor: next.args[0].page.cursor,
      token: 1,
    }),
  ).toBe(0);
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());

  await t.run(async ({ db }) => {
    for (const id of tasks.expired)
      expect(await db.get(id)).toMatchObject({ status: "scheduled" });
    expect(await db.get(tasks.lastFuture)).toMatchObject({ status: "running" });
  });
});

test("activity rollup reaches every eligible account without loading dormant users", async () => {
  const t = serverTest({ documentsRead: 80 });
  const day = 86_400_000;
  const eligible = await t.run(async ({ db }) => {
    jest.setSystemTime(NOW - 7 * day);
    const old = fixtureRows(db, "activity-cron-old");
    const ids = [];
    for (let i = 0; i < 110; i++) await old.user();
    for (let i = 0; i < 34; i++)
      ids.push(await old.user({ daemon_last_seen: NOW - i }));
    jest.setSystemTime(NOW - day);
    const fresh = fixtureRows(db, "activity-cron-new");
    ids.push(await fresh.user(), await fresh.user({ daemon_last_seen: NOW }));
    for (const id of ids)
      await fresh.conversation(id, {
        started_at: NOW - day,
        updated_at: NOW - day + 3_600_000,
        message_count: 1,
      });
    return ids;
  });

  jest.setSystemTime(NOW);
  expect(await t.action(internal.activityDays.sweep, { days: 2 })).toEqual({
    users: 32,
    rolled: 32,
    failed: 0,
  });
  const [next] = await scheduledJobs(t, internal.cronSweep.continuePage);
  expect(structuredClone(next.args[0].page)).toMatchObject({
    job: "activity",
    startedAt: NOW,
    token: 1,
    phase: "seen",
    cursor: expect.any(String),
  });
  jest.setSystemTime(NOW + 50_000);
  await t.run(async ({ db }) => {
    for (const id of eligible.slice(0, 34))
      await db.patch(id, { daemon_last_seen: Date.now() });
  });
  const { cursor, startedAt, days, token } = next.args[0].page;
  expect(
    await t.action(internal.activityDays.sweep, {
      cursor,
      startedAt,
      days,
      token,
      phase: "seen",
    }),
  ).toEqual({
    users: 0,
    rolled: 0,
    failed: 0,
  });
  const tail = (await scheduledJobs(t, internal.cronSweep.continuePage)).find(
    (job) => job.args[0].page.phase === "tail",
  );
  expect(tail).toBeDefined();
  const {
    phase: tailPhase,
    cursor: tailCursor,
    tailEnd,
    tailPagesRemaining,
  } = tail!.args[0].page;
  expect(
    await t.action(internal.activityDays.sweep, {
      startedAt,
      days,
      token,
      phase: tailPhase,
      cursor: tailCursor,
      tailEnd,
      tailPagesRemaining,
    }),
  ).toEqual({
    users: 2,
    rolled: 2,
    failed: 0,
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  const accounts = await t.run(async ({ db }) =>
    (await db.query("user_activity_daily").collect()).map(
      ({ user_id }) => user_id,
    ),
  );
  expect(accounts.sort()).toEqual(eligible.toSorted());
  await t.action(internal.activityDays.sweep, { days: 2 });
  expect(
    await t.action(internal.activityDays.sweep, {
      cursor,
      startedAt,
      days,
      token,
      phase: "seen",
    }),
  ).toEqual({
    users: 0,
    rolled: 0,
    failed: 0,
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
});

test.each([65, 161])(
  "the activity tail reaches the created phase with %i active accounts",
  async (count) => {
    const t = serverTest({ documentsRead: 80 });
    const day = 86_400_000;
    const { users, recent } = await t.run(async ({ db }) => {
      jest.setSystemTime(NOW - 7 * day);
      const old = fixtureRows(db, "activity-tail-paid");
      const users = [];
      for (let i = 0; i < count; i++)
        users.push(await old.user({ daemon_last_seen: NOW + i + 1 }));
      jest.setSystemTime(NOW - day);
      const fresh = fixtureRows(db, "activity-tail-fresh");
      const recent = await fresh.user();
      await fresh.conversation(recent, {
        started_at: NOW - day,
        updated_at: NOW - day + 1000,
      });
      return { users, recent };
    });
    const sweep = internal.activityDays.sweep;
    const continuation = internal.cronSweep.continuePage;
    jest.setSystemTime(NOW + 1000);
    await t.action(sweep, { days: 2, startedAt: NOW });
    if (count === 65) {
      const [first] = await scheduledJobs(t, continuation);
      const { job, ...page } = first.args[0].page;
      expect(await t.action(sweep, page)).toMatchObject({ rolled: 32 });
      jest.setSystemTime(NOW + 50_000);
      await t.run(async ({ db }) => {
        for (const id of users.slice(0, 64))
          await db.patch(id, { daemon_last_seen: Date.now() });
      });
    }
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    const phases = (await scheduledJobs(t, continuation)).map(
      ({ args }) => args[0].page.phase,
    );
    expect(phases.filter((phase) => phase === "tail")).toHaveLength(
      count === 65 ? 2 : 4,
    );
    expect(phases).toContain("created");
    if (count === 65)
      expect(await t.run(({ db }) => db.get(users[33]))).not.toHaveProperty(
        "last_activity_rollup_run",
      );
    else
      expect(await t.run(({ db }) => db.get(users[128]))).not.toHaveProperty(
        "last_activity_rollup_run",
      );
    expect(await t.run(({ db }) => db.get(recent))).toMatchObject({
      last_activity_rollup_run: 1,
    });
  },
);

test("a failed activity day is retried without repeating that user's successful day", async () => {
  const t = serverTest({ documentsRead: 80 });
  const day = 86_400_000;
  const { user, excess } = await t.run(async ({ db }) => {
    jest.setSystemTime(NOW - 7 * day);
    const rows = fixtureRows(db, "activity-failed-day");
    const user = await rows.user({ daemon_last_seen: NOW });
    const sessionAt = (at: number) =>
      rows.conversation(user, { started_at: at, updated_at: at + 1000 });
    await sessionAt(NOW - day);
    const excess = [];
    for (let i = 0; i < 85; i++) excess.push(await sessionAt(NOW - 2 * day));
    return { user, excess };
  });
  jest.setSystemTime(NOW);
  const sweep = internal.activityDays.sweep;
  expect(await t.action(sweep, { days: 3 })).toEqual({
    users: 1,
    rolled: 1,
    failed: 1,
  });
  expect(await t.action(sweep, { days: 3, startedAt: NOW, token: 1 })).toEqual({
    users: 0,
    rolled: 0,
    failed: 0,
  });
  const jobs = await scheduledJobs(t, internal.activityDays.rollupDay);
  expect(jobs.map(({ args }) => args[0])).toEqual([
    { user_id: user, day_start: NOW - 2 * day, sweepToken: 1 },
  ]);
  await t.run(async ({ db }) => {
    for (const id of excess.slice(1, 20)) await db.delete(id);
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(
    await t.run(async ({ db }) =>
      (await db.query("user_activity_daily").collect())
        .map(({ day_start }) => day_start)
        .sort(),
    ),
  ).toEqual([NOW - 2 * day, NOW - day]);
});

test("a backlog larger than a cron run is drained after resuming its checkpoint", async () => {
  const t = serverTest({});
  const now = Date.now();
  const firstRun = STUCK_MESSAGES_PER_PAGE * STUCK_MESSAGE_PAGES_PER_RUN;
  const { ids, session } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "pending-cron-checkpoint");
    const owner = await rows.user();
    const conversation = await rows.conversation(owner);
    const session = await db.insert("managed_sessions", {
      conversation_id: conversation,
      user_id: owner,
      session_id: "checkpoint-daemon",
      pid: 1,
      started_at: now,
      last_heartbeat: now,
      agent_status: "idle",
    });
    const ids = [];
    for (let i = 0; i < firstRun + 3; i++)
      ids.push(
        await db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: owner,
          status: "failed",
          created_at: now - 40 * 60_000 + i,
          content: "Retry",
          retry_count: 6,
        }),
      );
    return { ids, session };
  });
  try {
    await t.action(internal.pendingMessages.retryStuckMessages, {});
    await t.run(async ({ db }) => {
      expect(await db.get(ids[firstRun - 1])).toMatchObject({
        status: "pending",
      });
      expect(await db.get(ids[firstRun])).toMatchObject({ status: "failed" });
      expect(
        await db.query("pending_message_sweep_state").first(),
      ).toMatchObject({
        cursor: { through: now, createdAt: now - 40 * 60_000 + firstRun - 1 },
      });
    });
    jest.setSystemTime(now + 60_000);
    await t.run(({ db }) => db.patch(session, { last_heartbeat: Date.now() }));
    await t.action(internal.pendingMessages.retryStuckMessages, {});
    await t.run(async ({ db }) => {
      const remaining = await db
        .query("pending_messages")
        .withIndex("by_status", (q) => q.eq("status", "failed"))
        .take(1);
      expect(remaining).toEqual([]);
      expect(
        await db.query("pending_message_sweep_state").first(),
      ).toMatchObject({ cursor: null });
    });
  } finally {
    jest.setSystemTime(now);
  }
});

test("a bounded apply reaches the ready session past multiple busy pages", async () => {
  const flag = "BOUNDED_PENDING_MESSAGE_SESSIONS";
  const previous = process.env[flag];
  process.env[flag] = "1";
  const now = Date.now();
  const t = serverTest({ documentsRead: 68 });
  try {
    const message = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "pending-apply-pages");
      const owner = await rows.user();
      const conversation = await rows.conversation(owner);
      for (let i = 0; i < 75; i++)
        await db.insert("managed_sessions", {
          conversation_id: conversation,
          user_id: owner,
          session_id: `managed-${i}`,
          pid: i + 1,
          started_at: now - 10 * 60_000,
          last_heartbeat: now - 1000 + i,
          agent_status: i === 74 ? "idle" : "working",
        });
      return db.insert("pending_messages", {
        conversation_id: conversation,
        from_user_id: owner,
        status: "failed",
        created_at: now - 40 * 60_000,
        content: "Retry",
        retry_count: 6,
      });
    });
    const apply = internal.pendingMessages.applyStuckMessages;
    await t.mutation(apply, {
      ids: [message],
      now,
      deadRevivesRemaining: 1,
      allowHostedWake: true,
    });
    expect(await t.run(({ db }) => db.get(message))).toMatchObject({
      status: "failed",
    });
    expect(
      (await scheduledJobs(t, internal.cronSweep.continuePending))[0]?.args[0]
        .page,
    ).toMatchObject({
      runToken: 1,
      sessionCursor: expect.any(String),
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect(await t.run(({ db }) => db.get(message))).toMatchObject({
      status: "pending",
      retry_count: 0,
    });
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
] as const)(
  "a pending apply carries real liveness across stale pages (leases %s, side heartbeat %s)",
  async (useLeases, beat) => {
    const bounded = "BOUNDED_PENDING_MESSAGE_SESSIONS";
    const leases = "INBOX_LIVENESS_LEASES";
    const priorBounded = process.env[bounded];
    const priorLeases = process.env[leases];
    process.env[bounded] = "1";
    if (useLeases) process.env[leases] = "1";
    else delete process.env[leases];
    const now = Date.now();
    const t = serverTest({ documentsRead: 68 });
    try {
      const old = now - 40 * 60_000;
      const message = await t.run(async ({ db }) => {
        const rows = fixtureRows(db, "pending-apply-live-lease");
        const owner = await rows.user();
        const conversation = await rows.conversation(owner);
        for (let i = 0; i < 68; i++) {
          const id = await db.insert("managed_sessions", {
            conversation_id: conversation,
            user_id: owner,
            session_id: `managed-lease-${i}`,
            pid: i + 1,
            started_at: old,
            last_heartbeat: old,
            liveness_lease: { end: old, expired: false },
            agent_status: "working",
          });
          if (beat && i === 0)
            await db.insert("session_heartbeats", {
              managed_session_id: id,
              user_id: owner,
              heartbeat_at: now,
            });
        }
        return db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: owner,
          status: "injected",
          created_at: old,
          paste_verified_at: old,
          content: "Sent and waiting for its echo",
          retry_count: 0,
        });
      });
      const plan = await t.query(internal.pendingMessages.planStuckMessages, {
        now,
      });
      expect(plan.groups[0]?.ids).toEqual([message]);
      const apply = internal.pendingMessages.applyStuckMessages;
      await t.mutation(apply, {
        ids: [message],
        now,
        deadRevivesRemaining: 1,
        allowHostedWake: true,
      });
      await t.finishAllScheduledFunctions(() => jest.runAllTimers());
      expect(await t.run(({ db }) => db.get(message))).toMatchObject({
        status: beat ? "injected" : "failed",
      });
    } finally {
      if (priorBounded === undefined) delete process.env[bounded];
      else process.env[bounded] = priorBounded;
      if (priorLeases === undefined) delete process.env[leases];
      else process.env[leases] = priorLeases;
    }
  },
);

test("paged applies share the run's revive budget and retain the deferred message", async () => {
  const flag = "BOUNDED_PENDING_MESSAGE_SESSIONS";
  const previous = process.env[flag];
  process.env[flag] = "1";
  const t = serverTest({ documentsRead: 138 });
  try {
    const ids = await t.run(async ({ db }) => {
      const fixture = fixtureRows(db, "pending-revive-budget");
      const owner = await fixture.user();
      const ids = [];
      for (let group = 0; group < 4; group++) {
        const conversation = await fixture.conversation(owner);
        for (let i = 0; i < 65; i++)
          await fixture.session(owner, {
            conversation_id: conversation,
            last_heartbeat: NOW - 60 * 60_000,
            liveness_lease: { end: NOW - 60 * 60_000, expired: false },
          });
        ids.push(
          await db.insert("pending_messages", {
            conversation_id: conversation,
            from_user_id: owner,
            status: "failed",
            created_at: NOW - 40 * 60_000 + group,
            content: "retry",
            retry_count: 6,
          }),
        );
      }
      return ids;
    });
    await t.action(internal.pendingMessages.retryStuckMessages, {});
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    const messages = await t.run(async ({ db }) =>
      Promise.all(ids.map((id) => db.get(id))),
    );
    expect(
      messages.filter((row) => row?.dead_session_revived_at !== undefined),
    ).toHaveLength(3);
    const heldRows = await t.run(({ db }) =>
      db.query("pending_message_sweep_retries").collect(),
    );
    expect(heldRows).toHaveLength(1);
    const [held] = heldRows;
    expect(held).toMatchObject({ reason: "dead_revive_limit" });
    expect(
      messages.find((message) => message?._id === held.message_id)?.status,
    ).toBe("failed");
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("a failed pending page is recorded and a superseded chain leaves retry work alone", async () => {
  const flag = "BOUNDED_PENDING_MESSAGE_SESSIONS";
  const previous = process.env[flag];
  process.env[flag] = "1";
  const t = serverTest({});
  try {
    const message = await t.run(async ({ db }) => {
      const fixture = fixtureRows(db, "pending-continuation-failure");
      const owner = await fixture.user();
      const conversation = await fixture.conversation(owner);
      for (let i = 0; i < 35; i++)
        await fixture.session(owner, {
          conversation_id: conversation,
          last_heartbeat: NOW - 60 * 60_000,
        });
      return db.insert("pending_messages", {
        conversation_id: conversation,
        from_user_id: owner,
        status: "failed",
        created_at: NOW - 40 * 60_000,
        content: "retry",
        retry_count: 6,
      });
    });
    await t.mutation(internal.pendingMessages.applyStuckMessages, {
      ids: [message],
      now: NOW,
      deadRevivesRemaining: 1,
      allowHostedWake: true,
    });
    const [next] = await scheduledJobs(t, internal.cronSweep.continuePending);
    const retry = () =>
      t.run(({ db }) => db.query("pending_message_sweep_retries").first());
    expect(await retry()).toMatchObject({ reason: "scan_pending" });
    await t.action(internal.cronSweep.continuePending, {
      page: { ...next.args[0].page, sessionCursor: "invalid JSON cursor" },
    });
    expect(await retry()).toMatchObject({ reason: "apply_failed" });
    await t.mutation(internal.cronSweep.beginPending, {});
    await t.action(internal.cronSweep.continuePending, next.args[0]);
    expect(await retry()).toMatchObject({ reason: "apply_failed" });
    expect(await t.run(({ db }) => db.get(message))).toMatchObject({
      status: "failed",
    });
    jest.setSystemTime(NOW + 60_000);
    await t.action(internal.pendingMessages.retryStuckMessages, {});
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect(await retry()).toBeNull();
    expect(await t.run(({ db }) => db.get(message))).toMatchObject({
      status: "pending",
    });
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("a failed sweep page records its cursor and schedules one retry", async () => {
  const t = serverTest({});
  const token = await t.mutation(internal.cronSweep.begin, { job: "health" });
  const page = {
    job: "health",
    startedAt: NOW,
    token: token!,
    cursor: "invalid JSON cursor",
  } as const;
  await t.action(internal.cronSweep.continuePage, { page });
  const failure = () =>
    t.run(({ db }) =>
      db
        .query("system_config")
        .withIndex("by_key", (q) => q.eq("key", "cron_sweep_failure:health"))
        .unique(),
    );
  expect(JSON.parse((await failure())!.value)).toMatchObject({
    page,
    retried: false,
  });
  const [retry] = await scheduledJobs(t, internal.cronSweep.continuePage);
  expect(retry.args[0]).toEqual({ page, retried: true });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(JSON.parse((await failure())!.value)).toMatchObject({
    page,
    retried: true,
  });
  expect(await scheduledJobs(t, internal.cronSweep.continuePage)).toHaveLength(
    1,
  );
});
