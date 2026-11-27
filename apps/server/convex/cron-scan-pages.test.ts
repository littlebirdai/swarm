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
  const [next] = await scheduledJobs(t, internal.daemonLogs.checkDaemonHealth);
  expect(next.args[0]).toMatchObject({ now: NOW, cursor: expect.any(String) });
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
  const [next] = await scheduledJobs(t, internal.agentTasks.reclaimStaleTasks);
  expect(next.args[0]).toMatchObject({
    through: NOW,
    cursor: expect.any(String),
  });
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
  const [next] = await scheduledJobs(t, internal.activityDays.sweep);
  expect(next.args[0]).toMatchObject({
    today: NOW,
    phase: "seen",
    cursor: expect.any(String),
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  const accounts = await t.run(async ({ db }) =>
    (await db.query("user_activity_daily").collect()).map(
      ({ user_id }) => user_id,
    ),
  );
  expect(accounts.sort()).toEqual(eligible.sort());
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
    expect((await scheduledJobs(t, apply))[0]?.args[0]).toMatchObject({
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

test("a pending apply whose last page has stale leases does not report an earlier live daemon offline", async () => {
  const bounded = "BOUNDED_PENDING_MESSAGE_SESSIONS";
  const leases = "INBOX_LIVENESS_LEASES";
  const priorBounded = process.env[bounded];
  const priorLeases = process.env[leases];
  process.env[bounded] = process.env[leases] = "1";
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
        if (i === 0)
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
      status: "injected",
    });
  } finally {
    if (priorBounded === undefined) delete process.env[bounded];
    else process.env[bounded] = priorBounded;
    if (priorLeases === undefined) delete process.env[leases];
    else process.env[leases] = priorLeases;
  }
});
