import { v, type Infer } from "convex/values";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter, QueryCtx } from "../_generated/server";
import { hasLiveInboxLease, heartbeatsFor } from "./sessionHeartbeat";

export const stuckApplyArgs = {
  ids: v.array(v.id("pending_messages")),
  now: v.number(),
  deadRevivesRemaining: v.number(),
  allowHostedWake: v.boolean(),
  sessionCursor: v.optional(v.string()),
  liveThrough: v.optional(v.number()),
  runToken: v.optional(v.number()),
  conversationId: v.optional(v.id("conversations")),
};
export const stuckApplyPage = v.object(stuckApplyArgs);
export type ApplyStuckArgs = Infer<typeof stuckApplyPage>;

export const stuckRetryReason = v.union(
  v.literal("apply_failed"),
  v.literal("dead_revive_limit"),
  v.literal("scan_pending"),
);
export const stuckRetryUpdate = v.object({
  conversationId: v.id("conversations"),
  messageId: v.id("pending_messages"),
  reason: v.optional(stuckRetryReason),
});

export async function writeStuckRetries(
  db: DatabaseWriter,
  now: number,
  updates: Infer<typeof stuckRetryUpdate>[],
) {
  for (const { conversationId, messageId, reason } of updates) {
    const retry = await db
      .query("pending_message_sweep_retries")
      .withIndex("by_message_id", (q) => q.eq("message_id", messageId))
      .first();
    if (reason === undefined) {
      if (retry) await db.delete(retry._id);
    } else if (retry) {
      await db.patch(retry._id, { attempted_at: now, reason });
    } else {
      await db.insert("pending_message_sweep_retries", {
        message_id: messageId,
        conversation_id: conversationId,
        attempted_at: now,
        reason,
      });
    }
  }
}

export async function beginPendingSweep(
  db: DatabaseWriter,
): Promise<Doc<"pending_message_sweep_state">> {
  const state = await db.query("pending_message_sweep_state").first();
  const fields = { run_token: (state?.run_token ?? 0) + 1, dead_revived: [] };
  if (state) {
    await db.patch(state._id, fields);
    return { ...state, ...fields };
  }
  const id = await db.insert("pending_message_sweep_state", {
    cursor: null,
    ...fields,
  });
  return (await db.get(id))!;
}

export function stuckSessions(
  ctx: Pick<QueryCtx, "db">,
  conversation: Id<"conversations">,
) {
  return ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversation),
    );
}

export async function stuckSessionBeats(
  ctx: Pick<QueryCtx, "db">,
  sessions: Doc<"managed_sessions">[],
  bounded: boolean,
) {
  const beats = await heartbeatsFor(ctx, sessions);
  if (!bounded) return beats;
  return beats.map((beat, i) => {
    const session = sessions[i];
    const end = hasLiveInboxLease(session)
      ? session.liveness_lease?.end
      : undefined;
    return Math.max(beat, (end ?? 0) - HEARTBEAT_ALIVE_MS);
  });
}
