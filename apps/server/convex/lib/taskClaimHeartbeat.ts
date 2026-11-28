import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveSessionConversation } from "./access";
import { findClaim, TASK_LEASE_MS } from "./claims";
import {
  assertTaskWriteWithoutToken,
  releaseTaskClaim,
  renewTaskClaimRow,
  resolveTaskUpdateConversation,
  taskClaimError,
  throwRefusal,
} from "./taskClaims";

type ReadDbCtx = Pick<QueryCtx | MutationCtx, "db">;
type DbCtx = Pick<MutationCtx, "db"> & { scheduler?: MutationCtx["scheduler"] };

export async function resolveOwnedClaimConversation(
  ctx: ReadDbCtx,
  holder: Id<"users">,
  rawConversationId?: string,
): Promise<Doc<"conversations"> | null> {
  if (!rawConversationId) return null;
  const conv = await resolveSessionConversation(ctx, holder, rawConversationId);
  if (!conv) {
    throw taskClaimError("wrong_holder", 0, "Conversation not found");
  }
  if (String(conv.user_id) !== String(holder)) {
    throw taskClaimError(
      "wrong_holder",
      0,
      "Conversation belongs to another user",
    );
  }
  return conv;
}

async function resolveClaimConversationId(
  ctx: DbCtx,
  userId: Id<"users">,
  rawConversationId?: string,
): Promise<Id<"conversations"> | undefined> {
  return (await resolveOwnedClaimConversation(ctx, userId, rawConversationId))
    ?._id;
}

export async function renewTaskHeartbeat(
  ctx: DbCtx,
  input: {
    task: Doc<"tasks">;
    holder: Id<"users">;
    claimToken?: number;
    conversationRef?: string;
    writeHeartbeat: () => Promise<void>;
  },
): Promise<{
  success: true;
  claim_token?: number;
  lease_until?: number;
  remaining_ms?: number;
}> {
  const now = Date.now();
  const { conv, unresolved } = await resolveTaskUpdateConversation(
    ctx,
    input.holder,
    input.conversationRef,
  );
  const conversationId = conv?._id;
  const row = await findClaim(ctx.db, { kind: "task", id: input.task._id });
  let token = input.claimToken;
  if (token === undefined) {
    await assertTaskWriteWithoutToken(
      ctx,
      {
        task: input.task,
        holder: input.holder,
        conversationId,
        unresolvedConversation: unresolved,
        now,
      },
      row,
    );
    if (!row || row.holder === undefined) {
      await input.writeHeartbeat();
      return { success: true };
    }
    token = row.token;
  } else if (unresolved) {
    await throwRefusal(
      ctx.db,
      input.task._id,
      "wrong_holder",
      input.task.short_id,
    );
  }
  const renewed = await renewTaskClaimRow(ctx, row, {
    taskId: input.task._id,
    shortId: input.task.short_id,
    holder: input.holder,
    token,
    conversationId,
    now,
  });
  await input.writeHeartbeat();
  return {
    success: true,
    claim_token: renewed.token,
    lease_until: renewed.leaseUntil,
    remaining_ms: renewed.remainingMs,
  };
}

export async function renewLiveConversationTaskClaim(
  ctx: DbCtx,
  holder: Id<"users">,
  conversationId: Id<"conversations">,
  activeTaskId: Id<"tasks">,
  now: number,
): Promise<void> {
  const row = await findClaim(ctx.db, {
    kind: "task",
    id: activeTaskId,
  });
  if (
    !row ||
    row.holder === undefined ||
    String(row.holder) !== String(holder) ||
    row.task?.conversation_id !== conversationId ||
    row.lease_until <= now ||
    row.lease_until - now > TASK_LEASE_MS / 2
  ) {
    return;
  }
  await renewTaskClaimRow(ctx, row, {
    taskId: activeTaskId,
    holder,
    token: row.token,
    conversationId,
    now,
  });
}

export async function releaseTaskWithClaim(
  ctx: DbCtx,
  input: {
    task: Doc<"tasks">;
    holder: Id<"users">;
    claimToken: number;
    conversationRef?: string;
    releaseBound: (conversationId?: Id<"conversations">) => Promise<unknown>;
    reopen: (conversationId?: Id<"conversations">) => Promise<unknown>;
  },
): Promise<{ success: true; token: number }> {
  const conversationId = await resolveClaimConversationId(
    ctx,
    input.holder,
    input.conversationRef,
  );
  const res = await releaseTaskClaim(ctx, {
    taskId: input.task._id,
    shortId: input.task.short_id,
    holder: input.holder,
    token: input.claimToken,
    conversationId,
  });
  await input.releaseBound(conversationId);
  if (input.task.status === "in_progress") await input.reopen(conversationId);
  return { success: true, token: res.token };
}
