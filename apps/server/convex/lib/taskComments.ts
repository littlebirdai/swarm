import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { formatTaskCommentMessage } from "@codecast/messages/machineMessages";
import { extractMentionHandles } from "@codecast/chat";
import {
  canSendProductMessage,
  enqueuePendingMessage,
} from "../pendingMessages";
import {
  agentCommentLevelOf,
  taskCommentAuthorKind,
  taskCommentIsNews,
  taskThreadParticipants,
  touchThread,
  type TaskCommentAuthorKind,
} from "../threadReads";
import { matchHandle, teamRoster } from "./mentionResolve";
import { commentReaches } from "./taskExecution";
import { subscribeUser } from "./taskNotifications";
import { liveTaskOwnerSession } from "./taskOwner";

// Insert a comment AND bump the task row in the same mutation. task_comments
// is not a change-feed-tracked table, so a bare insert is invisible to sync —
// no client cache learns about it until the task's detail query happens to run.
// Bumping updated_at stamps the change log; the feed then re-fetches the row
// through webGetByIds, which carries comments, so every client's cached
// activity stays fresh without opening the task.
//
// The comment also files the task in the Threads inbox of everyone following
// it (subscribers, creator, assignee). `actorId` is the PERSON who wrote it:
// their copy reads as read and the row carries author_user_id. An agent or
// system row has no actor, so the owner sees it unread — that is the point.
// Every task_comments insert with a task row goes through here.
//
// `notify` also rings the bell (and the phone) for the same people the row
// moves for, so the Threads inbox and the notification never disagree about
// what is news. `tokenOwner` is who the write ran under: an agent posts under
// its owner's token, and its own comments never ring its owner.
/**
 * Relay a person's comment into the session that owns the task (lib/taskOwner)
 * while that session is working, framed as a <task-comment> so the agent knows
 * whose words they are and that a reply belongs on the task. A quiet owner is
 * left alone: waking a cold session rebuilds its whole context for one line,
 * and the comment waits on the task where it reads it next. Returns the
 * conversation it reached, or null.
 */
async function deliverCommentToOwner(
  ctx: any,
  task: any,
  c: {
    commentId: Id<"task_comments">;
    actorId: Id<"users">;
    from: string;
    text: string;
    imageIds?: string[];
  },
): Promise<Id<"conversations"> | null> {
  if (!task.short_id || !c.text.trim()) return null;
  const owner = await liveTaskOwnerSession(ctx, task._id);
  if (!owner || owner.inbox_killed_at || owner.status === "completed") {
    return null;
  }
  if (!(await canSendProductMessage(ctx, c.actorId, owner))) return null;
  await enqueuePendingMessage(ctx, owner, c.actorId, {
    content: formatTaskCommentMessage({
      task: task.short_id,
      title: task.title ?? "",
      from: c.from,
      body: c.text.trim(),
    }),
    client_id: `task-comment:${c.commentId}`,
    ...(c.imageIds?.length
      ? { image_storage_ids: c.imageIds as Id<"_storage">[] }
      : {}),
    human: true,
  });
  return owner._id;
}

export async function insertTaskComment(
  ctx: any,
  taskId: Id<"tasks">,
  fields: {
    author: string;
    text: string;
    comment_type: string;
    conversation_id?: Id<"conversations">;
    image_storage_ids?: string[];
  },
  actorId?: Id<"users">,
  // `run`: the comment is a workflow run's (lib/actor kind "run"). It notifies under the run's name, and its owner is
  // not its actor, so the owner hears it too; `ownerOnly` reaches the owner alone.
  notify?: {
    tokenOwner: Id<"users">;
    conversationId?: Id<"conversations">;
    run?: { name: string; owner: Id<"users">; ownerOnly: boolean };
  },
  suppressRelay = false,
) {
  const now = Date.now();
  const id = await ctx.db.insert("task_comments", {
    task_id: taskId,
    ...fields,
    author_user_id: actorId,
    comment_type: fields.comment_type as any,
    created_at: now,
  });
  // last_comment_at is the replica's refetch trigger for cached comments
  // (sync-log-cargo E7): the log ships task rows only, and a clock-only bump
  // cannot be told apart from any other write once cargo coalesces.
  await ctx.db.patch(taskId, { updated_at: now, last_comment_at: now });
  const task = await ctx.db.get(taskId);
  if (task) {
    // An @mention is attention AT a person, whoever typed it: the named
    // people follow the thread from here on (membership's "mentioned" leg),
    // so they must be subscribed before the participants are resolved.
    const mentioned = await mentionedInTaskComment(ctx, task, fields.text);
    for (const userId of mentioned)
      await subscribeUser(
        ctx,
        userId,
        taskId,
        "mentioned",
        actorId ? "human" : "agent",
      );
    const mentionedSet = new Set(mentioned.map(String));
    // The row moves only for the participants this comment is news for
    // (threadReads.taskCommentIsNews): a person's comment for everyone else,
    // an agent's only when it needs a person, or per the reader's own level.
    // The named people are participants of this comment outright, whether
    // or not the subscription write above has landed in this transaction.
    // A bot account's comment (an anchor, another team's triage agent) is an
    // agent's, the same classification the read side applies (threads.ts).
    const news: Id<"users">[] = [];
    const participants = await taskThreadParticipants(ctx, task);
    for (const id of mentioned)
      if (!participants.some((p) => String(p) === String(id)))
        participants.push(id);
    const actor = actorId ? await ctx.db.get(actorId) : null;
    for (const userId of participants) {
      const author: TaskCommentAuthorKind = taskCommentAuthorKind(
        { author_user_id: actorId },
        actor,
        userId,
      );
      const level = agentCommentLevelOf(await ctx.db.get(userId));
      if (
        taskCommentIsNews(
          fields,
          author,
          level,
          mentionedSet.has(String(userId)),
        )
      )
        news.push(userId);
    }
    // Ephemeral bookkeeping stays out of the Threads inbox (TG9) unless the
    // comment calls on someone.
    const run = notify?.run;
    const recipients = run?.ownerOnly
      ? [run.owner, ...mentioned.filter((m) => String(m) !== String(run.owner))]
      : commentReaches(task, fields.comment_type, news, mentionedSet);
    if (!task.ephemeral || recipients.length)
      await touchThread(ctx, {
        kind: "task",
        rootKey: String(taskId),
        teamId: task.team_id,
        refs: { task_id: taskId },
        participants: recipients,
        actorId,
        activityAt: now,
      });
    // A person's words, not posted from a session: they reach the session
    // doing the task while it works, so commenting on the task talks to the
    // work. A bot account's comment is an agent's and never relays.
    if (
      actorId &&
      !fields.conversation_id &&
      !actor?.is_bot &&
      !suppressRelay
    ) {
      const deliveredTo = await deliverCommentToOwner(ctx, task, {
        commentId: id,
        actorId,
        from: fields.author,
        text: fields.text,
        imageIds: fields.image_storage_ids,
      });
      if (deliveredTo)
        await ctx.db.patch(id, { delivered_to_conversation_id: deliveredTo });
    }
    if (notify) {
      await ctx.runMutation(internal.notificationRouter.emit, {
        event_type: "task_commented",
        ...(run
          ? { actor_name: run.name }
          : { actor_user_id: actorId ?? notify.tokenOwner }),
        entity_type: "task",
        entity_id: String(taskId),
        message: `commented on ${task.short_id}: ${fields.text.slice(0, 100)}`,
        conversation_id: notify.conversationId,
        recipient_ids: run
          ? recipients
          : recipients.filter((r) => String(r) !== String(notify.tokenOwner)),
      });
    }
  }
  return id;
}

/** The team members a task comment names with @handle (the chat grammar,
 *  resolved against the task's team roster, so a display name can never
 *  intercept a mention). A personal task has no roster and no mentions. */
async function mentionedInTaskComment(
  ctx: any,
  task: { team_id?: Id<"teams"> },
  text: string,
): Promise<Id<"users">[]> {
  const handles = extractMentionHandles(text);
  if (handles.length === 0 || !task.team_id) return [];
  const roster = await teamRoster(ctx, task.team_id);
  const out: Id<"users">[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    const user = matchHandle(roster, handle);
    if (!user || user.is_bot || seen.has(String(user._id))) continue;
    seen.add(String(user._id));
    out.push(user._id);
  }
  return out;
}
