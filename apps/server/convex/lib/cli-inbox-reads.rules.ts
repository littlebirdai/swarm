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

export async function readCliAskingSessions(
  db: DatabaseReader,
  userId: Id<"users">,
  parents: readonly { _id: Id<"conversations"> }[],
  children: ReadonlyMap<string, readonly { _id: Id<"conversations"> }[]>,
): Promise<Set<string>> {
  const ids = new Set(
    [...parents, ...[...children.values()].flat()].map((row) => row._id),
  );
  const asking = await Promise.all(
    [...ids].map(async (id) => {
      const decisions = db
        .query("session_decisions")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", id).eq("status", "pending"),
        );
      for await (const decision of decisions) {
        if (!isStackedAsk(decision)) continue;
        if (!decision.asked_user_ids && decision.user_id === userId) return id;
        if (
          decision.asked_user_ids &&
          !decision.asked_user_ids.includes(userId)
        )
          continue;
        const inbox = await db
          .query("decision_inbox")
          .withIndex("by_decision", (q) => q.eq("decision_id", decision._id))
          .filter((q) =>
            q.and(
              q.eq(q.field("user_id"), userId),
              q.eq(q.field("status"), "pending"),
            ),
          )
          .first();
        if (inbox) return id;
      }
      return null;
    }),
  );
  return new Set(asking.filter((id) => id !== null));
}
