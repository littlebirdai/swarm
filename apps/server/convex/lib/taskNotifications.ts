import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { SubscriptionVia } from "../notificationRouter";
import { tellRole } from "../pendingMessages";
import { dropThreadRead, taskThreadParticipants } from "../threadReads";
import { resolveAssigneeToUserId, roleAssigneeOf } from "./taskAssignees";
import { isEphemeralTask } from "./taskExecution";

// A status change rings nobody by default: the board and the Threads inbox
// carry it. A reader who opts in (notification_preferences.task_status_changes)
// hears only the moves that end a task, done or dropped, and only on tasks
// they take part in (the same participants a comment reaches), like Linear's
// "status changes" setting.
const STATUS_NEWS: ReadonlySet<string> = new Set(["done", "dropped"]);

export async function notifyTaskStatus(
  ctx: any,
  actorUserId: Id<"users">,
  task: {
    _id: Id<"tasks">;
    short_id: string;
    user_id: Id<"users">;
    assignee?: string;
    source?: string;
    creation_source?: string;
  },
  status: string,
  conversationId?: Id<"conversations">,
) {
  if (!STATUS_NEWS.has(status)) return;
  const recipients: Id<"users">[] = [];
  for (const userId of await taskThreadParticipants(ctx, task as any)) {
    const user = await ctx.db.get(userId);
    if (user?.notification_preferences?.task_status_changes === true)
      recipients.push(userId);
  }
  if (recipients.length === 0) return;
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: "task_status_changed",
    actor_user_id: actorUserId,
    entity_type: "task",
    entity_id: task._id.toString(),
    message: `changed ${task.short_id} to ${status}`,
    conversation_id: conversationId,
    recipient_ids: recipients,
  });
}

// `via` says who performed the enrolling act. Agents run under the owner's
// token, so identity alone cannot tell a person's act from an agent's; every
// caller states it. The rule for CLI mutations: a conversation_id on the
// call means an agent inside a session; none means a person at the terminal.
export async function subscribeUser(
  ctx: any,
  userId: Id<"users">,
  taskId: Id<"tasks">,
  reason: "creator" | "assignee" | "commenter" | "mentioned" | "watching",
  via: SubscriptionVia,
) {
  await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
    user_id: userId,
    entity_type: "task",
    entity_id: taskId.toString(),
    reason,
    via,
  });
}

// Actor kind for a CLI mutation: see subscribeUser.
export function cliVia(args: { conversation_id?: string }): SubscriptionVia {
  return args.conversation_id ? "agent" : "human";
}

// Assigning a task to someone ELSE is a handoff: the assigner's thread leaves
// their inbox and stays out. The mute is the durable marker — it denies every
// membership leg until re-engagement clears it (being assigned back, being
// mentioned, or a human act of one's own; see ensureSubscribed) — and the
// thread_reads drop clears the card now. Callers gate on a HUMAN act: an
// agent assigning under its owner's token must not silently unfollow the
// owner. Assigning to an agent label (no user id) hands the stream to nobody,
// so the assigner keeps their follow.
async function handoffTaskThread(
  ctx: any,
  taskId: Id<"tasks">,
  actorId: Id<"users">,
  assigneeUserId: Id<"users"> | null | undefined,
) {
  if (!assigneeUserId || String(assigneeUserId) === String(actorId)) return;
  await ctx.runMutation(internal.notificationRouter.setSubscriptionMuted, {
    user_id: actorId,
    entity_type: "task",
    entity_id: taskId.toString(),
    muted: true,
  });
  await dropThreadRead(ctx, actorId, "task", String(taskId));
}

// A task has a new assignee: tell them. ONE path for every writer (create,
// update, the board, bulk assign), so a person and a role are each told the
// same way wherever the assignment came from.
//
// A person is subscribed, the assigner's follow is handed over when a human
// did it, and they are notified; assigning yourself is not an event. A role
// (org-roles-run-work.md R5) is woken with the task as the cause, a fold row
// on its wake rail. The rail's loop rules decide who counts as somebody else:
// a role's own session or hand taking a task never wakes it, a person or the
// role above it does. The assigner keeps their follow, since a person who
// hands work to a role wants to hear how it went.
export async function announceAssignment(
  ctx: any,
  o: {
    task: {
      _id: Id<"tasks">;
      short_id: string;
      title: string;
      team_id?: Id<"teams">;
    };
    assignee: string | undefined;
    actorUserId: Id<"users">;
    actorName?: string;
    via: SubscriptionVia;
    fromConversationId?: Id<"conversations">;
    note?: string;
  },
): Promise<void> {
  if (!o.assignee) return;
  const role = await roleAssigneeOf(ctx, o.assignee);
  if (role) {
    const by =
      o.actorName || (await ctx.db.get(o.actorUserId))?.name || "Someone";
    await tellRole(ctx, role._id, {
      content: `${by} assigned you ${o.task.short_id} "${(o.task.title ?? "").slice(0, 80)}"${o.note?.trim() ? `. ${o.note.trim()}` : ""}`,
      client_id: `assigned:${o.task._id}:${role._id}`,
      from_user_id: o.actorUserId,
      from_conversation_id: o.fromConversationId,
    });
    return;
  }
  const assigneeId = await resolveAssigneeToUserId(
    ctx,
    o.assignee,
    o.task.team_id,
  );
  if (!assigneeId || String(assigneeId) === String(o.actorUserId)) return;
  await subscribeUser(ctx, assigneeId, o.task._id, "assignee", o.via);
  if (o.via === "human")
    await handoffTaskThread(ctx, o.task._id, o.actorUserId, assigneeId);
  // Ephemeral bookkeeping rings nobody (TG9), and must not touch a fold row either.
  if (await isEphemeralTask(ctx, "task", String(o.task._id))) return;
  if (await foldMachineAssignment(ctx, assigneeId, o)) return;
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: "task_assigned",
    actor_user_id: o.actorUserId,
    entity_type: "task",
    entity_id: o.task._id.toString(),
    message: `assigned you to ${o.task.short_id}: ${o.task.title}`,
    direct_recipient_id: assigneeId,
  });
}

// An agent or a bot account assigning work does it in bursts (a board sweep
// handed one person 45 tasks in a minute). While the last such row from the
// same actor is still unread and recent, a new assignment folds into it: one
// row that counts, pointing at the newest task, and no second push.
const ASSIGNMENT_FOLD_WINDOW_MS = 30 * 60 * 1000;

async function foldMachineAssignment(
  ctx: any,
  assigneeId: Id<"users">,
  o: {
    task: { _id: Id<"tasks">; short_id: string; title: string };
    actorUserId: Id<"users">;
    via: SubscriptionVia;
  },
): Promise<boolean> {
  if (o.via !== "agent" && !(await ctx.db.get(o.actorUserId))?.is_bot)
    return false;
  const now = Date.now();
  const recent = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_created", (q: any) =>
      q
        .eq("recipient_user_id", assigneeId)
        .gt("created_at", now - ASSIGNMENT_FOLD_WINDOW_MS),
    )
    .order("desc")
    .take(50);
  const open = recent.find(
    (n: any) =>
      n.type === "task_assigned" &&
      !n.read &&
      String(n.actor_user_id) === String(o.actorUserId),
  );
  if (!open) return false;
  const count = (open.fold_count ?? 1) + 1;
  await ctx.db.patch(open._id, {
    fold_count: count,
    entity_id: o.task._id.toString(),
    message: `assigned you ${count} tasks, latest ${o.task.short_id}: ${o.task.title}`,
    created_at: now,
  });
  return true;
}

// ── Outbound issue sync (docs/architecture/issue-sync.md S5) ──
// Field writes push through lib/taskWrite.patchTask (every synced-field write
// on a task goes through it, never a raw patch). Comments and new tasks
// schedule here: the inbound path (issueSync.applyRemote) never schedules a
// push, which is what keeps provider and codecast from echoing at each other
// (S4.1).

export async function schedulePushComment(
  ctx: any,
  task: any,
  commentId: Id<"task_comments">,
) {
  if (!task?.external) return;
  await ctx.scheduler.runAfter(0, internal.issueSync.pushComment, {
    comment_id: commentId,
  });
}

/** A task born in a project whose source mirrors new tasks gets a provider twin. */
export async function schedulePushNewTask(
  ctx: any,
  projectId: Id<"projects"> | undefined,
  taskId: Id<"tasks">,
) {
  if (!projectId) return;
  const source = await ctx.db
    .query("issue_sync_sources")
    .withIndex("by_project", (q: any) => q.eq("project_id", projectId))
    .first();
  if (source?.status === "active" && source.push_new_tasks) {
    await ctx.scheduler.runAfter(0, internal.issueSync.pushNewTask, {
      task_id: taskId,
    });
  }
}

/** `cast task keep` turns bookkeeping into real work: it gets the provider
 *  twin its ephemeral birth skipped (task-graph.md TG9). */
export async function schedulePushKeptTask(
  ctx: any,
  task: any,
  updates: Record<string, any>,
) {
  if (!task.ephemeral || !("ephemeral" in updates) || updates.ephemeral) return;
  await schedulePushNewTask(
    ctx,
    "project_id" in updates ? updates.project_id : task.project_id,
    task._id,
  );
}
