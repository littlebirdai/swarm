import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { verifyApiToken } from "../apiTokens";
import { canAccessTask } from "./access";
import { clearClaim, findClaim } from "./claims";
import { assertTaskMutationClaim } from "./taskClaims";
import { recordTaskChange } from "./taskHistory";
import { patchTask } from "./taskWrite";

type DbCtx = Pick<MutationCtx, "db"> & { scheduler?: MutationCtx["scheduler"] };

export async function requireAccessibleTaskByToken(
  ctx: MutationCtx,
  apiToken: string,
  shortId: string,
) {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth) throw new Error("Unauthorized");
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_short_id", (q) => q.eq("short_id", shortId))
    .first();
  if (!task || !(await canAccessTask(ctx, auth.userId, task)))
    throw new Error("Task not found");
  return { auth, task };
}

export async function requireClaimedTaskMutation(
  ctx: MutationCtx,
  args: {
    api_token: string;
    short_id: string;
    claim_token?: number;
    conversation_id?: string;
  },
  releaseOnPass?: (
    task: Doc<"tasks">,
    claimConvId?: Id<"conversations">,
  ) => Promise<void>,
) {
  const { auth, task } = await requireAccessibleTaskByToken(
    ctx,
    args.api_token,
    args.short_id,
  );
  const now = Date.now();
  await assertTaskMutationClaim(
    ctx,
    task,
    auth.userId,
    args,
    now,
    releaseOnPass
      ? (claimConvId) => releaseOnPass(task, claimConvId)
      : undefined,
  );
  return { auth, task, now };
}

export async function releaseTaskClaimIfHeld(
  ctx: DbCtx,
  taskId: Id<"tasks">,
): Promise<Id<"conversations"> | undefined> {
  const row = await findClaim(ctx.db, { kind: "task", id: taskId });
  const convId = row?.task?.conversation_id;
  if (row && row.holder !== undefined) await clearClaim(ctx, row);
  return convId;
}

async function unbindTaskConversations(
  ctx: DbCtx,
  taskId: Id<"tasks">,
  convIds: Iterable<string>,
  skipConvId?: Id<"conversations">,
): Promise<void> {
  for (const id of new Set(convIds)) {
    if (skipConvId && id === String(skipConvId)) continue;
    const conv = await ctx.db.get(id as Id<"conversations">);
    if (!conv || String(conv.active_task_id ?? "") !== String(taskId)) {
      continue;
    }
    await ctx.db.patch(conv._id, { active_task_id: undefined });
    await ctx.scheduler?.runAfter(0, internal.sessionOwnership.reconcileHold, {
      conversation_id: conv._id,
    });
  }
}

async function reopenTaskIfInProgress(
  ctx: DbCtx,
  taskId: Id<"tasks">,
  opts: {
    conversationId?: Id<"conversations">;
    keepConversationId?: Id<"conversations">;
    now?: number;
  } = {},
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task) {
    if (opts.conversationId) {
      await unbindTaskConversations(
        ctx,
        taskId,
        [String(opts.conversationId)],
        opts.keepConversationId,
      );
    }
    return;
  }
  await unbindTaskConversations(
    ctx,
    task._id,
    [
      ...(task.conversation_ids ?? []).map(String),
      ...(opts.conversationId ? [String(opts.conversationId)] : []),
    ],
    opts.keepConversationId,
  );
  if (task.status === "in_progress") {
    const now = opts.now ?? Date.now();
    await recordTaskChange(
      ctx,
      task._id,
      {
        user_id: task.user_id,
        actor_type: "system",
        ...(opts.conversationId
          ? { conversation_id: opts.conversationId }
          : {}),
      },
      [["status", "in_progress", "open"]],
      now,
    );
    await patchTask(ctx, task, {
      status: "open",
      status_id: undefined,
      updated_at: now,
    });
  }
}

export async function releaseClearedTaskClaim(
  ctx: DbCtx,
  claimRow: Doc<"claims">,
  opts: { now?: number } = {},
): Promise<void> {
  const wasHeld = claimRow.holder !== undefined;
  const convId = claimRow.task?.conversation_id;
  const taskId = claimRow.task_id;
  await clearClaim(ctx, claimRow);
  if (wasHeld && taskId) {
    await reopenTaskIfInProgress(ctx, taskId, {
      conversationId: convId,
      now: opts.now,
    });
  }
}

export async function releaseSessionTaskClaim(
  ctx: DbCtx,
  conv:
    | Pick<Doc<"conversations">, "_id" | "active_task_id" | "user_id">
    | null
    | undefined,
  expectedHolder?: Id<"users">,
  opts: { skipUnbindConv?: boolean; now?: number } = {},
): Promise<void> {
  if (!conv?.active_task_id) return;
  const row = await findClaim(ctx.db, {
    kind: "task",
    id: conv.active_task_id,
  });
  const matchesHolder =
    !expectedHolder || String(row?.holder ?? "") === String(expectedHolder);
  if (
    row &&
    row.holder !== undefined &&
    matchesHolder &&
    row.task?.conversation_id === conv._id
  ) {
    await clearClaim(ctx, row);
    await reopenTaskIfInProgress(ctx, conv.active_task_id, {
      conversationId: conv._id,
      keepConversationId: opts.skipUnbindConv ? conv._id : undefined,
      now: opts.now,
    });
  }
}
