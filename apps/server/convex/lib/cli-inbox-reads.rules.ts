import { isStackedAsk } from "@codecast/inbox/inboxMembership";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";

type WatchCandidate = Pick<
  Doc<"conversations">,
  "_id" | "updated_at" | "inbox_pinned_at" | "has_pending_messages"
>;

export function orderCliWatchCandidates<T extends WatchCandidate>(
  rows: readonly T[],
  priority: (row: T) => number = (row) => Number(!!row.has_pending_messages),
): T[] {
  return [...rows].sort(
    (a, b) =>
      priority(b) - priority(a) ||
      Number(!!b.inbox_pinned_at) - Number(!!a.inbox_pinned_at) ||
      b.updated_at - a.updated_at ||
      a._id.localeCompare(b._id),
  );
}

export function canProbeCliWatchTranscript(
  row: Pick<
    Doc<"conversations">,
    | "inbox_stashed_at"
    | "inbox_dismissed_at"
    | "inbox_snoozed_until"
    | "inbox_killed_at"
    | "message_count"
  >,
  now: number,
) {
  return (
    (row.message_count ?? 0) > 0 &&
    !row.inbox_killed_at &&
    !row.inbox_stashed_at &&
    !row.inbox_dismissed_at &&
    (row.inbox_snoozed_until ?? 0) <= now
  );
}

export function cliWatchPageOrder(
  a: { work_state: string; bucket?: string },
  b: { work_state: string; bucket?: string },
) {
  const actionable = (row: typeof a) =>
    row.bucket === "questions" ||
    row.work_state === "needs_input" ||
    row.work_state === "working";
  return Number(actionable(b)) - Number(actionable(a));
}

export function readInboxChildren(
  db: DatabaseReader,
  parent: Id<"conversations">,
) {
  return db
    .query("conversations")
    .withIndex("by_parent_conversation_id", (q) =>
      q.eq("parent_conversation_id", parent),
    )
    .order("desc")
    .take(20);
}

export async function readCliFiling(
  db: DatabaseReader,
  userId: Id<"users">,
  ids?: readonly Id<"conversations">[],
) {
  const assignments = ids
    ? (
        await Promise.all(
          ids.map((id) =>
            db
              .query("bucket_assignments")
              .withIndex("by_user_conversation", (q) =>
                q.eq("user_id", userId).eq("conversation_id", id),
              )
              .collect(),
          ),
        )
      ).flat()
    : await db
        .query("bucket_assignments")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
  const allBuckets = ids
    ? (
        await Promise.all(
          [...new Set(assignments.flatMap((a) => a.bucket_id ?? []))].map(
            (id) => db.get(id),
          ),
        )
      ).filter((b): b is NonNullable<typeof b> => b?.user_id === userId)
    : await db
        .query("inbox_buckets")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
  const activeBuckets = allBuckets
    .filter((b) => !b.archived_at)
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const bucketNameById = new Map(activeBuckets.map((b) => [b._id, b.name]));
  const labelByConv = new Map<string, string>();
  for (const { bucket_id, conversation_id } of assignments) {
    const name = bucket_id && bucketNameById.get(bucket_id);
    if (name) labelByConv.set(conversation_id, name);
  }
  return { assignments, activeBuckets, labelByConv, bucketNameById };
}

const WATCH_DECISIONS_PER_SESSION = 8;
const WATCH_INBOX_DECISIONS = 1024;

const WATCH_DIRECT_DECISION_READS = 128;
const WATCH_ASSIGNED_DECISION_READS = 256;

type CliDecisionSession = Pick<Doc<"conversations">, "_id" | "started_at">;

async function readBatchedCliAsks(
  db: DatabaseReader,
  userId: Id<"users">,
  rows: readonly CliDecisionSession[],
) {
  const ids = new Set(rows.map(({ _id }) => _id));
  const since = Math.min(...rows.map(({ started_at }) => started_at));
  const [inbox, legacy] = await Promise.all([
    db
      .query("decision_inbox")
      .withIndex("by_user_status", (q) =>
        q.eq("user_id", userId).eq("status", "pending"),
      )
      .order("desc")
      .take(WATCH_ASSIGNED_DECISION_READS),
    db
      .query("session_decisions")
      .withIndex("by_user_status_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("status", "pending")
          .gte("created_at", since),
      )
      .order("desc")
      .take(WATCH_INBOX_DECISIONS),
  ]);
  const assigned = await Promise.all(
    inbox.map(({ decision_id }) => db.get(decision_id)),
  );
  const asking = new Set<string>();
  for (const row of [
    ...legacy.filter((row) => row.asked_user_ids === undefined),
    ...assigned,
  ]) {
    if (
      row &&
      ids.has(row.conversation_id) &&
      isStackedAsk(row) &&
      (row.asked_user_ids === undefined
        ? row.user_id === userId
        : row.asked_user_ids.includes(userId))
    )
      asking.add(row.conversation_id);
  }
  return asking;
}

export async function readCliAskingSessions(
  db: DatabaseReader,
  userId: Id<"users">,
  rows: readonly CliDecisionSession[],
): Promise<Set<string>> {
  const sessions = [...new Map(rows.map((row) => [row._id, row])).values()];
  if (sessions.length > WATCH_DIRECT_DECISION_READS)
    return readBatchedCliAsks(db, userId, sessions);
  const decisions = (
    await Promise.all(
      sessions.map(({ _id }) =>
        db
          .query("session_decisions")
          .withIndex("by_conversation_status", (q) =>
            q.eq("conversation_id", _id).eq("status", "pending"),
          )
          .order("desc")
          .take(WATCH_DECISIONS_PER_SESSION),
      ),
    )
  )
    .flat()
    .filter(isStackedAsk);
  const assigned = decisions.filter((row) =>
    row.asked_user_ids?.includes(userId),
  );
  const inbox = new Set(
    assigned.length
      ? (
          await db
            .query("decision_inbox")
            .withIndex("by_user_status", (q) =>
              q.eq("user_id", userId).eq("status", "pending"),
            )
            .order("desc")
            .take(WATCH_INBOX_DECISIONS)
        ).map((row) => row.decision_id)
      : [],
  );
  return new Set(
    decisions
      .filter((row) =>
        row.asked_user_ids === undefined
          ? row.user_id === userId
          : row.asked_user_ids.includes(userId) && inbox.has(row._id),
      )
      .map((row) => row.conversation_id),
  );
}
