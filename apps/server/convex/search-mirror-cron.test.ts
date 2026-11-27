import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import crons from "./crons";

const mirrorCron = crons.crons["advance search mirror"];
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

test.each([false, true])(
  "the fixed cron makes four calls per minute with bounded writes (busy: %s)",
  async (busy) => {
    const flag = "SEARCH_MIRROR_CRON_BACKOFF";
    const previous = process.env[flag];
    const cron = makeFunctionReference<"mutation">(mirrorCron.name);
    const args = Array.isArray(mirrorCron.args)
      ? mirrorCron.args[0]
      : undefined;
    expect(mirrorCron.schedule).toEqual({ type: "interval", seconds: 15 });
    try {
      const results = [];
      for (const enabled of [false, true]) {
        if (enabled) process.env[flag] = "1";
        else delete process.env[flag];
        const t = serverTest(true);
        jest.setSystemTime(NOW - TICK_MS);
        const conversation = await t.run(async ({ db }) => {
          const rows = fixtureRows(db, "mirror-minute");
          const id = await rows.conversation(await rows.user());
          if (busy) await rows.message(id);
          return id;
        });
        jest.setSystemTime(NOW);
        await t.mutation(cron, args);
        const writes = [];
        const queries = [];
        for (let tick = 1; tick <= 4; tick++) {
          if (busy)
            await t.run(({ db }) =>
              fixtureRows(db, `mirror-minute-${tick}`).message(conversation),
            );
          jest.setSystemTime(NOW + tick * TICK_MS);
          const metrics = await t.mutation(async (ctx) => {
            await ctx.runMutation(cron, args);
            return ctx.meta.getTransactionMetrics();
          });
          writes.push(metrics.documentsWritten.used);
          queries.push(metrics.databaseQueries.used);
        }
        const jobs = await scheduledJobs(t, internal.searchMirror.advanceCron);
        results.push({ calls: writes.length + jobs.length, writes, queries });
      }
      const [off, on] = results;
      expect(off.calls).toBe(4);
      expect(on.calls).toBe(4);
      expect(on.writes).toEqual(off.writes);
      if (busy) {
        expect(on.writes).toEqual([2, 2, 2, 2]);
      } else {
        expect(on.writes).toEqual([0, 0, 0, 1]);
        expect(on.queries[0]).toBe(1);
        expect(on.queries[2]).toBe(1);
        expect(on.queries.reduce((sum, n) => sum + n, 0)).toBeLessThan(
          off.queries.reduce((sum, n) => sum + n, 0),
        );
      }
    } finally {
      jest.clearAllTimers();
      if (previous === undefined) delete process.env[flag];
      else process.env[flag] = previous;
    }
  },
);

test("a due tick that finds work restores the 15-second cadence", async () => {
  const flag = "SEARCH_MIRROR_CRON_BACKOFF";
  const previous = process.env[flag];
  process.env[flag] = "1";
  const t = serverTest(true);
  const tick = internal.searchMirror.advanceCron;
  try {
    await t.mutation(tick, {});
    const conversation = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "mirror-recovery");
      return rows.conversation(await rows.user());
    });
    const seed = (name: string) =>
      t.run(({ db }) => fixtureRows(db, name).message(conversation));
    const mirrored = () =>
      t.run(async ({ db }) =>
        (await db.query("message_search_recent").collect()).map(
          ({ message_id }) => message_id,
        ),
      );
    const first = await seed("mirror-recovery-first");
    jest.setSystemTime(NOW + TICK_MS);
    await t.mutation(tick, {});
    expect(await mirrored()).toEqual([]);
    jest.setSystemTime(NOW + 2 * TICK_MS);
    await t.mutation(tick, {});
    expect(await mirrored()).toEqual([first]);
    const second = await seed("mirror-recovery-second");
    jest.setSystemTime(NOW + 3 * TICK_MS);
    await t.mutation(tick, {});
    expect(await mirrored()).toEqual([first, second]);
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test.each(["busy", "idle"] as const)(
  "15-second tick jitter preserves the %s mirror cadence",
  async (cadence) => {
    const flag = "SEARCH_MIRROR_CRON_BACKOFF";
    const previous = process.env[flag];
    process.env[flag] = "1";
    const t = serverTest(true);
    const tick = internal.searchMirror.advanceCron;
    try {
      jest.setSystemTime(NOW - TICK_MS);
      const { conversation, warm } = await t.run(async ({ db }) => {
        const rows = fixtureRows(db, "mirror-jitter");
        const conversation = await rows.conversation(await rows.user());
        const warm =
          cadence === "busy" ? await rows.message(conversation) : undefined;
        return { conversation, warm };
      });
      const seed = (name: string) =>
        t.run(({ db }) => fixtureRows(db, name).message(conversation));
      const mirrored = () =>
        t.run(async ({ db }) =>
          (await db.query("message_search_recent").collect()).map(
            ({ message_id }) => message_id,
          ),
        );
      const fire = async (number: number, jitter: number) => {
        jest.setSystemTime(NOW + number * TICK_MS + jitter);
        return t.mutation(async (ctx) => {
          await ctx.runMutation(tick, {});
          return (await ctx.meta.getTransactionMetrics()).databaseQueries.used;
        });
      };
      await fire(0, 0);
      if (cadence === "busy") {
        const early = await seed("mirror-jitter-early");
        await fire(1, -10);
        expect(await mirrored()).toEqual([warm, early]);
        const late = await seed("mirror-jitter-late");
        await fire(2, 10);
        expect(await mirrored()).toEqual([warm, early, late]);
      } else {
        expect(await fire(1, 10)).toBe(1);
        expect(await fire(2, -10)).toBeGreaterThan(1);
        const message = await seed("mirror-jitter-idle-message");
        expect(await fire(3, -10)).toBe(1);
        expect(await mirrored()).toEqual([]);
        await fire(4, -10);
        expect(await mirrored()).toEqual([message]);
      }
    } finally {
      if (previous === undefined) delete process.env[flag];
      else process.env[flag] = previous;
    }
  },
);

test("the backoff cron leaves room in its transaction and finishes the tail on its next tick", async () => {
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
    jest.setSystemTime(Date.now() + TICK_MS);
    await t.mutation(tick, {});
    const mirrored = await read();
    expect(mirrored).toHaveLength(401);
    expect(mirrored.some(({ message_id }) => message_id === last)).toBe(true);
  } finally {
    jest.clearAllTimers();
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("the registered cron switches to backoff and back to the original batch at runtime", async () => {
  const flag = "SEARCH_MIRROR_CRON_BACKOFF";
  const prior = process.env[flag];
  delete process.env[flag];
  const cron = makeFunctionReference<"mutation">(mirrorCron.name);
  const scheduled = internal.searchMirror.advanceCron;
  const t = serverTest(true);
  try {
    expect(mirrorCron.schedule).toEqual({ type: "interval", seconds: 15 });
    const args = Array.isArray(mirrorCron.args)
      ? mirrorCron.args[0]
      : undefined;
    expect(args).toBeDefined();
    const seedMessages = (seed: string, count: number) =>
      t.run(async ({ db }) => {
        const rows = fixtureRows(db, seed);
        const conversation = await rows.conversation(await rows.user());
        for (let i = 0; i < count; i++) await rows.message(conversation);
      });
    const pending = async () =>
      (await scheduledJobs(t, scheduled)).filter(
        ({ state }) => state.kind === "pending",
      );
    const mirrored = () =>
      t.run(
        async ({ db }) =>
          (await db.query("message_search_recent").collect()).length,
      );

    await seedMessages("mirror-runtime-off", 401);
    jest.setSystemTime(NOW + SETTLE_MS + TICK_MS);
    await t.mutation(cron, args);
    expect(await mirrored()).toBe(401);
    expect(await pending()).toEqual([]);

    process.env[flag] = "1";
    await t.mutation(cron, args);
    expect(await pending()).toEqual([]);
    const timing = await t.run(({ db }) =>
      db.query("search_mirror_state").first(),
    );
    expect(timing?.next_tick_at).toBe(Date.now() + 30_000);

    delete process.env[flag];
    await seedMessages("mirror-runtime-off-again", 401);
    jest.setSystemTime(Date.now() + SETTLE_MS + TICK_MS);
    const before = await t.run(({ db }) =>
      db.query("search_mirror_state").first(),
    );
    await t.mutation(scheduled, { scheduledAt: timing?.next_tick_at });
    expect(await mirrored()).toBe(401);
    expect(
      await t.run(({ db }) => db.query("search_mirror_state").first()),
    ).toEqual(before);
    await t.mutation(cron, args);
    expect(await mirrored()).toBe(802);
    expect(await pending()).toEqual([]);
  } finally {
    jest.clearAllTimers();
    if (prior === undefined) delete process.env[flag];
    else process.env[flag] = prior;
  }
});
