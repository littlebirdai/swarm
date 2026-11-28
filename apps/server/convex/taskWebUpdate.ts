import { getAuthUserId } from "@convex-dev/auth/server";
import { v, type ObjectType } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./functions";
import {
  afterDuplicateCleared,
  redirectDependents,
  requireLiveReplacement,
} from "./taskLinks";
import {
  canAccessTask,
  requireAccessibleProject,
  requireSameWorkspace,
  requireTeamMembership,
  workspaceForResource,
} from "./lib/access";
import { notFound } from "./lib/auth";
import { assigneeScopeOf, resolveAssigneeStr } from "./lib/taskAssignees";
import { revokeWebTaskClaim } from "./lib/taskClaims";
import { requireAccessibleTaskByToken } from "./lib/taskClaimLifecycle";
import { executionHintArgs, executionHintPatch } from "./lib/taskExecution";
import { groundArgs, groundPatch, resolveFromCall } from "./lib/taskFields";
import { byUser, recordTaskChange } from "./lib/taskHistory";
import {
  announceAssignment,
  schedulePushKeptTask,
} from "./lib/taskNotifications";
import { releaseBoundSessions } from "./lib/taskOwner";
import { resolveStatusWrite } from "./lib/taskStatuses";
import {
  guardParentClose,
  reconcilePlanMembership,
  resolveParentTask,
  rollUpParentStart,
} from "./lib/taskSubtasks";
import {
  afterStatusMove,
  cascadeClose,
  holdingDecisionFor,
  isBlockedExecution,
  noteMovedPastHold,
  releaseBlockFields,
} from "./lib/taskTransitions";
import { patchTask } from "./lib/taskWrite";

const webUpdateArgs = {
  short_id: v.string(),
  status: v.optional(v.string()),
  // Team status id refining the category; "" clears back to the default.
  status_id: v.optional(v.string()),
  priority: v.optional(v.string()),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  assignee: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  project_id: v.optional(v.string()),
  project_path: v.optional(v.string()),
  execution_status: v.optional(v.string()),
  triage_status: v.optional(v.string()),
  // Short id of the parent task; empty string detaches back to the top level.
  parent: v.optional(v.string()),
  // Close-guard resolution when closing a parent with open subtasks.
  subtask_resolution: v.optional(
    v.union(v.literal("cascade"), v.literal("only_parent")),
  ),
  // Manual list rank (fractional midpoints; see schema).
  sort_order: v.optional(v.number()),
  // Short id of the canonical task; empty string clears the link.
  duplicate_of: v.optional(v.string()),
  // A person's review verdict from the board (the-line.md L3). A web write
  // has no session behind it, so the verdict counts as outside every role.
  review_verdict: v.optional(
    v.union(v.literal("approve"), v.literal("changes"), v.literal("reject")),
  ),
  review_note: v.optional(v.string()),
  // The call this task came out of (a call ref); "" clears.
  from_call: v.optional(v.string()),
  // A person answering the ground step's question from the line (LE5): ready
  // confirms the problem; "" clears a field.
  readiness: groundArgs.readiness,
  readiness_note: groundArgs.readiness_note,
  // model, effort and ephemeral (TG8, TG9); "" clears model or effort.
  ...executionHintArgs,
};

export const webUpdate = mutation({
  args: webUpdateArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await updateTaskAs(ctx, userId, args);
  },
});

/** Update a task as `userId`, the way the web's update does: access, the
 *  status write, history, the close guard and notifications. The hosted
 *  assistant's update_task runs this same path. */
export async function updateTaskAs(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: ObjectType<typeof webUpdateArgs>,
) {
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
    .first();
  if (!task || !(await canAccessTask(ctx, userId, task)))
    throw new Error("Task not found");

  // The category every status side effect below keys on. args.status alone
  // is not enough: a status_id-only write still moves the category.
  const statusWrite = await resolveStatusWrite(
    ctx,
    task.team_id,
    task.status,
    args,
  );
  const nextStatus = statusWrite.status;

  const now = Date.now();
  const updates: any = { updated_at: now };
  if (statusWrite.statusId.set) updates.status_id = statusWrite.statusId.value;
  // Reparent through the single entry point (access, workspace, cycle,
  // depth). Same semantics as the CLI path: "" detaches.
  if (args.parent !== undefined) {
    if (!args.parent) {
      updates.parent_id = undefined;
    } else {
      // The child's ACCESS key, never its routing team: readiness reads a
      // parent only there.
      const parent = await resolveParentTask(ctx, userId, args.parent, {
        workspace: workspaceForResource(task),
        child: task,
      });
      updates.parent_id = parent._id;
    }
  }
  if (nextStatus) updates.status = nextStatus;
  if (args.priority) updates.priority = args.priority;
  if (args.title) {
    updates.title = args.title;
    updates.short_title = undefined;
  }
  if (args.description !== undefined) updates.description = args.description;
  const fromCall = await resolveFromCall(ctx, userId, args.from_call);
  if (fromCall !== undefined) updates.from_call = fromCall ?? undefined;
  if (args.assignee !== undefined) {
    updates.assignee =
      (await resolveAssigneeStr(
        ctx,
        args.assignee,
        userId,
        await assigneeScopeOf(ctx, task),
      )) || args.assignee;
  }
  if (args.labels) updates.labels = args.labels;
  if (args.project_id !== undefined) {
    if (!args.project_id) {
      updates.project_id = undefined;
    } else {
      const projectId = ctx.db.normalizeId("projects", args.project_id);
      if (!projectId) notFound("Project not found");
      const project = await requireAccessibleProject(ctx, userId, projectId);
      const taskWorkspace = task.team_id
        ? { type: "team" as const, teamId: task.team_id }
        : { type: "personal" as const, userId: task.user_id };
      requireSameWorkspace(project, taskWorkspace, "project");
      updates.project_id = projectId;
    }
  }
  if (args.project_path !== undefined)
    updates.project_path = args.project_path || undefined;
  if (args.execution_status !== undefined)
    updates.execution_status = args.execution_status || undefined;
  if (
    args.execution_status === "" &&
    isBlockedExecution(task.execution_status)
  ) {
    Object.assign(updates, await releaseBlockFields(ctx, task));
  }
  if (args.sort_order !== undefined) updates.sort_order = args.sort_order;
  Object.assign(
    updates,
    executionHintPatch(args),
    groundPatch({
      readiness: args.readiness,
      readiness_note: args.readiness_note,
    }),
  );
  if (args.duplicate_of !== undefined) {
    if (!args.duplicate_of) {
      updates.duplicate_of = undefined;
    } else {
      // The canonical task must exist, be visible to this user, and not be
      // the task itself — a dangling or self link renders as a dead chip.
      const canonical = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.duplicate_of!))
        .first();
      if (!canonical || !(await canAccessTask(ctx, userId, canonical)))
        notFound("Canonical task not found");
      if (canonical._id === task._id)
        throw new Error("A task can't duplicate itself");
      requireSameWorkspace(
        canonical,
        workspaceForResource(task),
        "canonical task",
      );
      updates.duplicate_of = args.duplicate_of;
      // A duplicate is dropped, so what waits on it waits on the canonical
      // (TG5). A done task's dependents were already released by real work.
      // A re-point leaves what the first mark moved on the first canonical,
      // which is still open work; clearing the mark takes back only this one's.
      if (args.duplicate_of !== task.duplicate_of && task.status !== "done") {
        requireLiveReplacement(canonical, "mark it a duplicate of");
        await redirectDependents(
          ctx,
          userId,
          byUser(userId),
          task,
          canonical,
          `${task.short_id} duplicate of ${canonical.short_id}`,
        );
      }
    }
  }
  if (args.triage_status) {
    updates.triage_status = args.triage_status;
    if (args.triage_status === "active") updates.promoted = true;
  }

  if (
    (nextStatus === "done" || nextStatus === "dropped") &&
    nextStatus !== task.status
  ) {
    updates.closed_at = now;
  }
  if (nextStatus === "in_progress") {
    updates.attempt_count = (task.attempt_count || 0) + 1;
    updates.last_attempted_at = now;
  }
  if (args.review_verdict) {
    updates.review_verdict = {
      verdict: args.review_verdict,
      at: now,
      ...(args.review_note ? { note: args.review_note } : {}),
    };
  } else if (nextStatus === "done" && task.status === "in_review") {
    // Dragging a task out of In Review into Done is the person's approve:
    // that column holds work waiting on exactly this judgement.
    updates.review_verdict = {
      verdict: "approve",
      at: now,
      note: "closed from the board",
    };
  }

  // Close-guard: refuses done/dropped on a parent with open subtasks unless
  // resolved; returns the subtree to cascade-close. Runs before any write.
  const cascadeIds = await guardParentClose(
    ctx,
    task,
    nextStatus,
    args.subtask_resolution,
  );
  // A person on the board moves past a hold (the-line.md L5); the note
  // after the write names the decision it moved past.
  const hold = await holdingDecisionFor(
    ctx,
    task,
    nextStatus,
    statusWrite.statusId,
  );

  const resolvedAssignee = updates.assignee || args.assignee;
  // Record history for changed fields
  const trackFields: [string, any, any][] = [];
  if (nextStatus && nextStatus !== task.status)
    trackFields.push(["status", task.status, nextStatus]);
  if (args.priority && args.priority !== task.priority)
    trackFields.push(["priority", task.priority, args.priority]);
  if (args.title && args.title !== task.title)
    trackFields.push(["title", task.title, args.title]);
  if (args.assignee !== undefined && resolvedAssignee !== task.assignee)
    trackFields.push(["assignee", task.assignee || "", resolvedAssignee || ""]);
  if (updates.review_verdict)
    trackFields.push([
      "review_verdict",
      task.review_verdict?.verdict ?? "",
      updates.review_verdict.verdict,
    ]);
  if (
    args.execution_status !== undefined &&
    args.execution_status !== (task.execution_status || "")
  )
    trackFields.push([
      "execution_status",
      task.execution_status || "",
      args.execution_status || "",
    ]);
  const parentChanged =
    "parent_id" in updates &&
    String(updates.parent_id ?? "") !== String(task.parent_id ?? "");
  if (parentChanged)
    trackFields.push(["parent", task.parent_id ?? "", updates.parent_id ?? ""]);
  if (args.labels) trackFields.push(["labels", task.labels, args.labels]);

  await recordTaskChange(ctx, task._id, byUser(userId), trackFields, now);

  await revokeWebTaskClaim(
    ctx,
    task._id,
    nextStatus,
    updates.review_verdict?.verdict ?? args.review_verdict,
    (claimConvId) => releaseBoundSessions(ctx, task, claimConvId),
  );
  await patchTask(ctx, task, updates);
  await schedulePushKeptTask(ctx, task, updates);
  if (args.duplicate_of === "")
    await afterDuplicateCleared(ctx, userId, task, nextStatus ?? task.status);
  if (hold)
    await noteMovedPastHold(
      ctx,
      task,
      hold,
      nextStatus ?? task.status,
      (await ctx.db.get(userId))?.name || "unknown",
      userId,
    );
  if (cascadeIds.length > 0)
    await cascadeClose(ctx, cascadeIds, nextStatus!, userId, task);
  await rollUpParentStart(
    ctx,
    {
      ...task,
      parent_id: "parent_id" in updates ? updates.parent_id : task.parent_id,
    },
    nextStatus,
  );
  if (parentChanged) {
    await reconcilePlanMembership(
      ctx,
      task._id,
      task.plan_id as Id<"plans"> | undefined,
      !!updates.parent_id,
    );
  }

  await afterStatusMove(ctx, task, nextStatus, userId);
  if (args.assignee !== undefined && resolvedAssignee !== task.assignee) {
    await announceAssignment(ctx, {
      task,
      assignee: resolvedAssignee,
      actorUserId: userId,
      via: "human",
    });
  }

  return { success: true };
}

// Promote a derived (mined) task to a real/promoted task
export const promote = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { task } = await requireAccessibleTaskByToken(
      ctx,
      args.api_token,
      args.short_id,
    );

    await ctx.db.patch(task._id, {
      promoted: true,
      triage_status: "active" as const,
      updated_at: Date.now(),
    });
    return { success: true };
  },
});

// Promote a derived task (web auth)
export const webPromote = mutation({
  args: {
    short_id: v.string(),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, userId, task)))
      throw new Error("Task not found");

    await ctx.db.patch(task._id, {
      promoted: true,
      triage_status: "active" as const,
      updated_at: Date.now(),
    });
    return { success: true };
  },
});

// Support path: delete a task outright with its comments and history
// (apps/server/run.sh). The product's own verb is "dropped"; this is for a
// row its owner wants gone from the database.
export const adminDeleteTask = internalMutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) return { found: false };
    for (const table of ["task_comments", "task_history"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_task_id", (q: any) => q.eq("task_id", task._id))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    const taskClaims = await ctx.db
      .query("claims")
      .withIndex("by_task_kind", (q) => q.eq("task_id", task._id))
      .collect();
    for (const row of taskClaims) await ctx.db.delete(row._id);
    await ctx.db.delete(task._id);
    return {
      found: true,
      title: task.title,
      user_id: task.user_id,
      created_from: task.created_from_conversation ?? null,
      conversation_ids: task.conversation_ids ?? [],
    };
  },
});
