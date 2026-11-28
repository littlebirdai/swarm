import type { Id } from "../_generated/dataModel";
import { isLineRun } from "@codecast/line/changeCard";
import { ownerOf } from "@codecast/org/orgLead";
import {
  TASK_STATUS_CATEGORIES,
  isTerminalTaskStatus,
} from "@codecast/tasks/statuses";
import { withdrawClosedProblemAsks } from "../sessionDecisions";
import { afterStatusEdges } from "../taskLinks";
import { cancelCore } from "../workflow_runs";
import { isSameWorkspace, workspaceForResource } from "./access";
import { allRolesInBoundary } from "./orgAccess";
import { taskWork } from "./orgOwnership";
import { runWorkflowOf } from "./runGraph";
import { releaseTaskClaimIfHeld } from "./taskClaims";
import { insertTaskComment } from "./taskComments";
import { byUser, recordTaskChange } from "./taskHistory";
import { announceAssignment, notifyTaskStatus } from "./taskNotifications";
import { releaseBoundSessions } from "./taskOwner";
import { recalcPlanProgress } from "./taskSubtasks";
import { patchTask } from "./taskWrite";

export const REVIEW_VERDICTS = ["approve", "changes", "reject"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** The task's bound run, while it is still going, whatever its graph. */
export async function liveRun(ctx: any, task: any): Promise<any | null> {
  const run = task.workflow_run_id
    ? await ctx.db.get(task.workflow_run_id)
    : null;
  return run &&
    (run.status === "pending" ||
      run.status === "running" ||
      run.status === "paused")
    ? run
    : null;
}

/**
 * The task's bound run, when it is a line run still going: the line's own
 * graph (it started at ground), or whatever graph a trial project runs (a
 * trial graph has no ground station, so ct-59242 and ct-59534 were dropped
 * with their runs left waiting at a gate nobody could answer).
 */
async function liveLineRun(ctx: any, task: any): Promise<any | null> {
  const run = await liveRun(ctx, task);
  if (!run) return null;
  if (isLineRun(run)) return run;
  const project = task.project_id ? await ctx.db.get(task.project_id) : null;
  return project?.line_trial ? run : null;
}

/** The line's own stations that close their cause (line.cast): their close is the run's, not a person's. */
const LINE_CLOSING_STATIONS: ReadonlySet<string> = new Set([
  "drop",
  "dissolve",
]);

/**
 * Whether the close is the run's own station at work. On the shipped line
 * those stations are named. On any other graph a close made while the run
 * stands at a script station is taken as that script's, since a person's
 * close or a regroup's merge finds the run waiting at a gate or inside a
 * session; on a line graph (onefix's close stations, say) only a script
 * station that leads straight to the run's end counts, so a person's drop
 * still stops a run waiting in a long script such as a queue. A trial run it
 * leaves is cancelled by the trial dispatcher's next pass once it waits
 * (lineTrial.dueProblems `orphaned`).
 */
async function closesItself(ctx: any, run: any): Promise<boolean> {
  if (LINE_CLOSING_STATIONS.has(run.current_node_id)) return true;
  if (run.status === "paused") return false;
  const workflow: any = await runWorkflowOf(ctx, run);
  const station = workflow?.nodes?.find(
    (n: any) => n.id === run.current_node_id,
  );
  if (!station?.script) return false;
  if (!isLineRun(run)) return true;
  const exits = new Set(
    (workflow.nodes as any[]).filter((n) => n.type === "exit").map((n) => n.id),
  );
  const next = ((workflow.edges ?? []) as any[]).filter(
    (e) => e.from === station.id,
  );
  return next.length > 0 && next.every((e) => exits.has(e.to));
}

/** What a status move does after its patch, for every writer: the plan's
 *  progress, the status notice, the tasks waiting on it (afterStatusEdges),
 *  and (LE16) a person's close of a cause
 *  stopping its live line run, so the person's decision wins. A move that
 *  changes nothing does none of it. A move with a conversation is a
 *  session's, never a person's. */
export async function afterStatusMove(
  ctx: any,
  task: any,
  next: string | undefined,
  actorUserId: Id<"users">,
  conversationId?: Id<"conversations">,
): Promise<void> {
  if (!next || next === task.status) return;
  if (task.plan_id) await recalcPlanProgress(ctx, task.plan_id, task._id, next);
  await notifyTaskStatus(ctx, actorUserId, task, next, conversationId);
  await afterStatusEdges(ctx, task, next, { actorUserId, conversationId });
  if (task.cause && isTerminalTaskStatus(next)) {
    const closed = await ctx.db.get(task._id);
    await withdrawClosedProblemAsks(
      ctx,
      task,
      closed?.cause?.dissolved?.note ??
        `the problem was ${next === "done" ? "closed as done" : next}`,
      Date.now(),
    );
  }
  if (!conversationId && isTerminalTaskStatus(next)) {
    const run = await liveLineRun(ctx, task);
    if (run && !(await closesItself(ctx, run)))
      await cancelCore(
        ctx,
        run,
        Date.now(),
        `Stopped: the problem was ${next === "dropped" ? "dropped" : "closed"} by a person`,
      );
  }
}

/**
 * One status move by a writer that is not a person at a form: the line's
 * runs, its watch, and the batch update. It writes the stamps a status
 * carries (closed_at on a close, cleared with resolved_at on a reopen, the
 * attempt on a start, the minutes on a done), the history row, and then
 * afterStatusMove, so the move lands in the task's history and notifies the
 * way a person's change does. `extra` rides the same patch. Returns whether
 * the status moved.
 */
export async function moveTaskStatus(
  ctx: any,
  task: any,
  next: (typeof TASK_STATUS_CATEGORIES)[number],
  // `closedAt`: when the work actually closed, for a writer that records it
  // after the fact (the line's run end and its repair stamp the ship's time).
  o: {
    actorUserId: Id<"users">;
    actorType?: "user" | "agent" | "system";
    now?: number;
    closedAt?: number;
    conversationId?: Id<"conversations">;
    extra?: Record<string, any>;
  },
): Promise<boolean> {
  const now = o.now ?? Date.now();
  const moved = next !== task.status;
  const updates: Record<string, any> = { ...(o.extra ?? {}), updated_at: now };
  if (moved) {
    // A category change orphans a custom-status refinement (resolveStatusWrite).
    Object.assign(updates, { status: next, status_id: undefined });
    if (isTerminalTaskStatus(next)) updates.closed_at = o.closedAt ?? now;
    else if (isTerminalTaskStatus(task.status))
      Object.assign(updates, { closed_at: undefined, resolved_at: undefined });
    if (next === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
      if (!task.started_at) updates.started_at = now;
    }
    if (next === "done" && task.started_at)
      updates.actual_minutes = Math.round((now - task.started_at) / 60000);
    await recordTaskChange(
      ctx,
      task._id,
      {
        user_id: o.actorUserId,
        actor_type: o.actorType ?? "system",
        conversation_id: o.conversationId,
      },
      [["status", task.status, next]],
      now,
    );
  }
  const revokedConvId = await releaseTaskClaimIfHeld(ctx, task._id);
  if (
    next === "open" ||
    next === "done" ||
    next === "dropped" ||
    next === "backlog"
  ) {
    await releaseBoundSessions(ctx, task, o.conversationId, revokedConvId);
  } else if (revokedConvId) {
    await releaseBoundSessions(ctx, task, revokedConvId);
  }
  const before = { ...task };
  await patchTask(ctx, task, updates);
  await afterStatusMove(ctx, before, next, o.actorUserId, o.conversationId);
  return moved;
}

/**
 * At retire, a role's open tasks go to the role that owns their work now, by
 * the one ownership rule (org-staffing.md S26: the area falls back to the
 * wider role), else up the chain to whoever it reported to
 * (org-roles-run-work.md R5): the work is still the company's, and whoever
 * takes it answers for it now, told the way any assignment is. Closed tasks
 * keep the retired role's name; the chain still reads them under the same
 * person (@codecast/org/orgAssignee). Called by orgRoles.performRetireRole.
 */
export async function handOpenTasksUpChain(
  ctx: any,
  role: any,
  actorUserId: Id<"users">,
): Promise<number> {
  const up = role.reports_to;
  const chain =
    up?.kind === "user"
      ? String(up.user_id)
      : up?.kind === "role"
        ? String(up.role_id)
        : String(role.host_user_id);
  const remaining = (await allRolesInBoundary(ctx, role)).filter(
    (r) => String(r._id) !== String(role._id),
  );
  const held: any[] = await ctx.db
    .query("tasks")
    .withIndex("by_assignee_updated", (q: any) =>
      q.eq("assignee", String(role._id)),
    )
    .collect();
  const now = Date.now();
  let moved = 0;
  for (const task of held) {
    if (task.status === "done" || task.status === "dropped") continue;
    const owner = ownerOf(await taskWork(ctx, task), remaining);
    await handTask(
      ctx,
      task,
      owner.kind === "owner" ? String(owner.role._id) : chain,
      actorUserId,
      `${role.name} (retired)`,
      now,
    );
    moved++;
  }
  return moved;
}

/** One task changes hands between the roles and people of the org: a history
 *  row, the patch, and the assignment told the way any assignment is. A
 *  retire's hand back and a takeover's hand over (orgInit.takeOverSessions)
 *  both go through here. */
export async function handTask(
  ctx: any,
  task: any,
  to: string,
  actorUserId: Id<"users">,
  actorName: string,
  now = Date.now(),
): Promise<void> {
  await recordTaskChange(
    ctx,
    task._id,
    byUser(actorUserId),
    [["assignee", task.assignee, to]],
    now,
  );
  await patchTask(ctx, task, { assignee: to, updated_at: now });
  await announceAssignment(ctx, {
    task,
    assignee: to,
    actorUserId,
    actorName,
    via: "human",
  });
}

/**
 * The hold (docs/architecture/the-line.md L5). A pending, blocking decision
 * bound to the task whose station equals the task's current status keeps
 * the task there. Returns that decision when the write would move the task
 * (a new category, or a new team status inside the category), else null.
 * The two status mutations apply the rule before any write: a session actor
 * is refused, a person moves past it and a note comment names the decision.
 * Server internal patches (a run's node start and end, pauseAtGate) do not
 * pass through here and are not held. Nothing is written for a hold: the
 * task page derives "held at" from the open decisions by_task.
 */
export async function holdingDecisionFor(
  ctx: any,
  task: any,
  nextStatus: string | undefined,
  nextStatusId?: { set: boolean; value?: string },
): Promise<any | null> {
  const categoryMoves = !!nextStatus && nextStatus !== task.status;
  const refinementMoves =
    !!nextStatusId?.set &&
    (nextStatusId.value ?? undefined) !== (task.status_id ?? undefined);
  if (!categoryMoves && !refinementMoves) return null;
  const station = task.status_id ?? task.status;
  const pending: any[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_task", (q: any) =>
      q.eq("task_id", task._id).eq("status", "pending"),
    )
    .collect();
  return pending.find((d) => d.blocking && d.station === station) ?? null;
}

// The refusal a session actor gets (L5). The decision is a person's to
// answer, never the session's, so the text names what the session can do:
// record its work on the task and park on the decision.
export function heldError(hold: any, task?: { short_id?: string }): Error {
  const ref = hold.short_id ?? hold._id;
  const id = task?.short_id ?? "<task>";
  return new Error(
    `Held at ${hold.station} by ${ref}, a decision for a person to answer: the task moves once they do. Record your work with \`cast task comment ${id} - -t review\` (or \`cast task handoff\`, which keeps the evidence and leaves the task here), then park with \`cast task dep ${id} --blocked-by ${ref}\``,
  );
}

// The note a person leaves when moving a held task past its open decision (L5).
export async function noteMovedPastHold(
  ctx: any,
  task: any,
  hold: any,
  nextStatus: string,
  author: string,
  actorId?: Id<"users">,
) {
  const ref = hold.short_id ?? hold._id;
  await insertTaskComment(
    ctx,
    task._id,
    {
      author,
      text: `Moved past ${ref} (held at ${hold.station}) to ${nextStatus}; the decision stays open.`,
      comment_type: "note",
    },
    actorId,
  );
}

/**
 * Cascade-close the subtree ids guardParentClose returned. `parent` scopes the
 * writes: only same-workspace descendants are touched (a pre-guard row could
 * carry a cross-workspace edge — `create` once wrote parent_id raw — and a
 * user must not close another workspace's task through --cascade). Each closed
 * child also releases any session bound to it, matching the single-task path.
 */
export async function cascadeClose(
  ctx: any,
  ids: Id<"tasks">[],
  newStatus: string,
  userId: Id<"users">,
  parent: any,
) {
  const now = Date.now();
  const scope = workspaceForResource(parent);
  const closing = new Set([String(parent._id), ...ids.map(String)]);
  for (const id of ids) {
    const t: any = await ctx.db.get(id);
    if (!t || !isSameWorkspace(t, scope)) continue;
    // status_id cleared: the cascade moves the subtree to a terminal category,
    // so any custom-status refinement from the old category is stale.
    await patchTask(ctx, t, {
      status: newStatus,
      status_id: undefined,
      ...(t.status === newStatus ? {} : { closed_at: now }),
      updated_at: now,
    });
    await releaseBoundSessions(ctx, t);
    await recordTaskChange(
      ctx,
      id,
      { user_id: userId, actor_type: "system" },
      [["status", t.status, newStatus]],
      now,
    );
    // The parent's own release (afterStatusMove) runs after this one.
    await afterStatusEdges(ctx, t, newStatus, {
      actorUserId: userId,
      closingLater: parent,
      closing,
    });
  }
}

export const isBlockedExecution = (s: string | undefined) =>
  s === "blocked" || s === "needs_context";

// Clearing a block is a retry (the-line.md L9). The line starts only tasks
// with no workflow_run_id, so a run that has ended is let go with the flag;
// otherwise the task sits open and the line never starts it again. A live run
// keeps its binding. The reason and the retry budget reset with it.
export async function releaseBlockFields(
  ctx: { db: any },
  task: any,
): Promise<Record<string, any>> {
  const fields: Record<string, any> = {
    execution_concerns: undefined,
    retry_count: 0,
  };
  if (task.workflow_run_id) {
    const run = await ctx.db.get(task.workflow_run_id);
    if (!run || run.status === "failed" || run.status === "completed") {
      fields.workflow_run_id = undefined;
      fields.workflow_node_id = undefined;
    }
  }
  return fields;
}
