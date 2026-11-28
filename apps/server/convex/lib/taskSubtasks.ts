import type { Id } from "../_generated/dataModel";
import { MAX_TASK_DEPTH, isActiveTask } from "@codecast/tasks";
import {
  canAccessTask,
  isSameWorkspace,
  requireSameWorkspace,
  workspaceForResource,
} from "./access";
import { notFound } from "./auth";
import { recordTaskChange } from "./taskHistory";
import { patchTask } from "./taskWrite";

export async function recalcPlanProgress(
  ctx: any,
  planId: Id<"plans">,
  updatedTaskId: Id<"tasks">,
  newStatus: string,
) {
  const plan = await ctx.db.get(planId);
  if (!plan || !plan.task_ids) return;
  const updatedTask = await ctx.db.get(updatedTaskId);
  const containsUpdatedTask = plan.task_ids.some(
    (id: Id<"tasks">) => String(id) === String(updatedTaskId),
  );
  if (
    !updatedTask ||
    !containsUpdatedTask ||
    !isSameWorkspace(updatedTask, workspaceForResource(plan))
  )
    return;

  let total = 0,
    done = 0,
    in_progress = 0,
    open = 0;
  for (const tid of plan.task_ids) {
    const t =
      tid === updatedTaskId
        ? { ...updatedTask, status: newStatus }
        : await ctx.db.get(tid);
    // Subtasks never count toward plan progress — the parent is the plan's
    // unit of work. New subtasks are kept out of task_ids at create time; this
    // guard also excludes any that landed there before that rule existed, so
    // one agent decomposition can never inflate a plan bar or auto-close it.
    if (t && !t.parent_id && isSameWorkspace(t, workspaceForResource(plan))) {
      total++;
      if (t.status === "done") done++;
      else if (t.status === "in_progress" || t.status === "in_review")
        in_progress++;
      else if (t.status === "open" || t.status === "backlog") open++;
    }
  }

  const now = Date.now();
  const updates: any = {
    progress: { total, done, in_progress, open },
    updated_at: now,
  };
  if (done > 0 && in_progress === 0 && open === 0 && plan.status !== "done") {
    updates.status = "done";
  }
  await ctx.db.patch(plan._id, updates);
}

/**
 * Keep plan.task_ids honest when a task's subtask-ness changes (reparent or
 * detach). A subtask is never in task_ids (the parent is the plan's unit of
 * work); a top-level task with a plan always is. Called after the parent_id
 * patch, with the FINAL parent state. Recalcs plan progress so the bar and the
 * auto-done flag never drift off a stale total.
 */
export async function reconcilePlanMembership(
  ctx: any,
  taskId: Id<"tasks">,
  planId: Id<"plans"> | undefined,
  nowSubtask: boolean,
) {
  if (!planId) return;
  const plan: any = await ctx.db.get(planId);
  if (!plan) return;
  const ids: any[] = plan.task_ids || [];
  const has = ids.some((id: any) => String(id) === String(taskId));
  const nextIds = nowSubtask
    ? ids.filter((id: any) => String(id) !== String(taskId))
    : has
      ? ids
      : [...ids, taskId];

  // Recompute progress directly over the final membership: recalcPlanProgress
  // early-returns for a task that just LEFT task_ids, so it can't be reused for
  // a removal. Subtasks are excluded (the parent is the plan's unit of work),
  // matching recalcPlanProgress / plans.recalcProgress.
  let total = 0,
    done = 0,
    in_progress = 0,
    open = 0;
  const scope = workspaceForResource(plan);
  for (const tid of nextIds) {
    const t: any = await ctx.db.get(tid);
    if (
      !t ||
      t.status === "dropped" ||
      t.parent_id ||
      !isSameWorkspace(t, scope)
    )
      continue;
    total++;
    if (t.status === "done") done++;
    else if (t.status === "in_progress" || t.status === "in_review")
      in_progress++;
    else if (t.status === "open" || t.status === "backlog") open++;
  }
  const updates: any = {
    task_ids: nextIds,
    progress: { total, done, in_progress, open },
    updated_at: Date.now(),
  };
  if (total > 0 && done === total && plan.status !== "done")
    updates.status = "done";
  await ctx.db.patch(planId, updates);
}

// ---------------------------------------------------------------------------
// Subtasks (tasks.parent_id)
//
// The column and the by_parent_id index shipped long ago but nothing ever
// resolved or validated a parent: `create` wrote `args.parent_id as any`, so a
// caller passing a short id wrote a string into an Id("tasks") field and the
// insert failed its validator. These helpers are the single entry point for
// setting a parent, from every surface (CLI create/update, web create/update).
//
// Three rules, all enforced here:
//   1. The parent must be a task the caller can access.
//   2. Parent and child live in the SAME workspace — a nesting edge is a
//      relationship, and relationships never join two authorization domains
//      (the same rule addDep applies to blocked_by/blocks).
//   3. No cycles. The chain is walked upward from the proposed parent; if the
//      child appears in it, the move is refused.
// ---------------------------------------------------------------------------

// Ancestor walks are bounded so a pre-existing cycle (or a pathological chain)
// can never spin a mutation until the isolate is killed.
export const MAX_TASK_ANCESTOR_WALK = 64;

/** A task's ancestors, nearest first. Stops at the root, a cycle, or the cap. */
export async function taskAncestorIds(
  ctx: any,
  task: { parent_id?: Id<"tasks"> },
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: Id<"tasks"> | undefined = task.parent_id;
  for (let i = 0; cursor && i < MAX_TASK_ANCESTOR_WALK; i++) {
    const key = String(cursor);
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(key);
    const parent: any = await ctx.db.get(cursor);
    if (!parent) break;
    cursor = parent.parent_id;
  }
  return chain;
}

/**
 * Resolve a parent reference (short id like "ct-42278", or a raw task id) into
 * a parent document, enforcing access, workspace containment and acyclicity.
 * `child` is the task being reparented — omitted at create time, when there is
 * no row yet and therefore no cycle to close.
 */
export async function resolveParentTask(
  ctx: any,
  userId: Id<"users">,
  ref: string,
  opts: { workspace: any; child?: { _id: Id<"tasks">; short_id: string } },
): Promise<any> {
  const parent =
    (await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", ref))
      .first()) ??
    (await (async () => {
      const id = ctx.db.normalizeId("tasks", ref);
      return id ? await ctx.db.get(id) : null;
    })());
  if (!parent || !(await canAccessTask(ctx, userId, parent)))
    notFound("Parent task not found");
  requireSameWorkspace(parent, opts.workspace, "parent task");

  const ancestors = await taskAncestorIds(ctx, parent);
  if (opts.child) {
    if (String(parent._id) === String(opts.child._id)) {
      throw new Error("A task cannot be its own parent");
    }
    if (ancestors.includes(String(opts.child._id))) {
      throw new Error(
        `Cycle: ${parent.short_id} is already below ${opts.child.short_id}`,
      );
    }
  }

  // Depth is a product cap, not just a render clamp: the views emphasise the
  // top levels, so writes deeper than the UI can express are refused with
  // advice instead of silently flattening on screen. Re-parenting a task that
  // has its own subtree must fit the whole subtree under the cap.
  const childHeight = opts.child
    ? await taskSubtreeHeight(ctx, opts.child._id)
    : 0;
  const newDepth = ancestors.length + 1 + childHeight;
  if (newDepth > MAX_TASK_DEPTH) {
    throw new Error(
      `Too deep: ${parent.short_id} sits ${ancestors.length} level(s) down and the move needs ${newDepth} (max ${MAX_TASK_DEPTH}). ` +
        `Nest under a higher-level task, or promote this work to a plan.`,
    );
  }
  return parent;
}

/**
 * Height of a task's subtree: 0 for a leaf, 1 with children, 2 with
 * grandchildren. Only the depth cap needs this, and the cap is tiny
 * (MAX_TASK_DEPTH), so we stop descending once height already exceeds it —
 * that both bounds the walk and avoids the pathological-fan-out miscount where
 * a node budget could exit mid-level and under-report height (letting a move
 * slip past the cap). Returns Infinity if a level can't be fully expanded
 * within the budget, so resolveParentTask refuses rather than guesses.
 */
async function taskSubtreeHeight(
  ctx: any,
  taskId: Id<"tasks">,
  maxNodes = 2000,
): Promise<number> {
  let height = 0;
  let frontier: Id<"tasks">[] = [taskId];
  let visited = 0;
  while (frontier.length > 0) {
    const next: Id<"tasks">[] = [];
    for (const id of frontier) {
      if (visited >= maxNodes) return Infinity; // budget exhausted mid-level → unknown, refuse
      const children = await ctx.db
        .query("tasks")
        .withIndex("by_parent_id", (q: any) => q.eq("parent_id", id))
        .collect();
      visited += children.length;
      for (const c of children) next.push(c._id);
    }
    if (next.length === 0) break;
    height += 1;
    if (height > MAX_TASK_DEPTH) return height; // already too deep; no need to descend further
    frontier = next;
  }
  return height;
}

// ---------------------------------------------------------------------------
// Close-guard + start rollup: the two status rules every write surface shares.
// ---------------------------------------------------------------------------

/** Direct children still open (active and unfinished). */
export async function openDirectSubtasks(
  ctx: any,
  taskId: Id<"tasks">,
): Promise<any[]> {
  const children = await ctx.db
    .query("tasks")
    .withIndex("by_parent_id", (q: any) => q.eq("parent_id", taskId))
    .collect();
  return children.filter(
    (c: any) =>
      isActiveTask(c) && c.status !== "done" && c.status !== "dropped",
  );
}

/**
 * The close-guard (never auto-close): moving a parent to done/dropped with
 * open subtasks is refused unless the caller resolves it — "cascade" closes
 * the open subtree with the parent, "only_parent" closes just the parent and
 * leaves the children where they are. Lives in the mutation path so the CLI
 * (`cast task done --cascade | --only-parent`) and every web surface hit the
 * same rule; the web dialog is just one client of this refusal.
 * Returns the ids to cascade-close alongside the parent.
 */
export async function guardParentClose(
  ctx: any,
  task: any,
  newStatus: string | undefined,
  resolution: string | undefined,
): Promise<Id<"tasks">[]> {
  if (newStatus !== "done" && newStatus !== "dropped") return [];
  const open = await openDirectSubtasks(ctx, task._id);
  if (open.length === 0 || resolution === "only_parent") return [];
  if (resolution === "cascade") {
    const out: Id<"tasks">[] = [];
    const queue = [...open];
    let guard = 0;
    while (queue.length > 0 && guard++ < 500) {
      const cur: any = queue.shift();
      out.push(cur._id);
      queue.push(...(await openDirectSubtasks(ctx, cur._id)));
    }
    return out;
  }
  const ids = open.map((c: any) => c.short_id).join(", ");
  throw new Error(
    `${task.short_id} has ${open.length} open subtask${open.length === 1 ? "" : "s"} (${ids}). ` +
      `Close them first, or pass --cascade to close them too, or --only-parent to close just this task.`,
  );
}

/**
 * One-way honesty rollup: the first subtask entering in_progress/in_review
 * flips an open/backlog ancestor chain to in_progress, so a parent never sits
 * "open" while work visibly advances under it. Never runs the other way and
 * never closes anything.
 */
export async function rollUpParentStart(
  ctx: any,
  task: any,
  newStatus: string | undefined,
) {
  if (newStatus !== "in_progress" && newStatus !== "in_review") return;
  const now = Date.now();
  let cursor: Id<"tasks"> | undefined = task.parent_id;
  for (let hops = 0; cursor && hops < MAX_TASK_ANCESTOR_WALK; hops++) {
    const parent: any = await ctx.db.get(cursor);
    if (!parent) break;
    if (parent.status !== "open" && parent.status !== "backlog") break;
    await patchTask(ctx, parent, {
      status: "in_progress",
      // The old refinement belonged to the open/backlog category; stale now.
      status_id: undefined,
      updated_at: now,
      last_attempted_at: now,
      attempt_count: (parent.attempt_count || 0) + 1,
    });
    await recordTaskChange(
      ctx,
      parent._id,
      { user_id: task.user_id, actor_type: "system" },
      [["status", parent.status, "in_progress"]],
      now,
    );
    // A top-level parent may sit on a plan; keep the plan bar honest.
    if (parent.plan_id && !parent.parent_id) {
      await recalcPlanProgress(ctx, parent.plan_id, parent._id, "in_progress");
    }
    cursor = parent.parent_id;
  }
}
