import { v, type Infer } from "convex/values";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";

export const cronSweepName = v.union(
  v.literal("activity"),
  v.literal("health"),
  v.literal("reclaim"),
);
export type CronSweepName = Infer<typeof cronSweepName>;
export const activitySweepPhase = v.union(
  v.literal("seen"),
  v.literal("tail"),
  v.literal("created"),
);

export const cronSweepPage = v.union(
  v.object({
    job: v.literal("activity"),
    token: v.number(),
    startedAt: v.number(),
    cursor: v.optional(v.string()),
    days: v.number(),
    phase: activitySweepPhase,
    tailEnd: v.optional(v.number()),
    tailPagesRemaining: v.optional(v.number()),
  }),
  v.object({
    job: v.literal("health"),
    token: v.number(),
    startedAt: v.number(),
    cursor: v.string(),
  }),
  v.object({
    job: v.literal("reclaim"),
    token: v.number(),
    startedAt: v.number(),
    cursor: v.string(),
  }),
);

export function cronSweepRow(db: DatabaseReader, key: string) {
  return db
    .query("system_config")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

export async function cronSweepToken(
  db: DatabaseWriter,
  job: CronSweepName,
  token?: number,
): Promise<number | null> {
  const key = `cron_sweep:${job}`;
  const row = await cronSweepRow(db, key);
  const current = Number(row?.value ?? 0);
  if (token !== undefined) return current === token ? token : null;
  const next = current + 1;
  const fields = { value: String(next), updated_at: Date.now() };
  if (row) await db.patch(row._id, fields);
  else await db.insert("system_config", { key, ...fields });
  return next;
}

export async function isCurrentCronSweep(
  db: DatabaseReader,
  job: CronSweepName,
  token: number,
) {
  const row = await cronSweepRow(db, `cron_sweep:${job}`);
  return row?.value === String(token);
}
