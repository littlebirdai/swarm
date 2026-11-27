import type { DatabaseReader } from "../_generated/server";

export async function readInboxCheckpoint(db: DatabaseReader, scope: string) {
  const head = await db
    .query("sync_heads")
    .withIndex("by_scope", (q) => q.eq("scope_key", scope))
    .unique();
  return { scope, position: head?.position ?? 0 };
}
