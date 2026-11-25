import type { Doc, Id } from "../_generated/dataModel";
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
      let latest: number | undefined;
      for (const row of rows) {
        if (row.user_id === userId)
          latest = Math.max(latest ?? -Infinity, row.heartbeat_at);
      }
      return resolveHeartbeat(session, latest);
    }),
  );
}

const HISTORY_PROBE = 32;

async function readSessionWindow<Row>(
  newest: () => Promise<Row[]>,
  live: () => Promise<Row[]>,
  stale: () => Promise<Row[]>,
  stamp: (row: Row) => number,
  since: number,
) {
  if (since < 0) return { rows: await live(), unseen: -Infinity };
  const prefix = await newest();
  if (prefix.length <= HISTORY_PROBE)
    return { rows: prefix, unseen: -Infinity };
  if (stamp(prefix[prefix.length - 1]) <= since)
    return { rows: prefix, unseen: stamp(prefix[prefix.length - 1]) };
  const [current, history] = await Promise.all([live(), stale()]);
  return {
    rows: [...current, ...history],
    unseen:
      history.length <= HISTORY_PROBE
        ? -Infinity
        : stamp(history[history.length - 1]),
  };
}

async function newestDaemonSessionHeartbeat(
  ctx: Reader,
  userId: Id<"users">,
  known: number | undefined,
  unknownSide: number,
  unknownLegacy: number,
): Promise<number | undefined> {
  if (Math.max(unknownSide, unknownLegacy) <= (known ?? -Infinity))
    return known;
  const daemonRows = () =>
    ctx.db
      .query("managed_sessions")
      .withIndex("by_daemon_beat", (q) =>
        q.eq("user_id", userId).eq("hosted", undefined),
      )
      .order("desc");
  const legacy = await daemonRows().first();
  if (!legacy) return known;
  const indexed = await ctx.db
    .query("session_heartbeats")
    .withIndex("by_user_daemon_heartbeat", (q) =>
      q.eq("user_id", userId).eq("daemon", true),
    )
    .order("desc")
    .first();
  let latest = Math.max(
    known ?? -Infinity,
    legacy.last_heartbeat ?? 0,
    indexed?.heartbeat_at ?? -Infinity,
  );
  if (latest >= 0) {
    if (latest >= unknownSide) return latest;
    const unknown = await ctx.db
      .query("session_heartbeats")
      .withIndex("by_user_daemon_heartbeat", (q) =>
        q
          .eq("user_id", userId)
          .eq("daemon", undefined)
          .gt("heartbeat_at", latest)
          .lte("heartbeat_at", unknownSide),
      )
      .order("desc")
      .take(HISTORY_PROBE + 1);
    if (unknown.length <= HISTORY_PROBE) {
      for (const row of unknown) {
        const session = await ctx.db.get(row.managed_session_id);
        if (session?.user_id === userId && session.hosted === undefined)
          return Math.max(latest, row.heartbeat_at);
      }
      return latest;
    }
  }
  for await (const session of daemonRows()) {
    latest = Math.max(
      latest,
      ...(await heartbeatsForUser(ctx, userId, [session])),
    );
    if (latest >= Math.max(0, unknownSide)) break;
  }
  return latest;
}

export async function readUserSessionFacts(
  ctx: Reader,
  userId: Id<"users">,
  since: number,
) {
  const legacy = () => ctx.db.query("managed_sessions");
  const side = () => ctx.db.query("session_heartbeats");
  const [managed, sideRows] = await Promise.all([
    readSessionWindow(
      () =>
        legacy()
          .withIndex("by_user_heartbeat", (q) => q.eq("user_id", userId))
          .order("desc")
          .take(HISTORY_PROBE + 1),
      () =>
        legacy()
          .withIndex("by_user_heartbeat", (q) => {
            const user = q.eq("user_id", userId);
            return since < 0 ? user : user.gt("last_heartbeat", since);
          })
          .collect(),
      () =>
        legacy()
          .withIndex("by_user_heartbeat", (q) =>
            q.eq("user_id", userId).lte("last_heartbeat", since),
          )
          .order("desc")
          .take(HISTORY_PROBE + 1),
      (row) =>
        since < 0 ? Math.max(0, row.last_heartbeat) : (row.last_heartbeat ?? 0),
      since,
    ),
    readSessionWindow(
      () =>
        side()
          .withIndex("by_user_heartbeat", (q) => q.eq("user_id", userId))
          .order("desc")
          .take(HISTORY_PROBE + 1),
      () =>
        side()
          .withIndex("by_user_heartbeat", (q) => {
            const user = q.eq("user_id", userId);
            return since < 0 ? user : user.gt("heartbeat_at", since);
          })
          .collect(),
      () =>
        side()
          .withIndex("by_user_heartbeat", (q) =>
            q.eq("user_id", userId).lte("heartbeat_at", since),
          )
          .order("desc")
          .take(HISTORY_PROBE + 1),
      (row) => row.heartbeat_at,
      since,
    ),
  ]);
  const byId = new Map(managed.rows.map((row) => [row._id, row]));
  const beatsById = new Map<Id<"managed_sessions">, number>();
  const sideOnly = new Set<Id<"managed_sessions">>();
  for (const row of sideRows.rows) {
    beatsById.set(
      row.managed_session_id,
      Math.max(
        beatsById.get(row.managed_session_id) ?? -Infinity,
        row.heartbeat_at,
      ),
    );
    if (managed.unseen !== -Infinity && !byId.has(row.managed_session_id))
      sideOnly.add(row.managed_session_id);
  }
  for (const row of await Promise.all(
    [...sideOnly].map((id) => ctx.db.get(id)),
  ))
    if (row?.user_id === userId) byId.set(row._id, row);

  const order = (a: Doc<"managed_sessions">, b: Doc<"managed_sessions">) =>
    a._creationTime - b._creationTime ||
    (a._id < b._id ? -1 : Number(a._id > b._id));
  const mayBeMissingNegativeBeat = (row: ManagedHeartbeat) =>
    row.last_heartbeat < 0 &&
    sideRows.unseen !== -Infinity &&
    !beatsById.has(row._id);
  const beatOf = (row: ManagedHeartbeat) =>
    mayBeMissingNegativeBeat(row)
      ? row.last_heartbeat
      : resolveHeartbeat(row, beatsById.get(row._id));
  const rows = [...byId.values()].sort(order);
  const byConversation = new Map<
    Id<"conversations">,
    Doc<"managed_sessions">[]
  >();
  let latest: number | undefined;
  for (const row of rows) {
    const beat = beatOf(row);
    if (row.hosted === undefined) latest = Math.max(latest ?? -Infinity, beat);
    if (!row.conversation_id) continue;
    const current = byConversation.get(row.conversation_id);
    if (current) current.push(row);
    else byConversation.set(row.conversation_id, [row]);
  }

  const maximumUnseenLegacy =
    managed.unseen === -Infinity ? -Infinity : Math.max(0, managed.unseen);
  const maximumUnseenSide = rows.some(mayBeMissingNegativeBeat)
    ? Math.max(0, sideRows.unseen)
    : sideRows.unseen;
  const newest = await newestDaemonSessionHeartbeat(
    ctx,
    userId,
    latest,
    maximumUnseenSide,
    maximumUnseenLegacy,
  );
  const pending = new Map<Id<"conversations">, Promise<void>>();
  const load = async (
    id: Id<"conversations">,
    apply: (rows: Doc<"managed_sessions">[], beats: number[]) => void,
  ) => {
    const current = byConversation.get(id) ?? [];
    const history =
      managed.unseen === -Infinity
        ? []
        : (
            await ctx.db
              .query("managed_sessions")
              .withIndex("by_conversation_heartbeat", (q) =>
                q
                  .eq("conversation_id", id)
                  .lte("last_heartbeat", managed.unseen),
              )
              .collect()
          ).filter((row) => row.user_id === userId && !byId.has(row._id));
    const candidates = [...current, ...history].sort(order);
    const beats = await Promise.all(
      candidates.map(async (row) => {
        const known = beatOf(row);
        if (known >= sideRows.unseen && !mayBeMissingNegativeBeat(row))
          return known;
        return (await heartbeatsForUser(ctx, userId, [row]))[0];
      }),
    );
    apply(candidates, beats);
  };
  return {
    rows,
    beats: rows.map(beatOf),
    newest,
    async loadConversations(
      convs: readonly { _id: Id<"conversations"> }[],
      apply: (rows: Doc<"managed_sessions">[], beats: number[]) => void,
    ) {
      if (managed.unseen === -Infinity && sideRows.unseen === -Infinity) return;
      await Promise.all(
        convs.map(({ _id }) => {
          if (!pending.has(_id)) pending.set(_id, load(_id, apply));
          return pending.get(_id);
        }),
      );
    },
  };
}

export async function writeSessionHeartbeat(
  ctx: Writer,
  id: Id<"managed_sessions">,
  userId: Id<"users">,
  at: number,
  hosted: boolean | undefined,
) {
  const daemon = hosted === undefined;
  const row = await heartbeatRow(ctx, id);
  if (!row) {
    await ctx.db.insert("session_heartbeats", {
      managed_session_id: id,
      user_id: userId,
      heartbeat_at: at,
      daemon,
    });
  } else if (row.heartbeat_at !== at || row.daemon !== daemon) {
    await ctx.db.patch(row._id, { heartbeat_at: at, daemon });
  }
}

export function writePatchedSessionHeartbeat(
  ctx: Writer,
  session: Doc<"managed_sessions">,
  patch: { last_heartbeat?: number } | null,
) {
  return writeSessionHeartbeat(
    ctx,
    session._id,
    session.user_id,
    patch?.last_heartbeat ?? session.last_heartbeat,
    session.hosted,
  );
}

export async function markManagedSessionHosted(
  ctx: Writer,
  id: Id<"managed_sessions">,
) {
  const row = await heartbeatRow(ctx, id);
  if (row) await ctx.db.patch(row._id, { daemon: false });
  await ctx.db.patch(id, { hosted: true });
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
