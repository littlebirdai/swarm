import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Reader = Pick<QueryCtx, "db">;
type Writer = Pick<MutationCtx, "db">;
type ManagedHeartbeat = { _id: Id<"managed_sessions">; last_heartbeat: number };

export function heartbeatRow(ctx: Reader, id: Id<"managed_sessions">) {
  return ctx.db
    .query("session_heartbeats")
    .withIndex("by_managed_session", (q) => q.eq("managed_session_id", id))
    .first();
}

export function resolveHeartbeat(
  session: ManagedHeartbeat,
  beat: number | undefined,
): number {
  // A rollback can advance the legacy timestamp without updating the side row.
  return Math.max(beat ?? 0, session.last_heartbeat ?? 0);
}

export function hasLiveInboxLease(
  session: Pick<Doc<"managed_sessions">, "liveness_lease">,
): boolean {
  return session.liveness_lease?.expired === false;
}

function inboxHeartbeatOf(session: Doc<"managed_sessions"> | null) {
  if (!session) return 0;
  return Math.max(
    session.last_heartbeat,
    (session.liveness_lease?.end ?? 0) - HEARTBEAT_ALIVE_MS,
  );
}

export function inboxHeartbeatsFor(
  _ctx: Reader,
  sessions: Array<Doc<"managed_sessions"> | null>,
) {
  return Promise.resolve(sessions.map((row) => inboxHeartbeatOf(row)));
}

export async function inboxUserHeartbeatRows(
  ctx: Reader,
  userId: Id<"users">,
  _since?: number,
) {
  const sessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  return { sessions, beats: await inboxHeartbeatsFor(ctx, sessions) };
}

export async function indexedInboxSessionRows(
  ctx: Reader,
  userId: Id<"users">,
  now: number,
) {
  const recentWithoutLiveLease = (expired: true | undefined) =>
    ctx.db
      .query("managed_sessions")
      .withIndex("by_user_inbox_lease_heartbeat", (q) =>
        q
          .eq("user_id", userId)
          .eq("liveness_lease.expired", expired)
          .gt("last_heartbeat", now - HEARTBEAT_ALIVE_MS),
      )
      .collect();

  const [leased, legacy, recentlyExpired] = await Promise.all([
    ctx.db
      .query("managed_sessions")
      .withIndex("by_user_inbox_lease_heartbeat", (q) =>
        q.eq("user_id", userId).eq("liveness_lease.expired", false),
      )
      .collect(),
    recentWithoutLiveLease(undefined),
    recentWithoutLiveLease(true),
  ]);

  const hot = [...leased, ...legacy, ...recentlyExpired];
  const newestDaemon = hot.some((row) => row.hosted === undefined)
    ? null
    : await ctx.db
        .query("managed_sessions")
        .withIndex("by_user_daemon_heartbeat", (q) =>
          q.eq("user_id", userId).eq("hosted", undefined),
        )
        .order("desc")
        .first();
  const rows = new Map(hot.map((row) => [row._id, row]));
  const loaded = new Set<Id<"conversations">>();
  async function snapshot() {
    const sessions = [...rows.values()].sort(
      (a, b) =>
        a._creationTime - b._creationTime ||
        (a._id < b._id ? -1 : Number(a._id > b._id)),
    );
    return {
      sessions,
      beats: await inboxHeartbeatsFor(ctx, sessions),
      latestDaemonHeartbeat: newestDaemon?.last_heartbeat,
    };
  }

  async function withHistory(conversationIds: Id<"conversations">[]) {
    const missing = [...new Set(conversationIds)].filter(
      (id) => !loaded.has(id),
    );
    const historical = await Promise.all(
      missing.map((id) =>
        ctx.db
          .query("managed_sessions")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversation_id", id).eq("user_id", userId),
          )
          .order("desc")
          .take(8),
      ),
    );
    for (const id of missing) loaded.add(id);
    for (const row of historical.flat()) rows.set(row._id, row);
    return snapshot();
  }

  return { ...(await snapshot()), withHistory };
}

const WATCH_RECENT_ROWS = 2048;
const WATCH_COLD_SESSIONS = 256;

export async function readCliWatchLiveness(
  db: Reader["db"],
  userId: Id<"users">,
  parents: readonly Pick<
    Doc<"conversations">,
    "_id" | "user_id" | "updated_at" | "inbox_pinned_at"
  >[],
  children: readonly Pick<Doc<"conversations">, "_id" | "user_id">[],
  now: number,
) {
  const local = parents.filter((row) => row.user_id === userId);
  const visible = new Set(
    [...local, ...children.filter((row) => row.user_id === userId)].map(
      (row) => row._id,
    ),
  );
  const [user, recent, leased] = await Promise.all([
    db.get(userId),
    visible.size
      ? db
          .query("managed_sessions")
          .withIndex("by_user_heartbeat", (q) =>
            q
              .eq("user_id", userId)
              .gt("last_heartbeat", now - HEARTBEAT_ALIVE_MS),
          )
          .order("desc")
          .take(WATCH_RECENT_ROWS)
      : [],
    visible.size
      ? db
          .query("managed_sessions")
          .withIndex("by_user_inbox_lease_heartbeat", (q) =>
            q.eq("user_id", userId).eq("liveness_lease.expired", false),
          )
          .order("desc")
          .take(WATCH_RECENT_ROWS)
      : [],
  ]);
  const hot = [...recent, ...leased].filter(
    (row) => row.conversation_id && visible.has(row.conversation_id),
  );
  const hotIds = new Set(hot.map((row) => row.conversation_id));
  const history = await Promise.all(
    [...new Map(local.map((row) => [row._id, row])).values()]
      .filter((row) => !hotIds.has(row._id))
      .sort(
        (a, b) =>
          Number(!!b.inbox_pinned_at) - Number(!!a.inbox_pinned_at) ||
          b.updated_at - a.updated_at ||
          a._id.localeCompare(b._id),
      )
      .slice(0, WATCH_COLD_SESSIONS)
      .map((row) => row._id)
      .map((id) =>
        db
          .query("managed_sessions")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversation_id", id).eq("user_id", userId),
          )
          .order("desc")
          .take(8),
      ),
  );
  const managed = new Map(
    [...history.flat(), ...hot].map((row) => [row._id, row]),
  );
  const sessions = [...managed.values()].sort(
    (a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id),
  );
  const beats = await inboxHeartbeatsFor({ db }, sessions);
  return { sessions, beats, daemonLastSeen: user?.daemon_last_seen };
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
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversationId),
    )
    .filter((q) =>
      q.or(
        q.gt(q.field("last_heartbeat"), since),
        q.eq(q.field("liveness_lease.expired"), false),
      ),
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
