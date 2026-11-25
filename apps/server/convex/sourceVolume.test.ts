import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import type { Doc } from "./_generated/dataModel";
import {
  countLanded,
  patchSourceStats,
  withHourCount,
} from "./lib/sourceStats";
import { addPoint, mergeVolume, recordingVolume } from "./sourceVolume";

const NOW = Date.parse("2026-11-03T15:30:00Z");
const H = 3_600_000;
const D = 86_400_000;

describe("countLanded", () => {
  test("a point today moves today's count and its hour", () => {
    const out = countLanded(
      { events_today: 5 },
      [{ at: NOW - 10 * 60_000, n: 2 }],
      NOW,
    );
    expect(out.events_today).toBe(7);
    expect(out.hours).toEqual([
      { hour: Date.parse("2026-11-03T15:00:00Z"), events: 2 },
    ]);
    expect(out.last_event_at).toBe(NOW - 10 * 60_000);
  });

  test("a recording from last week lands on its day, not today", () => {
    const out = countLanded(
      { events_today: 0, days: [{ day: "2026-10-28", events: 1, dropped: 0 }] },
      [{ at: NOW - 6 * D, n: 3 }],
      NOW,
    );
    expect(out.events_today).toBe(0);
    expect(out.days).toEqual([{ day: "2026-10-28", events: 4, dropped: 0 }]);
    expect(out.hours).toEqual([]);
  });

  test("points past the kept days are not counted", () => {
    const out = countLanded({}, [{ at: NOW - 40 * D, n: 3 }], NOW);
    expect(out.days).toEqual([]);
    expect(out.events_today).toBe(0);
  });
});

describe("withHourCount", () => {
  test("keeps 48 hours and drops older", () => {
    const old = [{ hour: Date.parse("2026-11-01T10:00:00Z"), events: 9 }];
    expect(withHourCount(old, NOW, 1, NOW)).toEqual([
      { hour: Date.parse("2026-11-03T15:00:00Z"), events: 1 },
    ]);
  });
});

describe("mergeVolume", () => {
  test("raises days and hours to what was derived, never lowers them", () => {
    const days: Record<string, number> = {};
    const hours: Record<string, number> = {};
    addPoint(
      days,
      hours,
      NOW - 2 * D,
      recordingVolume({ started_at: 0, group_ids: ["a", "b"] }),
      NOW,
    );
    addPoint(days, hours, NOW - H, 4, NOW);
    const prev = {
      events_today: 10,
      days: [{ day: "2026-11-01", events: 1, dropped: 2 }],
      hours: [{ hour: Date.parse("2026-11-03T14:00:00Z"), events: 9 }],
    };
    const out = mergeVolume(prev, days, hours, NOW);
    expect(out.days).toEqual([{ day: "2026-11-01", events: 3, dropped: 2 }]);
    expect(out.hours).toEqual([
      { hour: Date.parse("2026-11-03T14:00:00Z"), events: 9 },
    ]);
    expect(out.events_today).toBe(10);
    // Twice is the same as once.
    expect(mergeVolume({ ...prev, ...out }, days, hours, NOW)).toEqual(out);
  });
});

describe("patchSourceStats keeps today's day equal to today's hours", () => {
  async function setup(fields?: Partial<NewRow<"event_source_stats">>) {
    const t = serverTest();
    const sourceId = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "source volume");
      const user = await rows.user();
      const workspace = `user:${user}`;
      const source_id = await db.insert("event_sources", {
        workspace,
        owner_user_id: user,
        short_id: "src-1",
        provider: "sdk",
        promote: [],
        status: "active",
        name: "Events",
        created_at: NOW,
        updated_at: NOW,
      });
      if (fields)
        await db.insert("event_source_stats", {
          source_id,
          workspace,
          ...fields,
        });
      return source_id;
    });

    return {
      patch: (update: Parameters<typeof patchSourceStats>[2], at: number) =>
        t.run(async (ctx) =>
          patchSourceStats(ctx, (await ctx.db.get(sourceId))!, update, at),
        ),
      read: () =>
        t.run(
          async ({ db }) =>
            (await db
              .query("event_source_stats")
              .withIndex("by_source", (q) => q.eq("source_id", sourceId))
              .unique())!,
        ),
    };
  }

  const todayOf = (row: Doc<"event_source_stats">, now: number) => {
    const day = new Date(now).toISOString().slice(0, 10);
    const start = Date.parse(`${day}T00:00:00Z`);
    return {
      day: (row.days ?? []).find((d) => d.day === day)?.events ?? 0,
      hours: (row.hours ?? []).reduce(
        (n, h) => (h.hour >= start ? n + h.events : n),
        0,
      ),
    };
  };

  test("batches across a day boundary", async () => {
    const { patch, read } = await setup();
    const t0 = Date.parse("2026-11-03T22:10:00Z");
    for (const [at, n] of [
      [t0, 3],
      [t0 + H, 4],
      [t0 + 2 * H, 5],
      [t0 + 3 * H, 6],
      [t0 + 3 * H + 60_000, 2],
    ] as const) {
      await patch((s) => ({ events_today: (s.events_today ?? 0) + n }), at);
      const t = todayOf(await read(), at);
      expect(t.day).toBe(t.hours);
    }
    // Nov 4 holds 5 + 6 + 2, not only the last batch.
    expect(todayOf(await read(), t0 + 3 * H).day).toBe(13);
    expect((await read()).counters_day).toBe("2026-11-04");
  });

  test("a poll that moves no count still writes the roll", async () => {
    const { patch, read } = await setup({
      counters_day: "2026-11-03",
      events_today: 40,
    });
    await patch(() => ({ last_poll_at: NOW + D }), NOW + D);
    expect((await read()).counters_day).toBe("2026-11-04");
    expect((await read()).events_today).toBe(0);
  });

  test("a row whose roll was never written heals from its hours", async () => {
    const at = Date.parse("2026-11-04T05:10:00Z");
    const hours = [
      { hour: Date.parse("2026-11-03T23:00:00Z"), events: 30 },
      { hour: Date.parse("2026-11-04T01:00:00Z"), events: 114 },
      { hour: Date.parse("2026-11-04T02:00:00Z"), events: 172 },
    ];
    const { patch, read } = await setup({
      counters_day: "2026-10-04",
      events_today: 2,
      days: [{ day: "2026-11-04", events: 2, dropped: 0 }],
      hours,
    });
    await patch((s) => ({ events_today: (s.events_today ?? 0) + 4 }), at);
    expect(todayOf(await read(), at)).toEqual({ day: 290, hours: 290 });
  });
});
