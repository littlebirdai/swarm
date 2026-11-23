import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Reader = Pick<QueryCtx, "db">;
type Writer = Pick<MutationCtx, "db">;
type ManagedHeartbeat = { _id: Id<"managed_sessions">; last_heartbeat: number };

function heartbeatRow(ctx: Reader, id: Id<"managed_sessions">) {
  return ctx.db.query("session_heartbeats")
    .withIndex("by_managed_session", (q) => q.eq("managed_session_id", id))
    .first();
}

function resolveHeartbeat(session: ManagedHeartbeat, beat: number | undefined): number {
  // Expand: pre-existing sessions can lack a side row until they report again.
  return beat ?? session.last_heartbeat ?? 0;
}

export async function heartbeatOf(ctx: Reader, session: ManagedHeartbeat | null | undefined): Promise<number> {
  if (!session) return 0;
  const row = session._id ? await heartbeatRow(ctx, session._id) : null;
  return resolveHeartbeat(session, row?.heartbeat_at);
}

export function heartbeatsFor(ctx: Reader, sessions: ManagedHeartbeat[]): Promise<number[]> {
  return Promise.all(sessions.map((session) => heartbeatOf(ctx, session)));
}

// A whole-user projection already reads the user's full registry. Fetch its
// matching side rows in one indexed read to stay within the inbox call budget.
export async function heartbeatsForUser(ctx: Reader, userId: Id<"users">, sessions: ManagedHeartbeat[]): Promise<number[]> {
  if (sessions.length === 0) return [];
  const rows = await ctx.db.query("session_heartbeats")
    .withIndex("by_user_heartbeat", (q) => q.eq("user_id", userId))
    .collect();
  const beats = new Map(rows.map((row) => [row.managed_session_id, row.heartbeat_at]));
  return sessions.map((session) => resolveHeartbeat(session, beats.get(session._id)));
}

export async function writeSessionHeartbeat(ctx: Writer, id: Id<"managed_sessions">, userId: Id<"users">, at: number) {
  const row = await heartbeatRow(ctx, id);
  if (!row) {
    await ctx.db.insert("session_heartbeats", { managed_session_id: id, user_id: userId, heartbeat_at: at });
  } else if (row.heartbeat_at !== at) {
    await ctx.db.patch(row._id, { heartbeat_at: at });
  }
}

export async function transferManagedSession(ctx: Writer, id: Id<"managed_sessions">, userId: Id<"users">) {
  const row = await heartbeatRow(ctx, id);
  if (row) await ctx.db.patch(row._id, { user_id: userId });
  await ctx.db.patch(id, { user_id: userId });
}

export async function deleteManagedSession(ctx: Writer, id: Id<"managed_sessions">) {
  const row = await heartbeatRow(ctx, id);
  if (row) await ctx.db.delete(row._id);
  await ctx.db.delete(id);
}

// The legacy range supplies candidates during expand. Its timestamps match
// the side rows because all writers update both in one transaction. Keep this
// range until migration fills in the side rows for older sessions.
export async function managedSessionsBeatingSince(ctx: Reader, since: number, userId?: Id<"users">) {
  const legacy = userId === undefined
    ? ctx.db.query("managed_sessions").withIndex("by_heartbeat", (q) => q.gt("last_heartbeat", since))
    : ctx.db.query("managed_sessions").withIndex("by_user_heartbeat", (q) => q.eq("user_id", userId).gt("last_heartbeat", since));
  const side = userId === undefined
    ? ctx.db.query("session_heartbeats").withIndex("by_heartbeat", (q) => q.gt("heartbeat_at", since))
    : ctx.db.query("session_heartbeats").withIndex("by_user_heartbeat", (q) => q.eq("user_id", userId).gt("heartbeat_at", since));
  const [sessions, rows] = await Promise.all([legacy.collect(), side.collect()]);
  const liveIds = new Set(rows.map((row) => row.managed_session_id));
  const live = await Promise.all(sessions.map(async (session) =>
    liveIds.has(session._id) || (await heartbeatOf(ctx, session)) > since
  ));
  return sessions.filter((_, i) => live[i]);
}

// One conversation's candidate sessions. The caller bounds
// the read (take or collect) and resolves each beat through heartbeatsFor; like
// managedSessionsBeatingSince, the legacy range is only the candidate filter.
export function conversationSessionsBeatingSince(ctx: Reader, conversationId: Id<"conversations">, since: number) {
  return ctx.db.query("managed_sessions")
    .withIndex("by_conversation_heartbeat", (q) => q.eq("conversation_id", conversationId).gt("last_heartbeat", since));
}

export async function managedHeartbeatPage(ctx: Reader, lower: number, cutoff: number, after: number | undefined, limit: number) {
  const rows = await ctx.db.query("managed_sessions").withIndex("by_heartbeat", (q) => (
    after === undefined ? q.gte("last_heartbeat", lower) : q.gt("last_heartbeat", after)
  ).lt("last_heartbeat", cutoff)).take(limit);
  const beats = await heartbeatsFor(ctx, rows);
  return {
    expired: rows.filter((_, i) => beats[i] < cutoff),
    // This cursor belongs to the range index, independent of the resolved value.
    cursor: rows.length === limit ? rows[rows.length - 1].last_heartbeat : undefined,
  };
}
