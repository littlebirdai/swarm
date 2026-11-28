import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { computeInboxSessions, splitInboxList } from "./inboxCompute";
import { query } from "../functions";
import type { DatabaseReader } from "../_generated/server";

async function readInboxCheckpoint(db: DatabaseReader, scope: string) {
  const head = await db
    .query("sync_heads")
    .withIndex("by_scope", (q) => q.eq("scope_key", scope))
    .unique();
  return { scope, position: head?.position ?? 0 };
}

export function defineInboxSessionsQuery(
  computeSessions: typeof computeInboxSessions,
  splitSessions: typeof splitInboxList,
) {
  return query({
    args: {
      show_all: v.optional(v.boolean()),
      // Live subscription opts out of heartbeat-derived liveness (it rides the
      // separate `sessionsLiveness` overlay) so heartbeats stop re-pushing the whole
      // inbox. Defaults to true so older / un-redeployed clients that read liveness
      // straight off this query keep working unchanged.
      include_liveness: v.optional(v.boolean()),
      // Opt-in: omit message_count/updated_at from rows (they ride sessionsLiveness).
      fast_fields_in_overlay: v.optional(v.boolean()),
      // Ignored cache-buster: lets the recovery poll force a real round-trip
      // instead of being served the live subscription's stalled cache. See the
      // matching `_probe` arg on users.getCurrentUser.
      _probe: v.optional(v.number()),
      // The split wire form (packages/inbox/src/inboxSplit.ts): the live subscription
      // asks for it, so a change re-sends the recent rows and a hash, not the
      // whole working set. One-shot fetches leave it off and get every row.
      split: v.optional(v.boolean()),
      checkpoint: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
      const userId = await getAuthUserId(ctx);
      if (!userId)
        return args.split
          ? splitSessions({ sessions: [], hidden_count: 0, truncated: [] })
          : { sessions: [], hidden_count: 0, truncated: [] };
      const checkpoint =
        args.checkpoint && !args.split
          ? await readInboxCheckpoint(ctx.db, `user:${userId}`)
          : undefined;
      const result = await computeSessions(ctx, userId, {
        show_all: args.show_all,
        includeLiveness: args.include_liveness,
        fastFieldsInOverlay: args.fast_fields_in_overlay,
        splitHot: args.split,
      });
      if (checkpoint) return { ...result, checkpoint };
      return args.split ? splitSessions(result) : result;
    },
  });
}
