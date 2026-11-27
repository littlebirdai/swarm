import { isStackedAsk } from "@codecast/inbox/inboxMembership";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";

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

export async function readCliAskingSessions(
  db: DatabaseReader,
  userId: Id<"users">,
  rows: readonly { _id: Id<"conversations"> }[],
): Promise<Set<string>> {
  const decisions = (
    await Promise.all(
      rows.map(({ _id }) =>
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
