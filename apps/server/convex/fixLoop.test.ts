// The fix loop's server side: a deferred finding without an owner or a due
// date is refused, the overdue sweep fires once per finding, and the health
// board's per-role counts read the right rows.
import { describe, expect, test } from "bun:test";
import { DEFERRAL_NEEDS_OWNER, promiseFields } from "./reviewNotes";
import { fixLoopCounts, readFixLoopCounts } from "./orgHealth";
import { scheduledJobs, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";

const DAY = 86_400_000;

describe("disposition", () => {
  test("deferred needs an owner and a due date", () => {
    const due = Date.now() + 7 * DAY;
    expect(() =>
      promiseFields({ disposition: "deferred", due_at: due }, {}),
    ).toThrow(DEFERRAL_NEEDS_OWNER);
    expect(() =>
      promiseFields({ disposition: "deferred" }, { role_id: "r1" as any }),
    ).toThrow(DEFERRAL_NEEDS_OWNER);
    expect(
      promiseFields(
        { disposition: "deferred", due_at: due },
        { role_id: "r1" as any },
      ),
    ).toMatchObject({
      disposition: "deferred",
      owner_role_id: "r1",
      due_at: due,
    });
    expect(promiseFields({ disposition: "fixed" }, {})).toEqual({
      disposition: "fixed",
    });
    expect(promiseFields({}, {})).toEqual({});
  });
});

async function setup() {
  const t = serverTest();
  const now = Date.now();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "fix loop");
    const user = await rows.user();
    const team = await rows.team();
    const author = await rows.role(user);
    const other = await rows.role(user);
    return { user, team, author, other };
  });
  return {
    ...ids,
    t,
    now,
    findings: (fields: Partial<NewRow<"review_comments">>[]) =>
      t.run(async ({ db }) => {
        const keys = [];
        for (const finding of fields)
          keys.push(
            await db.insert("review_comments", {
              author_user_id: ids.user,
              owner_role_id: ids.author,
              content: "Review finding",
              disposition: "deferred",
              created_at: now - DAY,
              resolved: false,
              ...finding,
            }),
          );
        return keys;
      }),
    signals: (
      fields: Pick<
        NewRow<"signals">,
        "fingerprint" | "created_at" | "role_id"
      >[],
    ) =>
      t.run(async ({ db }) => {
        for (const [index, signal] of fields.entries())
          await db.insert("signals", {
            user_id: ids.user,
            team_id: ids.team,
            workspace: `team:${ids.team}`,
            short_id: `sg-${index + 1}`,
            title: "Signal",
            source: "test",
            kind: "bug",
            observed_at: signal.created_at,
            attach: "held",
            ...signal,
          });
      }),
  };
}

describe("overdue sweep", () => {
  test("fires once per overdue, unresolved, deferred finding", async () => {
    const c = await setup();
    const [late, ...others] = await c.findings([
      { due_at: c.now - DAY },
      { due_at: c.now + DAY },
      { due_at: c.now - DAY, resolved: true },
      { due_at: c.now - DAY, disposition: "fixed" },
    ]);
    const sweep = () =>
      c.t.mutation(internal.reviewNotes.sweepOverduePromises, {});
    expect(await sweep()).toEqual({ filed: 1 });
    expect(await sweep()).toEqual({ filed: 0 });
    await c.t.run(async ({ db }) => {
      expect((await db.get(late))?.promise_signaled_at).toBeGreaterThanOrEqual(
        c.now,
      );
      for (const id of others)
        expect((await db.get(id))?.promise_signaled_at).toBeUndefined();
    });
    const jobs = await scheduledJobs(c.t, internal.signals.ingestAs);
    expect(jobs.map((job) => job.args[0].fingerprint)).toEqual([
      `promise:${late}`,
    ]);
  });
});

describe("health counts", () => {
  test("bugs introduced come from szz signals by role, promises from owned deferred findings", async () => {
    const c = await setup();
    await c.signals([
      { fingerprint: "szz:abc", role_id: c.author, created_at: c.now - DAY },
      { fingerprint: "szz:def", role_id: c.author, created_at: c.now - DAY },
      {
        fingerprint: "szz:old",
        role_id: c.author,
        created_at: c.now - 40 * DAY,
      },
      { fingerprint: "insight:x", role_id: c.author, created_at: c.now - DAY },
      { fingerprint: "szz:ghi", role_id: c.other, created_at: c.now - DAY },
    ]);
    await c.findings([
      { due_at: c.now - DAY },
      { due_at: c.now + DAY },
      { due_at: c.now - DAY, resolved: true },
      { disposition: "rejected" },
    ]);
    await c.t.query(async (ctx) => {
      const inputs = await readFixLoopCounts(ctx, c.user, c.team, c.now, [
        c.author,
        c.other,
      ]);
      expect(fixLoopCounts(inputs, c.author, 3)).toEqual({
        bugs_introduced_30d: 2,
        promises_open: 2,
        promises_overdue: 1,
        done_with_concerns_7d: 3,
      });
      expect(fixLoopCounts(inputs, c.other, 0)).toEqual({
        bugs_introduced_30d: 1,
        promises_open: 0,
        promises_overdue: 0,
        done_with_concerns_7d: 0,
      });
    });
  });

  test("the bug count reads only the fix-loop finder's signals, never the workspace's month of signals (ct-87999)", async () => {
    const c = await setup();
    const signal = { role_id: c.author, created_at: c.now - DAY };
    await c.signals([
      { ...signal, fingerprint: "szz:abc" },
      ...Array.from({ length: 50 }, (_, i) => ({
        ...signal,
        fingerprint: `sentry:${i}`,
      })),
      { ...signal, fingerprint: "szzz" },
    ]);
    await c.t.query(async (ctx) => {
      const inputs = await readFixLoopCounts(ctx, c.user, c.team, c.now, []);
      expect((await ctx.meta.getTransactionMetrics()).documentsRead.used).toBe(
        1,
      );
      expect(inputs.bugsByRole.get(c.author)).toBe(1);
    });
  });
});
