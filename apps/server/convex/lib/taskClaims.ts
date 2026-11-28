import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveSessionConversation } from "./access";
import {
  claim,
  findClaim,
  readClaimToken,
  release,
  renew,
  revoke,
  TASK_LEASE_MS,
  withHeldClaim,
} from "./claims";
import {
  releaseClearedTaskClaim,
  releaseSessionTaskClaim,
  releaseTaskClaimIfHeld,
} from "./taskClaimLifecycle";

export {
  releaseClearedTaskClaim,
  releaseSessionTaskClaim,
  releaseTaskClaimIfHeld,
};

export const claimRefArgs = {
  claim_token: v.optional(v.number()),
  conversation_id: v.optional(v.string()),
};

export type TaskClaimRefusalReason =
  | "free"
  | "stale_token"
  | "wrong_holder"
  | "expired"
  | "busy"
  | "token_exhausted"
  | "invalid_request";

type ReadDbCtx = Pick<QueryCtx | MutationCtx, "db">;
type DbCtx = Pick<MutationCtx, "db"> & { scheduler?: MutationCtx["scheduler"] };

export function taskClaimError(
  reason: TaskClaimRefusalReason,
  currentToken: number,
  message: string,
  remainingMs?: number,
): ConvexError<{
  code: "CONFLICT";
  reason: TaskClaimRefusalReason;
  current_token: number;
  remaining_ms?: number;
  message: string;
}> {
  return new ConvexError({
    code: "CONFLICT",
    reason,
    current_token: currentToken,
    ...(remainingMs !== undefined ? { remaining_ms: remainingMs } : {}),
    message,
  });
}

function refusalMessage(
  reason: TaskClaimRefusalReason,
  shortId?: string,
): string {
  const ref = shortId ?? "task";
  switch (reason) {
    case "free":
      return `${ref} is not currently claimed`;
    case "stale_token":
      return `${ref} claim token is stale`;
    case "wrong_holder":
      return `${ref} is claimed by another holder`;
    case "expired":
      return `${ref} claim lease has expired`;
    case "busy":
      return `${ref} is currently claimed by another holder`;
    case "token_exhausted":
      return `${ref} claim token space is exhausted`;
    case "invalid_request":
      return `${ref} claim request is invalid`;
  }
}

async function throwRefusal(
  db: DbCtx["db"],
  taskId: Id<"tasks">,
  reason: Exclude<TaskClaimRefusalReason, "busy">,
  shortId?: string,
): Promise<never> {
  const currentToken = await readClaimToken(db, { kind: "task", id: taskId });
  throw taskClaimError(reason, currentToken, refusalMessage(reason, shortId));
}

export async function assertHeldTaskClaim(
  ctx: DbCtx,
  input: {
    taskId: Id<"tasks">;
    shortId?: string;
    holder: Id<"users">;
    token: number;
    conversationId?: Id<"conversations">;
    now?: number;
  },
): Promise<{ token: number; remainingMs: number }> {
  const res = await withHeldClaim(
    ctx,
    {
      resource: { kind: "task", id: input.taskId },
      holder: input.holder,
      token: input.token,
      now: input.now,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
    () => true,
  );
  if (res.status !== "held") {
    const reason: Exclude<TaskClaimRefusalReason, "busy"> =
      res.status === "wrong_pane" ? "wrong_holder" : res.status;
    await throwRefusal(ctx.db, input.taskId, reason, input.shortId);
  }
  return {
    token: (res as { token: number }).token,
    remainingMs: (res as { remainingMs: number }).remainingMs,
  };
}

export async function renewTaskClaim(
  ctx: DbCtx,
  input: {
    taskId: Id<"tasks">;
    shortId?: string;
    holder: Id<"users">;
    token: number;
    conversationId?: Id<"conversations">;
    now?: number;
  },
): Promise<{ token: number; leaseUntil: number; remainingMs: number }> {
  const now = input.now ?? Date.now();
  const res = await renew(ctx, {
    resource: { kind: "task", id: input.taskId },
    holder: input.holder,
    token: input.token,
    now,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  });
  if (res.status !== "held") {
    const reason: Exclude<TaskClaimRefusalReason, "busy"> =
      res.status === "wrong_pane" ? "wrong_holder" : res.status;
    await throwRefusal(ctx.db, input.taskId, reason, input.shortId);
  }
  const held = res as { token: number; remainingMs: number };
  return {
    token: held.token,
    leaseUntil: now + held.remainingMs,
    remainingMs: held.remainingMs,
  };
}

export async function releaseTaskClaim(
  ctx: DbCtx,
  input: {
    taskId: Id<"tasks">;
    shortId?: string;
    holder: Id<"users">;
    token: number;
    conversationId?: Id<"conversations">;
    now?: number;
  },
): Promise<{ token: number }> {
  const res = await release(ctx, {
    resource: { kind: "task", id: input.taskId },
    holder: input.holder,
    token: input.token,
    now: input.now,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  });
  if (res.status !== "cleared") {
    const reason: Exclude<TaskClaimRefusalReason, "busy"> =
      res.status === "wrong_pane" ? "wrong_holder" : res.status;
    await throwRefusal(ctx.db, input.taskId, reason, input.shortId);
  }
  return { token: (res as { token: number }).token };
}

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

export async function resolveTaskUpdateConversation(
  ctx: ReadDbCtx,
  holder: Id<"users">,
  rawConversationId?: string,
): Promise<{ conv: Doc<"conversations"> | null; unresolved: boolean }> {
  if (!rawConversationId) return { conv: null, unresolved: false };
  const conv = await resolveSessionConversation(ctx, holder, rawConversationId);
  if (!conv) return { conv: null, unresolved: true };
  if (String(conv.user_id) !== String(holder)) {
    throw taskClaimError(
      "wrong_holder",
      0,
      "Conversation belongs to another user",
    );
  }
  return { conv, unresolved: false };
}

export async function assertTaskWriteWithoutToken(
  ctx: DbCtx,
  input: {
    task: Pick<Doc<"tasks">, "_id" | "short_id" | "status">;
    holder: Id<"users">;
    conversationId?: Id<"conversations">;
    unresolvedConversation?: boolean;
    now?: number;
  },
): Promise<void> {
  const row = await findClaim(ctx.db, { kind: "task", id: input.task._id });
  if (!row) return;
  const now = input.now ?? Date.now();
  if (row.holder !== undefined) {
    if (row.lease_until <= now) {
      throw taskClaimError(
        "expired",
        row.token,
        refusalMessage("expired", input.task.short_id),
      );
    }
    if (
      input.unresolvedConversation ||
      row.holder !== input.holder ||
      row.task?.conversation_id !== input.conversationId
    ) {
      throw taskClaimError(
        "wrong_holder",
        row.token,
        refusalMessage("wrong_holder", input.task.short_id),
      );
    }
    return;
  }
  if (
    row.holder === undefined &&
    input.conversationId !== undefined &&
    input.task.status === "in_progress"
  ) {
    throw taskClaimError(
      "free",
      row.token,
      refusalMessage("free", input.task.short_id),
    );
  }
}

export async function assertTaskWriteClaim(
  ctx: DbCtx,
  input: {
    task: Pick<Doc<"tasks">, "_id" | "short_id" | "status">;
    holder: Id<"users">;
    claimToken?: number;
    conversationId?: Id<"conversations">;
    unresolvedConversation?: boolean;
    now?: number;
  },
): Promise<void> {
  if (input.claimToken !== undefined) {
    if (input.unresolvedConversation) {
      await throwRefusal(
        ctx.db,
        input.task._id,
        "wrong_holder",
        input.task.short_id,
      );
    }
    await assertHeldTaskClaim(ctx, {
      taskId: input.task._id,
      shortId: input.task.short_id,
      holder: input.holder,
      token: input.claimToken,
      conversationId: input.conversationId,
      now: input.now,
    });
    return;
  }
  await assertTaskWriteWithoutToken(ctx, {
    task: input.task,
    holder: input.holder,
    conversationId: input.conversationId,
    unresolvedConversation: input.unresolvedConversation,
    now: input.now,
  });
}

export async function assertTaskMutationClaim(
  ctx: DbCtx,
  task: Pick<Doc<"tasks">, "_id" | "short_id" | "status">,
  holder: Id<"users">,
  args: { claim_token?: number; conversation_id?: string },
  now: number,
  releaseOnPass?: (claimConvId?: Id<"conversations">) => Promise<void>,
): Promise<Id<"conversations"> | undefined> {
  const conv = await resolveOwnedClaimConversation(
    ctx,
    holder,
    args.conversation_id,
  );
  await assertTaskWriteClaim(ctx, {
    task,
    holder,
    claimToken: args.claim_token,
    conversationId: conv?._id,
    now,
  });
  if (releaseOnPass) {
    const claimConvId = await releaseTaskClaimIfHeld(ctx, task._id);
    await releaseOnPass(claimConvId);
  }
  return conv?._id;
}

export async function revokeWebTaskClaim(
  ctx: DbCtx,
  taskId: Id<"tasks">,
  nextStatus?: string,
  reviewVerdict?: string,
  releaseBound?: (claimConvId?: Id<"conversations">) => Promise<void>,
): Promise<void> {
  let claimConvId: Id<"conversations"> | undefined;
  if (nextStatus !== undefined || reviewVerdict) {
    claimConvId = await releaseTaskClaimIfHeld(ctx, taskId);
  }
  if (
    releaseBound &&
    (claimConvId !== undefined ||
      nextStatus === "done" ||
      nextStatus === "dropped" ||
      nextStatus === "open" ||
      nextStatus === "backlog" ||
      nextStatus === "in_progress" ||
      reviewVerdict === "approve" ||
      reviewVerdict === "reject")
  ) {
    await releaseBound(claimConvId);
  }
}

export async function claimTaskWithLease<Released>(
  ctx: DbCtx,
  input: {
    task: Doc<"tasks">;
    holder: Id<"users">;
    conv: Doc<"conversations"> | null;
    take: boolean;
    now?: number;
    expectedToken?: number;
    requestId?: string;
    purpose?: string;
    ownerRefOf?: (conv: Doc<"conversations">, live: boolean) => Released;
    formatBusy?: (conv: Doc<"conversations">) => string;
  },
): Promise<{ released: Released[]; claimToken: number; leaseUntil: number }> {
  const now = input.now ?? Date.now();
  const existing = await findClaim(ctx.db, {
    kind: "task",
    id: input.task._id,
  });
  const currentToken = existing?.token ?? 0;
  const matchesRetry =
    !!input.requestId &&
    existing?.request_id === input.requestId &&
    existing.request_holder === input.holder &&
    (existing.task?.conversation_id ?? undefined) ===
      (input.conv?._id ?? undefined);

  if (
    input.expectedToken !== undefined &&
    !matchesRetry &&
    input.expectedToken !== currentToken
  ) {
    throw taskClaimError(
      "stale_token",
      currentToken,
      refusalMessage("stale_token", input.task.short_id),
    );
  }

  const isLive =
    existing !== null &&
    existing.holder !== undefined &&
    existing.lease_until > now;

  if (isLive && existing && matchesRetry) {
    if (
      input.conv &&
      String(input.conv.active_task_id ?? "") !== String(input.task._id)
    ) {
      await releaseSessionTaskClaim(ctx, input.conv, input.holder, {
        skipUnbindConv: true,
        now,
      });
      await ctx.db.patch(input.conv._id, { active_task_id: input.task._id });
    }
    return {
      released: [],
      claimToken: existing.token,
      leaseUntil: existing.lease_until,
    };
  }

  const released: Released[] = [];
  if (isLive && existing && existing.holder !== undefined) {
    const prevConv = existing.task?.conversation_id
      ? await ctx.db.get(existing.task.conversation_id)
      : null;
    if (!input.take) {
      const msg =
        prevConv && input.formatBusy
          ? input.formatBusy(prevConv)
          : refusalMessage("busy", input.task.short_id);
      throw taskClaimError(
        "busy",
        existing.token,
        msg,
        existing.lease_until - now,
      );
    }
    if (prevConv && String(prevConv._id) !== String(input.conv?._id ?? "")) {
      if (input.ownerRefOf) released.push(input.ownerRefOf(prevConv, true));
      if (String(prevConv.active_task_id ?? "") === String(input.task._id)) {
        await ctx.db.patch(prevConv._id, { active_task_id: undefined });
      }
    }
    const revoked = await revoke(ctx, {
      resource: { kind: "task", id: input.task._id },
      targetHolder: existing.holder,
      token: existing.token,
      now,
    });
    if (revoked.status !== "cleared") {
      throw taskClaimError(
        "stale_token",
        existing.token,
        refusalMessage("stale_token", input.task.short_id),
      );
    }
  } else if (existing?.holder !== undefined && existing.lease_until <= now) {
    const prevConv = existing.task?.conversation_id
      ? await ctx.db.get(existing.task.conversation_id)
      : null;
    if (prevConv && String(prevConv._id) !== String(input.conv?._id ?? "")) {
      if (input.ownerRefOf) released.push(input.ownerRefOf(prevConv, false));
      if (String(prevConv.active_task_id ?? "") === String(input.task._id)) {
        await ctx.db.patch(prevConv._id, { active_task_id: undefined });
      }
    }
  }

  const res = await claim(ctx, {
    kind: "task",
    id: input.task._id,
    holder: input.holder,
    now,
    requestId: input.requestId ?? crypto.randomUUID(),
    expectedToken: currentToken,
    purpose:
      input.purpose ??
      (input.conv
        ? `session:${input.conv.short_id ?? String(input.conv._id)}`
        : "user"),
    ...(input.conv ? { conversationId: input.conv._id } : {}),
  });

  if (res.status !== "held") {
    if (res.status === "stale_request") {
      throw taskClaimError(
        "stale_token",
        res.currentToken,
        refusalMessage("stale_token", input.task.short_id),
      );
    }
    if (res.status === "busy") {
      throw taskClaimError(
        "busy",
        currentToken,
        refusalMessage("busy", input.task.short_id),
        res.remainingMs,
      );
    }
    if (res.status === "token_exhausted") {
      throw taskClaimError(
        "token_exhausted",
        currentToken,
        refusalMessage("token_exhausted", input.task.short_id),
      );
    }
    throw taskClaimError(
      "invalid_request",
      currentToken,
      refusalMessage("invalid_request", input.task.short_id),
    );
  }

  if (
    input.conv &&
    String(input.conv.active_task_id ?? "") !== String(input.task._id)
  ) {
    await releaseSessionTaskClaim(ctx, input.conv, input.holder, {
      skipUnbindConv: true,
      now,
    });
    await ctx.db.patch(input.conv._id, { active_task_id: input.task._id });
  }

  await ctx.scheduler?.runAfter(res.remainingMs, internal.taskClaims.expire, {
    task_id: input.task._id,
    token: res.token,
  });

  return {
    released,
    claimToken: res.token,
    leaseUntil: now + res.remainingMs,
  };
}

export async function handleTaskUpdateClaim(
  ctx: DbCtx,
  input: {
    task: Doc<"tasks">;
    holder: Id<"users">;
    conv: Doc<"conversations"> | null;
    unresolvedConversation?: boolean;
    nextStatus?: string;
    reviewVerdict?: string;
    claimToken?: number;
    requestId?: string;
    purpose?: string;
    take?: boolean;
    now: number;
    claimStarted?: boolean;
    releaseBound: (claimConvId?: Id<"conversations">) => Promise<void>;
  },
): Promise<{ claimToken: number; leaseUntil: number } | null> {
  const { task, holder, conv, nextStatus, reviewVerdict, claimToken, now } =
    input;
  if (nextStatus === "in_progress" && !reviewVerdict) {
    if (input.unresolvedConversation) {
      throw taskClaimError("wrong_holder", 0, "Conversation not found");
    }
    if (input.claimStarted) return null;
    const res = await claimTaskWithLease(ctx, {
      task,
      holder,
      conv,
      take: input.take === true,
      now,
      expectedToken: claimToken,
      requestId: input.requestId,
      purpose: input.purpose,
    });
    return { claimToken: res.claimToken, leaseUntil: res.leaseUntil };
  }
  await assertTaskWriteClaim(ctx, {
    task,
    holder,
    claimToken,
    conversationId: conv?._id,
    unresolvedConversation: input.unresolvedConversation,
    now,
  });
  const releasesClaim =
    nextStatus === "done" ||
    nextStatus === "dropped" ||
    nextStatus === "in_review" ||
    nextStatus === "open" ||
    nextStatus === "backlog" ||
    reviewVerdict === "approve" ||
    reviewVerdict === "changes" ||
    reviewVerdict === "reject";
  if (releasesClaim) {
    const claimConvId = await releaseTaskClaimIfHeld(ctx, task._id);
    if (
      nextStatus === "open" ||
      nextStatus === "backlog" ||
      nextStatus === "in_review" ||
      nextStatus === "done" ||
      nextStatus === "dropped" ||
      reviewVerdict === "approve" ||
      reviewVerdict === "changes" ||
      reviewVerdict === "reject"
    ) {
      await input.releaseBound(claimConvId);
    }
  }
  return null;
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
  const conversationId = await resolveClaimConversationId(
    ctx,
    input.holder,
    input.conversationRef,
  );
  let token = input.claimToken;
  if (token === undefined) {
    await assertTaskWriteWithoutToken(ctx, {
      task: input.task,
      holder: input.holder,
      conversationId,
      now,
    });
    const row = await findClaim(ctx.db, { kind: "task", id: input.task._id });
    if (!row || row.holder === undefined) {
      await input.writeHeartbeat();
      return { success: true };
    }
    token = row.token;
  }
  const renewed = await renewTaskClaim(ctx, {
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
  now: number,
): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv?.active_task_id) return;
  const row = await findClaim(ctx.db, {
    kind: "task",
    id: conv.active_task_id,
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
  await renewTaskClaim(ctx, {
    taskId: conv.active_task_id,
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
