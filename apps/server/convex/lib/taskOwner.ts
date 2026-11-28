import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { findClaim } from "./claims";
import { HANDOFF_COMMENT } from "./runAgentSessions";
import { claimTaskWithLease, releaseTaskClaimIfHeld } from "./taskClaims";

export interface TaskOwnerRef {
  conversation_id: Id<"conversations">;
  short_id: string;
  title: string | null;
  live: boolean;
  updated_at: number;
}

export async function liveTaskOwnerSession(
  ctx: { db: any },
  taskId: Id<"tasks">,
  now = Date.now(),
): Promise<any | null> {
  const row = await findClaim(ctx.db, { kind: "task", id: taskId });
  if (!row || row.holder === undefined || row.lease_until <= now) return null;
  if (!row.task?.conversation_id) return null;
  const conv = await ctx.db.get(row.task.conversation_id);
  if (!conv || String(conv.review_of_task_id ?? "") === String(taskId)) {
    return null;
  }
  return conv;
}

/** The session a change on `task` came from: the live session bound to it, else the newest live session that
 *  handed it off (its HANDOFF_COMMENT review comment), since an implementer often moves to other work once it does.
 *  A session reviewing the task is neither. */
export async function changeSessionOf(
  ctx: { db: any },
  task: any,
  comments: {
    conversation_id?: Id<"conversations">;
    comment_type: string;
    text: string;
    created_at: number;
  }[],
): Promise<any | null> {
  const bound = await liveTaskOwnerSession(ctx, task._id);
  if (bound && !bound.inbox_killed_at) return bound;
  const handoffs = comments.filter(
    (c) =>
      c.conversation_id &&
      c.comment_type === "review" &&
      HANDOFF_COMMENT.test(c.text),
  );
  for (const h of handoffs.sort((a, b) => b.created_at - a.created_at)) {
    const conv = await ctx.db.get(h.conversation_id);
    if (
      conv &&
      !conv.inbox_killed_at &&
      String(conv.review_of_task_id ?? "") !== String(task._id)
    )
      return conv;
  }
  return null;
}

function ago(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60
    ? `${m}m`
    : m < 48 * 60
      ? `${Math.round(m / 60)}h`
      : `${Math.round(m / 1440)}d`;
}

export function ownedElsewhereMessage(
  task: any,
  owner: TaskOwnerRef,
  now: number,
): string {
  const ref = task.short_id ?? String(task._id);
  const title = owner.title ? ` ("${owner.title.slice(0, 60)}")` : "";
  return [
    `${ref} is owned by session ${owner.short_id}${title}, which is still working (active ${ago(now - owner.updated_at)} ago).`,
    `A task has one owning session. Starting it here moves the binding, and ${owner.short_id} loses its task context.`,
    `Coordinate first: \`cast read ${owner.short_id}\` shows where it is, \`cast send ${owner.short_id} "..."\` agrees who continues.`,
    `To take it anyway: cast task start ${ref} --take`,
  ].join("\n");
}

/**
 * Make `conv` the task's one owning session. Other bound sessions are
 * released. A released session that is still working is refused unless
 * `take` is set, so a session never loses its task without the taker
 * deciding to. Callers acting for a person (the board, a spawn, a handoff)
 * pass take: the person chose the new session.
 */
export async function claimTaskOwnership(
  ctx: { db: any; scheduler?: any },
  conv: any,
  task: any,
  opts: {
    take: boolean;
    now?: number;
    holder?: Id<"users">;
    expectedToken?: number;
    requestId?: string;
    purpose?: string;
  },
): Promise<{
  released: TaskOwnerRef[];
  claimToken: number;
  leaseUntil: number;
}> {
  const now = opts.now ?? Date.now();
  return await claimTaskWithLease<TaskOwnerRef>(ctx, {
    task,
    holder: opts.holder ?? conv.user_id,
    conv,
    take: opts.take,
    now,
    expectedToken: opts.expectedToken,
    requestId: opts.requestId,
    purpose: opts.purpose,
    ownerRefOf: (c, live) => ({
      conversation_id: c._id,
      short_id: c.short_id ?? String(c._id).slice(0, 7),
      title: c.title ?? null,
      live,
      updated_at: c.updated_at ?? 0,
    }),
    formatBusy: (c) =>
      ownedElsewhereMessage(
        task,
        {
          conversation_id: c._id,
          short_id: c.short_id ?? String(c._id).slice(0, 7),
          title: c.title ?? null,
          live: true,
          updated_at: c.updated_at ?? 0,
        },
        now,
      ),
  });
}

export async function releaseBoundSessions(
  ctx: any,
  task: any,
  conversationId?: Id<"conversations">,
  extraConversationId?: Id<"conversations">,
): Promise<void> {
  const claimConvId = await releaseTaskClaimIfHeld(ctx, task._id);
  const ids = new Set(
    [
      ...(task.conversation_ids ?? []),
      ...(conversationId ? [conversationId] : []),
      ...(extraConversationId ? [extraConversationId] : []),
      ...(claimConvId ? [claimConvId] : []),
    ].map(String),
  );
  for (const convId of ids) {
    const conv: any = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || String(conv.active_task_id ?? "") !== String(task._id))
      continue;
    await ctx.db.patch(conv._id, { active_task_id: undefined });
    await ctx.scheduler?.runAfter(0, internal.sessionOwnership.reconcileHold, {
      conversation_id: conv._id,
    });
  }
}
