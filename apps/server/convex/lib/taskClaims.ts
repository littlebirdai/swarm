import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveSessionConversation } from "./access";
import {
  claim,
  clearClaim,
  findClaim,
  readClaimToken,
  release,
  renew,
  revoke,
  taskClaimsEnabled,
  withHeldClaim,
} from "./claims";

export type TaskClaimRefusalReason =
  | "free"
  | "stale_token"
  | "wrong_holder"
  | "expired"
  | "busy"
  | "token_exhausted"
  | "invalid_request";

type DbCtx = Pick<MutationCtx, "db">;

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
  },
): Promise<{ token: number; remainingMs: number }> {
  const res = await withHeldClaim(
    ctx,
    {
      resource: { kind: "task", id: input.taskId },
      holder: input.holder,
      token: input.token,
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
  },
): Promise<{ token: number; leaseUntil: number; remainingMs: number }> {
  const res = await renew(ctx, {
    resource: { kind: "task", id: input.taskId },
    holder: input.holder,
    token: input.token,
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
    leaseUntil: Date.now() + held.remainingMs,
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
  },
): Promise<{ token: number }> {
  const res = await release(ctx, {
    resource: { kind: "task", id: input.taskId },
    holder: input.holder,
    token: input.token,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  });
  if (res.status !== "cleared") {
    const reason: Exclude<TaskClaimRefusalReason, "busy"> =
      res.status === "wrong_pane" ? "wrong_holder" : res.status;
    await throwRefusal(ctx.db, input.taskId, reason, input.shortId);
  }
  return { token: (res as { token: number }).token };
}

export async function releaseTaskClaimIfHeld(
  ctx: DbCtx,
  taskId: Id<"tasks">,
): Promise<void> {
  const row = await findClaim(ctx.db, { kind: "task", id: taskId });
  if (row && row.holder !== undefined) await clearClaim(ctx, row);
}

export async function releaseSessionTaskClaim(
  ctx: DbCtx,
  conv: Pick<Doc<"conversations">, "_id" | "active_task_id"> | null | undefined,
): Promise<void> {
  if (!conv?.active_task_id) return;
  const row = await findClaim(ctx.db, {
    kind: "task",
    id: conv.active_task_id,
  });
  if (row && row.holder !== undefined && row.task?.conversation_id === conv._id)
    await clearClaim(ctx, row);
}

export async function assertTaskWriteWithoutToken(
  ctx: DbCtx,
  input: {
    task: Pick<Doc<"tasks">, "_id" | "short_id" | "status">;
    holder: Id<"users">;
    conversationId?: Id<"conversations">;
    now?: number;
  },
): Promise<void> {
  const row = await findClaim(ctx.db, { kind: "task", id: input.task._id });
  if (!row) return;
  const now = input.now ?? Date.now();
  if (row.holder !== undefined && row.lease_until > now) {
    if (row.holder !== input.holder) {
      throw taskClaimError(
        "wrong_holder",
        row.token,
        refusalMessage("wrong_holder", input.task.short_id),
      );
    }
    if (
      input.conversationId !== undefined &&
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
  if (row.holder !== undefined && row.lease_until <= now) {
    if (input.conversationId !== undefined) {
      throw taskClaimError(
        "expired",
        row.token,
        refusalMessage("expired", input.task.short_id),
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
    checkLegacyBound?: () => Promise<Released[]>;
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

  const sameSession = input.conv
    ? existing?.task?.conversation_id === input.conv._id
    : existing?.task?.conversation_id === undefined;
  const isLive =
    existing !== null &&
    existing.holder !== undefined &&
    existing.lease_until > now;

  if (isLive && existing.holder === input.holder && sameSession) {
    if (matchesRetry) {
      if (
        input.conv &&
        String(input.conv.active_task_id ?? "") !== String(input.task._id)
      ) {
        await releaseSessionTaskClaim(ctx, input.conv);
        await ctx.db.patch(input.conv._id, { active_task_id: input.task._id });
      }
      return {
        released: [],
        claimToken: existing.token,
        leaseUntil: existing.lease_until,
      };
    }
    const renewed = await renew(ctx, {
      resource: { kind: "task", id: input.task._id },
      holder: input.holder,
      token: existing.token,
      ...(input.conv ? { conversationId: input.conv._id } : {}),
    });
    if (renewed.status !== "held") {
      throw taskClaimError(
        "stale_token",
        existing.token,
        refusalMessage("stale_token", input.task.short_id),
      );
    }
    if (
      input.conv &&
      String(input.conv.active_task_id ?? "") !== String(input.task._id)
    ) {
      await releaseSessionTaskClaim(ctx, input.conv);
      await ctx.db.patch(input.conv._id, { active_task_id: input.task._id });
    }
    return {
      released: [],
      claimToken: renewed.token,
      leaseUntil: Date.now() + renewed.remainingMs,
    };
  }

  const released: Released[] = [];
  if (isLive && existing.holder !== undefined) {
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
    if (prevConv) {
      if (input.ownerRefOf) released.push(input.ownerRefOf(prevConv, true));
      if (String(prevConv.active_task_id ?? "") === String(input.task._id)) {
        await ctx.db.patch(prevConv._id, { active_task_id: undefined });
      }
    }
    const revoked = await revoke(ctx, {
      resource: { kind: "task", id: input.task._id },
      targetHolder: existing.holder,
      token: existing.token,
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
  } else if (!existing && input.checkLegacyBound) {
    released.push(...(await input.checkLegacyBound()));
  }

  const res = await claim(ctx, {
    kind: "task",
    id: input.task._id,
    holder: input.holder,
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
    await releaseSessionTaskClaim(ctx, input.conv);
    await ctx.db.patch(input.conv._id, { active_task_id: input.task._id });
  }

  return {
    released,
    claimToken: res.token,
    leaseUntil: Date.now() + res.remainingMs,
  };
}

export async function handleTaskUpdateClaim(
  ctx: DbCtx,
  input: {
    task: Doc<"tasks">;
    holder: Id<"users">;
    conv: Doc<"conversations"> | null;
    nextStatus?: string;
    reviewVerdict?: string;
    claimToken?: number;
    requestId?: string;
    purpose?: string;
    take?: boolean;
    now: number;
    claimStarted?: boolean;
    releaseBound: () => Promise<void>;
  },
): Promise<{ claimToken: number; leaseUntil: number } | null> {
  if (!taskClaimsEnabled()) return null;
  const { task, holder, conv, nextStatus, reviewVerdict, claimToken, now } =
    input;
  if (nextStatus === "in_progress" && !reviewVerdict) {
    if (input.claimStarted) return null;
    const res = await claimTaskWithLease(ctx, {
      task,
      holder,
      conv: null,
      take: input.take === true,
      now,
      expectedToken: claimToken,
      requestId: input.requestId,
      purpose: input.purpose,
    });
    return { claimToken: res.claimToken, leaseUntil: res.leaseUntil };
  }
  const releasesClaim =
    nextStatus === "done" ||
    nextStatus === "dropped" ||
    nextStatus === "in_review" ||
    (nextStatus === "open" && task.status === "in_progress");
  if (claimToken !== undefined) {
    await assertHeldTaskClaim(ctx, {
      taskId: task._id,
      shortId: task.short_id,
      holder,
      token: claimToken,
      conversationId: conv?._id,
    });
    if (releasesClaim) {
      await releaseTaskClaimIfHeld(ctx, task._id);
      if (
        nextStatus === "open" ||
        nextStatus === "done" ||
        nextStatus === "dropped"
      ) {
        await input.releaseBound();
      }
    }
    return null;
  }
  if (!reviewVerdict && releasesClaim) {
    await assertTaskWriteWithoutToken(ctx, {
      task,
      holder,
      conversationId: conv?._id,
      now,
    });
    await releaseTaskClaimIfHeld(ctx, task._id);
    if (
      nextStatus === "open" ||
      nextStatus === "done" ||
      nextStatus === "dropped"
    ) {
      await input.releaseBound();
    }
  }
  return null;
}

async function resolveClaimConversationId(
  ctx: DbCtx,
  userId: Id<"users">,
  rawConversationId?: string,
): Promise<Id<"conversations"> | undefined> {
  if (!rawConversationId) return undefined;
  const conv = await resolveSessionConversation(ctx, userId, rawConversationId);
  if (!conv) throw taskClaimError("wrong_holder", 0, "Conversation not found");
  return conv._id;
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
  if (!taskClaimsEnabled()) {
    await input.writeHeartbeat();
    return { success: true };
  }
  const conversationId = await resolveClaimConversationId(
    ctx,
    input.holder,
    input.conversationRef,
  );
  if (input.claimToken === undefined) {
    const current = await readClaimToken(ctx.db, {
      kind: "task",
      id: input.task._id,
    });
    throw taskClaimError(
      "stale_token",
      current,
      refusalMessage("stale_token", input.task.short_id),
    );
  }
  const renewed = await renewTaskClaim(ctx, {
    taskId: input.task._id,
    shortId: input.task.short_id,
    holder: input.holder,
    token: input.claimToken,
    conversationId,
  });
  await input.writeHeartbeat();
  return {
    success: true,
    claim_token: renewed.token,
    lease_until: renewed.leaseUntil,
    remaining_ms: renewed.remainingMs,
  };
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
