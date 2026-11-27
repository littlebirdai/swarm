import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { cronJobs, getFunctionName } from "convex/server";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import { registerSearchMirrorCron } from "./lib/search-mirror-cron.rules";

const mirrorCron = () => {
  const crons = cronJobs();
  registerSearchMirrorCron(crons);
  return crons.crons["advance search mirror"];
};
const TICK_MS = 15_000;
const SETTLE_MS = 10 * 60_000;
const WINDOW_MS = 30 * 86_400_000;
const NOW = Date.UTC(2026, 10, 25);
const BATCH = { batch: 1000 };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

test("quiet ticks read one document and leave maintenance to the fourth tick", async () => {
  const t = serverTest(true);
  await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "idle-mirror");
    const user = await fixture.user();
    const conversation = await fixture.conversation(user);
    for (let i = 0; i < 50; i++) await fixture.message(conversation);
  });
  jest.setSystemTime(NOW + SETTLE_MS + 1_000);
  await t.mutation(internal.searchMirror.advance, BATCH);

  for (let tick = 1; tick <= 4; tick++) {
    jest.setSystemTime(NOW + SETTLE_MS + 1_000 + tick * TICK_MS);
    const metrics = await t.mutation(async (ctx) => {
      await ctx.runMutation(internal.searchMirror.advance, BATCH);
      return ctx.meta.getTransactionMetrics();
    });
    expect(metrics.documentsRead.used).toBe(tick < 4 ? 1 : 3);
    expect(metrics.databaseQueries.used).toBe(tick < 4 ? 3 : 5);
    expect(metrics.documentsWritten.used).toBe(tick < 4 ? 0 : 1);
  }
});

test("the next eligible tick exposes a new message to search after a quiet period", async () => {
  const t = serverTest(true);
  await t.mutation(internal.searchMirror.advance, BATCH);
  jest.setSystemTime(NOW + TICK_MS - 4_000);
  const { user, id } = await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "fresh-mirror");
    const user = await fixture.user();
    const conversation = await fixture.conversation(user, {
      title: "A session",
      subtitle: "",
      idle_summary: "",
    });
    const id = await fixture.message(conversation, {
      content: "searchable hydrangea",
    });
    return { user, id };
  });

  jest.setSystemTime(NOW + TICK_MS);
  await t.mutation(internal.searchMirror.advance, BATCH);
  const viewer = asUser(t, user);
  const search = () =>
    viewer.query(api.conversations.searchConversations, { query: "hydrangea" });
  expect(await search()).toMatchObject({ contentTier: "recent", results: [] });

  jest.setSystemTime(NOW + 2 * TICK_MS);
  await t.mutation(internal.searchMirror.advance, BATCH);
  expect(await search()).toMatchObject({
    contentTier: "recent",
    results: [{ matches: [{ messageId: id }] }],
  });

  await t.run(({ db }) => db.patch(id, { content: "searchable delphinium" }));
  jest.setSystemTime(NOW + SETTLE_MS);
  await t.mutation(internal.searchMirror.advance, BATCH);
  jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
  await t.mutation(internal.searchMirror.advance, BATCH);
  expect(
    await viewer.query(api.conversations.searchConversations, {
      query: "delphinium",
    }),
  ).toMatchObject({ results: [{ matches: [{ messageId: id }] }] });
});

test.each([
  {
    state: "behind",
    cursorLag: WINDOW_MS,
    fresh_cursor: NOW - TICK_MS - 5_001,
  },
  { state: "legacy", cursorLag: SETTLE_MS + 1, fresh_cursor: undefined },
])(
  "an empty $state mirror still advances and becomes live",
  async ({ cursorLag, fresh_cursor }) => {
    const t = serverTest(true);
    await t.run(async ({ db }) => {
      await db.insert("search_mirror_state", {
        cursor: NOW - TICK_MS - cursorLag,
        updated_at: NOW - TICK_MS,
        fresh_cursor,
      });
      await db.insert("search_mirror_live", { live: false });
    });
    await t.mutation(internal.searchMirror.advance, BATCH);
    const state = await t.query(internal.searchMirror.status);
    expect(state).toMatchObject({
      cursor: NOW - SETTLE_MS - 1,
      fresh_behind_ms: 1,
      updated_at_iso: new Date(NOW).toISOString(),
      live: true,
    });
  },
);

test("an oversized batch request stops after 1,000 source rows", async () => {
  const t = serverTest(true);
  const last = await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "mirror-batch-cap");
    const conversation = await fixture.conversation(await fixture.user());
    for (let i = 0; i < 1000; i++) {
      await fixture.message(conversation, { content: "" });
    }
    return fixture.message(conversation);
  });
  const readMirror = () =>
    t.run(({ db }) => db.query("message_search_recent").first());
  jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
  await t.mutation(internal.searchMirror.advance, { batch: 1200 });
  expect(await readMirror()).toBeNull();
  jest.setSystemTime(NOW + SETTLE_MS + 2 * TICK_MS);
  await t.mutation(internal.searchMirror.advance, { batch: 1200 });
  expect(await readMirror()).toMatchObject({ message_id: last });
});

test("a clipped batch keeps its first uncopied row and drains in order", async () => {
  const t = serverTest(true);
  const ids = await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "dense-mirror");
    const user = await fixture.user();
    const conversation = await fixture.conversation(user);
    const ids = [];
    for (let i = 0; i < 601; i++) ids.push(await fixture.message(conversation));
    return ids;
  });
  jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
  const mirroredIds = () =>
    t.run(async ({ db }) =>
      (await db.query("message_search_recent").collect()).map(
        (row) => row.message_id,
      ),
    );
  expect(await t.mutation(internal.searchMirror.advance, BATCH)).toMatchObject({
    caught_up: false,
    copied: 600,
  });
  expect(await mirroredIds()).toEqual(ids.slice(0, 600));

  jest.setSystemTime(NOW + SETTLE_MS + 2 * TICK_MS);
  expect(await t.mutation(internal.searchMirror.advance, BATCH)).toMatchObject({
    caught_up: true,
    copied: 1,
  });
  expect(await mirroredIds()).toEqual(ids);
});

test("large source documents fit the transaction budget while both walks progress", async () => {
  const t = serverTest({ bytesRead: 13 * 1024 ** 2 });
  const content = "w".repeat(800_000);
  const { conversation, older } = await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "large-backlog");
    const conversation = await fixture.conversation(await fixture.user());
    const older = [];
    for (let i = 0; i < 20; i++) {
      older.push(await fixture.message(conversation, { content }));
    }
    return { conversation, older };
  });
  jest.setSystemTime(NOW + SETTLE_MS);
  const recent = await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "large-fresh");
    const recent = [];
    for (let i = 0; i < 5; i++) {
      recent.push(await fixture.message(conversation, { content }));
    }
    return recent;
  });

  jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
  const first = await t.mutation(internal.searchMirror.advance, BATCH);
  expect(first).toMatchObject({ caught_up: false });
  expect(first.fresh_scanned).toBeGreaterThan(0);
  expect(first.scanned).toBeGreaterThan(0);
  for (let tick = 2; tick <= 5; tick++) {
    jest.setSystemTime(NOW + SETTLE_MS + tick * TICK_MS);
    await t.mutation(internal.searchMirror.advance, BATCH);
  }
  const rows = await t.run(({ db }) =>
    db
      .query("message_search_recent")
      .withIndex("by_source_created_at")
      .collect(),
  );
  expect(rows.map((row) => row.message_id)).toEqual([...older, ...recent]);
});

test("a failed tick rolls back and overlapping retries produce one copy per message", async () => {
  const t = serverTest({ documentsWritten: 4 });
  await t.mutation(internal.searchMirror.advance, BATCH);
  const readState = () =>
    t.run(({ db }) => db.query("search_mirror_state").first());
  const before = await readState();
  const ids = await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "retry-mirror");
    const conversation = await fixture.conversation(await fixture.user());
    return [
      await fixture.message(conversation),
      await fixture.message(conversation),
    ];
  });

  jest.setSystemTime(NOW + TICK_MS);
  await expect(
    t.mutation(async (ctx) => {
      for (let i = 0; i < 3; i++) await ctx.db.insert("users", {});
      return ctx.runMutation(internal.searchMirror.advance, BATCH);
    }),
  ).rejects.toThrow("Wrote too many documents");
  const mirroredIds = () =>
    t.run(async ({ db }) =>
      (await db.query("message_search_recent").collect()).map(
        (row) => row.message_id,
      ),
    );
  expect(await readState()).toEqual(before);
  expect(await mirroredIds()).toEqual([]);

  jest.setSystemTime(NOW + 2 * TICK_MS);
  await Promise.all([
    t.mutation(internal.searchMirror.advance, BATCH),
    t.mutation(internal.searchMirror.advance, BATCH),
  ]);
  expect(await mirroredIds()).toEqual(ids);

  jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
  await Promise.all([
    t.mutation(internal.searchMirror.advance, BATCH),
    t.mutation(internal.searchMirror.advance, BATCH),
  ]);
  expect(await mirroredIds()).toEqual(ids);
});

test("maintenance still removes rows that expire during quiet ticks", async () => {
  const t = serverTest(true);
  jest.setSystemTime(NOW - WINDOW_MS + 1_000);
  await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "expire-mirror");
    const conversation = await fixture.conversation(await fixture.user());
    await fixture.message(conversation);
  });
  jest.setSystemTime(NOW);
  await t.mutation(internal.searchMirror.advance, BATCH);

  jest.setSystemTime(NOW + 4 * TICK_MS);
  expect(await t.mutation(internal.searchMirror.advance, BATCH)).toMatchObject({
    expired: 1,
  });
  expect(
    await t.run(({ db }) => db.query("message_search_recent").first()),
  ).toBeNull();
});

test("maintenance drains a large expiry backlog within its read budget", async () => {
  const t = serverTest({ bytesRead: 1.7 * 1024 ** 2 });
  await t.run(async ({ db }) => {
    const fixture = fixtureRows(db, "mirror-gc-budget");
    const conversation = await fixture.conversation(await fixture.user());
    for (let i = 0; i < 30; i++) {
      const message = await fixture.message(conversation, { content: "" });
      await db.insert("message_search_recent", {
        message_id: message,
        conversation_id: conversation,
        role: "user",
        content: "x".repeat(32_000),
        timestamp: NOW,
        source_created_at: NOW - WINDOW_MS - 1,
      });
    }
  });
  const first = await t.mutation(internal.searchMirror.advance, BATCH);
  expect(first.expired).toBeGreaterThan(0);
  expect(first.expired).toBeLessThan(30);
  jest.setSystemTime(NOW + 4 * TICK_MS);
  const second = await t.mutation(internal.searchMirror.advance, BATCH);
  expect(second.expired).toBe(30 - first.expired);
  expect(
    await t.run(({ db }) => db.query("message_search_recent").first()),
  ).toBeNull();
});

test("the idle mirror schedules fewer ticks and resets to the base delay when work arrives", async () => {
  const t = serverTest(true);
  const flag = "SEARCH_MIRROR_CRON_BACKOFF";
  const previous = process.env[flag];
  process.env[flag] = "1";
  expect(mirrorCron().schedule).toEqual({ type: "interval", minutes: 1 });
  expect(mirrorCron().name).toBe(
    getFunctionName(internal.searchMirror.advanceCron),
  );
  const tick = internal.searchMirror.advanceCron;
  const nextTick = async () => {
    const [job, extra] = (await scheduledJobs(t, tick)).filter(
      ({ state }) => state.kind === "pending",
    );
    expect(extra).toBeUndefined();
    return job.scheduledTime;
  };
  const advance = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await t.finishInProgressScheduledFunctions();
  };
  try {
    await t.mutation(tick, {});
    await t.mutation(tick, {});
    for (const delay of [30_000, 30_000, 30_000]) {
      expect(await nextTick()).toBe(Date.now() + delay);
      await advance(delay);
    }
    const message = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "backed-off-mirror");
      return rows.message(await rows.conversation(await rows.user()));
    });
    await advance(29_999);
    expect(
      await t.run(({ db }) => db.query("message_search_recent").first()),
    ).toBeNull();
    await advance(1);
    expect(
      await t.run(({ db }) => db.query("message_search_recent").first()),
    ).toMatchObject({
      message_id: message,
    });
    expect(await nextTick()).toBe(Date.now() + TICK_MS);
  } finally {
    jest.clearAllTimers();
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("the watchdog restarts a lost enabled tick exactly once", async () => {
  const flag = "SEARCH_MIRROR_CRON_BACKOFF";
  const previous = process.env[flag];
  process.env[flag] = "1";
  const t = serverTest(true);
  const tick = internal.searchMirror.advanceCron;
  const pending = async () =>
    (await scheduledJobs(t, tick)).filter(
      ({ state }) => state.kind === "pending",
    );
  try {
    await t.mutation(tick, {});
    const [lost] = await pending();
    expect(lost.scheduledTime).toBe(NOW + 30_000);
    await t.run(({ scheduler }) => scheduler.cancel(lost._id));
    jest.setSystemTime(NOW + 60_000);
    await t.mutation(tick, {});
    const pendingTimes = async () =>
      (await pending()).map(({ scheduledTime }) => scheduledTime);
    const due = NOW + 60_000 + 30_000;
    expect(await pendingTimes()).toEqual([due]);
    await t.mutation(tick, { scheduledAt: lost.scheduledTime });
    expect(await pendingTimes()).toEqual([due]);
  } finally {
    jest.clearAllTimers();
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("the scheduled mirror leaves room in its transaction and finishes the tail on its next tick", async () => {
  const flag = "SEARCH_MIRROR_CRON_BACKOFF";
  const previous = process.env[flag];
  process.env[flag] = "1";
  const t = serverTest(true);
  const last = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "scheduled-mirror-batch");
    const conversation = await rows.conversation(await rows.user());
    for (let i = 0; i < 400; i++) await rows.message(conversation);
    return rows.message(conversation);
  });
  jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
  const tick = internal.searchMirror.advanceCron;
  try {
    await t.mutation(tick, {});
    const read = () =>
      t.run(({ db }) => db.query("message_search_recent").collect());
    expect(await read()).toHaveLength(400);
    jest.advanceTimersByTime(TICK_MS);
    await t.finishInProgressScheduledFunctions();
    const mirrored = await read();
    expect(mirrored).toHaveLength(401);
    expect(mirrored.some(({ message_id }) => message_id === last)).toBe(true);
  } finally {
    jest.clearAllTimers();
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("flag off uses the original 15-second batch and the watchdog does no work", async () => {
  const flag = "SEARCH_MIRROR_CRON_BACKOFF";
  const prior = process.env[flag];
  delete process.env[flag];
  try {
    const job = mirrorCron();
    expect(job.schedule).toEqual({ type: "interval", seconds: 15 });
    expect(job.name).toBe(getFunctionName(internal.searchMirror.advance));
    expect(job.args).toEqual([{ batch: 1000 }]);

    const t = serverTest(true);
    await t.mutation(internal.searchMirror.advance, BATCH);
    const before = await t.run(({ db }) =>
      db.query("search_mirror_state").first(),
    );
    jest.setSystemTime(NOW + 60_000);
    await t.mutation(internal.searchMirror.advanceCron, {});
    await t.mutation(internal.searchMirror.advanceCron, {
      scheduledAt: NOW + 60_000,
    });
    expect(await scheduledJobs(t, internal.searchMirror.advanceCron)).toEqual(
      [],
    );
    expect(
      await t.run(({ db }) => db.query("search_mirror_state").first()),
    ).toEqual(before);
  } finally {
    jest.clearAllTimers();
    if (prior !== undefined) process.env[flag] = prior;
  }
});
