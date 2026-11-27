import type { DatabaseReader } from "../_generated/server";

export async function readInboxCheckpoint(db: DatabaseReader, scope: string) {
  const pending = await db
    .query("sync_outbox")
    .withIndex("by_scope_pending", (q) =>
      q.eq("scope_key", scope).eq("pending", true),
    )
    .first();
  if (pending) return null;
  const head = await db
    .query("sync_heads")
    .withIndex("by_scope", (q) => q.eq("scope_key", scope))
    .unique();
  return { scope, position: head?.position ?? 0 };
}
