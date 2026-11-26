import { getConvexSize, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const relinkBytes = 512 * 1024;
const statuses = [
  "pending",
  "held",
  "injected",
  "failed",
  "undeliverable",
] as const;

type PendingRow = Doc<"pending_messages">;
type RelinkCtx = {
  db: MutationCtx["db"];
  scheduler?: MutationCtx["scheduler"];
};

export function pendingQueueRelinkBudget() {
  return { rows: 256, bytes: relinkBytes };
}

function relinkKey(conversationId: Id<"conversations">) {
  return `pending_queue_relink:${conversationId}`;
}

export function pendingQueueRelinkOf(
  db: QueryCtx["db"],
  conversationId: Id<"conversations">,
) {
  return db
    .query("system_config")
    .withIndex("by_key", (q) => q.eq("key", relinkKey(conversationId)))
    .first();
}

async function relinkRows(
  db: MutationCtx["db"],
  rows: PendingRow[],
  runnerId: Id<"users">,
) {
  for (const row of rows) {
    if (row.owner_user_id !== runnerId)
      await db.patch(row._id, { owner_user_id: runnerId });
  }
}

export async function relinkPendingQueue(
  ctx: RelinkCtx,
  conversationId: Id<"conversations">,
  runnerId: Id<"users">,
  budget: ReturnType<typeof pendingQueueRelinkBudget>,
) {
  const previous = await pendingQueueRelinkOf(ctx.db, conversationId);
  if (previous) await ctx.db.delete(previous._id);
  const rows: PendingRow[] = [];
  let deferred = budget.rows <= 0 || budget.bytes <= 0;
  if (!deferred) {
    scan: for (const status of statuses) {
      const pending = ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", conversationId).eq("status", status),
        );
      for await (const row of pending) {
        budget.rows--;
        budget.bytes -= getConvexSize(row);
        if (budget.rows < 0 || budget.bytes < 0) {
          deferred = true;
          break scan;
        }
        rows.push(row);
      }
    }
  }
  if (!deferred) {
    await relinkRows(ctx.db, rows, runnerId);
    return;
  }
  if (!ctx.scheduler) throw new Error("Queue relink requires a scheduler");
  const jobId = await ctx.db.insert("system_config", {
    key: relinkKey(conversationId),
    value: "",
    updated_at: Date.now(),
    updated_by: runnerId,
  });
  await ctx.scheduler.runAfter(0, internal.devices.continueClaimQueueRelink, {
    conversationId,
    jobId,
    cursor: null,
  });
}

export const claimQueueRelinkContinuation = {
  args: {
    conversationId: v.id("conversations"),
    jobId: v.id("system_config"),
    cursor: v.union(v.string(), v.null()),
  },
  async handler(
    ctx: MutationCtx,
    {
      conversationId,
      jobId,
      cursor,
    }: {
      conversationId: Id<"conversations">;
      jobId: Id<"system_config">;
      cursor: string | null;
    },
  ): Promise<void> {
    const job = await ctx.db.get(jobId);
    if (job?.key !== relinkKey(conversationId) || job.value !== (cursor ?? ""))
      return;
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || conversation.user_id !== job.updated_by) {
      await ctx.db.delete(jobId);
      return;
    }
    const { page, isDone, continueCursor } = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) =>
        q
          .eq("conversation_id", conversationId)
          .lte("_creationTime", job._creationTime),
      )
      .paginate({ cursor, numItems: 1000, maximumBytesRead: relinkBytes });
    await relinkRows(
      ctx.db,
      page.filter(
        (row) => row.status !== "delivered" && row.status !== "cancelled",
      ),
      conversation.user_id,
    );
    if (isDone) {
      await ctx.db.delete(jobId);
    } else {
      await ctx.db.patch(jobId, { value: continueCursor });
      await ctx.scheduler.runAfter(
        0,
        internal.devices.continueClaimQueueRelink,
        {
          conversationId,
          jobId,
          cursor: continueCursor,
        },
      );
    }
  },
};
