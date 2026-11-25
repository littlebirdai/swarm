import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Reader = Pick<QueryCtx, "db">;
type Writer = Pick<MutationCtx, "db">;
type ManagedHeartbeat = { _id: Id<"managed_sessions">; last_heartbeat: number };

function heartbeatRow(ctx: Reader, id: Id<"managed_sessions">) {
  return ctx.db
    .query("session_heartbeats")
    .withIndex("by_managed_session", (q) => q.eq("managed_session_id", id))
    .first();
}

function resolveHeartbeat(
  session: ManagedHeartbeat,
  beat: number | undefined,
): number {
  // A rollback can advance the legacy timestamp without updating the side row.
  return Math.max(beat ?? 0, session.last_heartbeat ?? 0);
}

export async function heartbeatOf(
  ctx: Reader,
  session: ManagedHeartbeat | null | undefined,
): Promise<number> {
  if (!session) return 0;
  const row = session._id ? await heartbeatRow(ctx, session._id) : null;
  return resolveHeartbeat(session, row?.heartbeat_at);
}

export function heartbeatsFor(
  ctx: Reader,
  sessions: ManagedHeartbeat[],
): Promise<number[]> {
  return Promise.all(sessions.map((session) => heartbeatOf(ctx, session)));
}

export function heartbeatsForUser(
  ctx: Reader,
  userId: Id<"users">,
  sessions: ManagedHeartbeat[],
): Promise<number[]> {
  return Promise.all(
    sessions.map(async (session) => {
      const rows = await ctx.db
        .query("session_heartbeats")
        .withIndex("by_managed_session", (q) =>
          q.eq("managed_session_id", session._id),
        )
        .collect();
      return rows.reduce(
        (beat, row) =>
          row.user_id === userId ? Math.max(beat, row.heartbeat_at) : beat,
        resolveHeartbeat(session, undefined),
      );
    }),
  );
}

export async function readConversationSessionHeartbeats(
  ctx: Reader,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
) {
  const rows = (
    await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversationId),
      )
      .collect()
  ).filter((row) => row.user_id === userId);
  return { rows, beats: await heartbeatsForUser(ctx, userId, rows) };
}

export async function newestDaemonSessionHeartbeat(
  ctx: Reader,
  userId: Id<"users">,
): Promise<number | undefined> {
  const legacy = await ctx.db
    .query("managed_sessions")
    .withIndex("by_daemon_beat", (q) =>
      q.eq("user_id", userId).eq("hosted", undefined),
    )
    .order("desc")
    .first();
  if (!legacy) return undefined;
  const legacyBeat = resolveHeartbeat(legacy, undefined);
  const newerSide = ctx.db
    .query("session_heartbeats")
    .withIndex("by_user_heartbeat", (q) =>
      q.eq("user_id", userId).gt("heartbeat_at", legacyBeat),
    )
    .order("desc");
  for await (const side of newerSide) {
    const session = await ctx.db.get(side.managed_session_id);
    if (session?.user_id === userId && session.hosted === undefined)
      return resolveHeartbeat(session, side.heartbeat_at);
  }
  return legacyBeat;
}

export async function readLiveSessionConversationIds(
  ctx: Reader,
  userId: Id<"users">,
  since: number,
): Promise<Id<"conversations">[]> {
  const sessions =
    since < 0
      ? await ctx.db
          .query("managed_sessions")
          .withIndex("by_user_id", (q) => q.eq("user_id", userId))
          .collect()
      : await managedSessionsBeatingSince(ctx, since, userId);
  sessions.sort(
    (a, b) =>
      a._creationTime - b._creationTime ||
      (a._id < b._id ? -1 : Number(a._id > b._id)),
  );
  const ids = new Set<Id<"conversations">>();
  for (const row of sessions)
    if (row.conversation_id) ids.add(row.conversation_id);
  return [...ids];
}

export async function writeSessionHeartbeat(
  ctx: Writer,
  id: Id<"managed_sessions">,
  userId: Id<"users">,
  at: number,
) {
  const row = await heartbeatRow(ctx, id);
  if (!row) {
    await ctx.db.insert("session_heartbeats", {
      managed_session_id: id,
      user_id: userId,
      heartbeat_at: at,
    });
  } else if (row.heartbeat_at !== at) {
    await ctx.db.patch(row._id, { heartbeat_at: at });
  }
}

export async function transferManagedSession(
  ctx: Writer,
  id: Id<"managed_sessions">,
  userId: Id<"users">,
) {
  const row = await heartbeatRow(ctx, id);
  if (row) await ctx.db.patch(row._id, { user_id: userId });
  await ctx.db.patch(id, { user_id: userId });
}

export async function deleteSessionHeartbeat(
  ctx: Writer,
  id: Id<"managed_sessions">,
) {
  const row = await heartbeatRow(ctx, id);
  if (row) await ctx.db.delete(row._id);
}

// During expand, either index can contain the freshest heartbeat.
// Keep the legacy range until migration fills in the side rows.
export async function managedSessionsBeatingSince(
  ctx: Reader,
  since: number,
  userId?: Id<"users">,
) {
  const legacy =
    userId === undefined
      ? ctx.db
          .query("managed_sessions")
          .withIndex("by_heartbeat", (q) => q.gt("last_heartbeat", since))
      : ctx.db
          .query("managed_sessions")
          .withIndex("by_user_heartbeat", (q) =>
            q.eq("user_id", userId).gt("last_heartbeat", since),
          );
  const side =
    userId === undefined
      ? ctx.db
          .query("session_heartbeats")
          .withIndex("by_heartbeat", (q) => q.gt("heartbeat_at", since))
      : ctx.db
          .query("session_heartbeats")
          .withIndex("by_user_heartbeat", (q) =>
            q.eq("user_id", userId).gt("heartbeat_at", since),
          );
  const [sessions, rows] = await Promise.all([
    legacy.collect(),
    side.collect(),
  ]);
  const beats = new Map(
    rows.map((row) => [row.managed_session_id, row.heartbeat_at]),
  );
  const legacyIds = new Set(sessions.map((session) => session._id));
  const sideOnly = await Promise.all(
    rows
      .filter((row) => !legacyIds.has(row.managed_session_id))
      .map((row) => ctx.db.get(row.managed_session_id)),
  );
  for (const session of sideOnly) {
    if (session && (userId === undefined || session.user_id === userId))
      sessions.push(session);
  }
  return sessions.sort(
    (a, b) =>
      resolveHeartbeat(a, beats.get(a._id)) -
        resolveHeartbeat(b, beats.get(b._id)) ||
      a._creationTime - b._creationTime,
  );
}

// One conversation's candidate sessions. The caller bounds
// the read (take or collect) and resolves each beat through heartbeatsFor; like
// managedSessionsBeatingSince, the legacy range is only the candidate filter.
export function conversationSessionsBeatingSince(
  ctx: Reader,
  conversationId: Id<"conversations">,
  since: number,
) {
  return ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_heartbeat", (q) =>
      q.eq("conversation_id", conversationId).gt("last_heartbeat", since),
    );
}

export async function managedHeartbeatPage(
  ctx: Reader,
  lower: number,
  cutoff: number,
  after: number | undefined,
  limit: number,
) {
  const rows = await ctx.db
    .query("managed_sessions")
    .withIndex("by_heartbeat", (q) =>
      (after === undefined
        ? q.gte("last_heartbeat", lower)
        : q.gt("last_heartbeat", after)
      ).lt("last_heartbeat", cutoff),
    )
    .take(limit);
  const beats = await heartbeatsFor(ctx, rows);
  return {
    expired: rows.filter((_, i) => beats[i] < cutoff),
    // This cursor belongs to the range index, independent of the resolved value.
    cursor:
      rows.length === limit ? rows[rows.length - 1].last_heartbeat : undefined,
  };
}
