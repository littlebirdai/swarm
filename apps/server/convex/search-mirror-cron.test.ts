import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import crons from "./crons";

const JOB = crons.crons["advance search mirror"];
const TICK_MS = 15_000;
const SETTLE_MS = 10 * 60_000;
const WINDOW_MS = 30 * 86_400_000;
const NOW = Date.UTC(2026, 10, 25);
const BATCH = JOB.args[0] as { batch: number };

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
  expect(JOB.schedule).toEqual({ type: "interval", seconds: 15 });
  expect(JOB.name).toBe(getFunctionName(internal.searchMirror.advance));

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
