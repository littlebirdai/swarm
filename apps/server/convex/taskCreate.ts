import { getAuthUserId } from "@convex-dev/auth/server";
import { v, type ObjectType } from "convex/values";
import { isHumanOrigin } from "@codecast/tasks";
import { isTerminalTaskStatus } from "@codecast/tasks/statuses";
import type { Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { createDataContext, createWorkContext } from "./data";
import { nextShortId } from "./counters";
import { predictionPatch } from "./predictions";
import { foundDuringForCreate } from "./taskLinks";
import { addWaitsAtCreate } from "./taskWaits";
import {
  canAccessPlan,
  canAccessTask,
  requireAccessibleProject,
  requireSameWorkspace,
  resolveSessionConversation,
} from "./lib/access";
import { notFound } from "./lib/auth";
import { projectFromPlan } from "./lib/planFiling";
import {
  boundaryOfWorkspace,
  defaultSessionOwner,
  resolveAssigneeStr,
} from "./lib/taskAssignees";
import { patchDepMirror } from "./lib/taskDeps";
import { executionHintArgs, executionHintPatch } from "./lib/taskExecution";
import { resolveFromCall } from "./lib/taskFields";
import { assertDependencyEdges, storedGraphRefs } from "./lib/taskGraph";
import { recordTaskChange } from "./lib/taskHistory";
import {
  announceAssignment,
  cliVia,
  schedulePushNewTask,
  subscribeUser,
} from "./lib/taskNotifications";
import { resolveStatusWrite } from "./lib/taskStatuses";
import { resolveParentTask, rollUpParentStart } from "./lib/taskSubtasks";

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    // `cast task create --from-call cl-42`: the call this task came out of.
    from_call: v.optional(v.string()),
    client_key: v.optional(v.string()),
    // `cast task create --team <name>|personal`: an explicit workspace wins
    // over the session's team and the directory rule (writes are explicit).
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    description: v.optional(v.string()),
    task_type: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    project_id: v.optional(v.string()),
    parent_id: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    blocked_by: v.optional(v.array(v.string())),
    // TG2/TG3: blocker refs that are not tasks (#42, sd-4, 2h), added in this
    // mutation (addWaitsAtCreate); repository resolves a bare #42.
    waits: v.optional(v.array(v.string())),
    repository: v.optional(v.string()),
    time_zone: v.optional(v.string()),
    // TG5: the task this was found while working on; "none" skips the default
    // (the task the creating session is bound to).
    found_during: v.optional(v.string()),
    source: v.optional(v.string()),
    confidence: v.optional(v.number()),
    // Agent-created tasks are internal by default; promoted:true puts the task
    // on the human's default board (same field the triage promote flow sets).
    promoted: v.optional(v.boolean()),
    conversation_id: v.optional(v.string()),
    insight_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    max_retries: v.optional(v.number()),
    // model, effort and ephemeral (TG8, TG9).
    ...executionHintArgs,
    verify_with: v.optional(v.string()),
    max_visits: v.optional(v.number()),
    retry_target: v.optional(v.string()),
    thread_id: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    condition: v.optional(v.string()),
    project_path: v.optional(v.string()),
    steps: v.optional(
      v.array(
        v.object({
          title: v.string(),
          done: v.optional(v.boolean()),
          verification: v.optional(v.string()),
        }),
      ),
    ),
    acceptance_criteria: v.optional(v.array(v.string())),
    estimated_minutes: v.optional(v.number()),
    // A line the assignee's notice carries after the task (`cast route` says
    // how to answer), and the session the notice comes from when that is not
    // the task's origin, so the one notice is the whole hand-off.
    assignment_note: v.optional(v.string()),
    assignment_from: v.optional(v.string()),
    // `cast task create --goal-ref in-9:key --predict "<line>"` (predictions.ts).
    goal_ref: v.optional(v.string()),
    predict: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    // Blockers are stored canonical, and a wait-shaped one becomes a wait.
    args = { ...args, ...storedGraphRefs(ctx, args, { waits: true }) };

    // The session the task came from links it and, when team visible, hands
    // it its team (createWorkContext).
    const { db, conversation: originConv } = await createWorkContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
      workspace: args.workspace,
      team_id: args.team_id,
      conversation_id: args.conversation_id,
    });
    const conversation_ids: Id<"conversations">[] | undefined = originConv
      ? [originConv._id]
      : undefined;
    const created_from_conversation: Id<"conversations"> | undefined =
      originConv?._id;
    // Same status rule as webCreate: a team status by name ("today") lands as
    // its category plus status_id.
    const statusWrite = await resolveStatusWrite(
      ctx,
      db.workspace.type === "team" ? db.workspace.teamId : undefined,
      undefined,
      args,
    );
    const now = Date.now();
    const unkeyedShortId = args.client_key
      ? undefined
      : await nextShortId(ctx.db, "ct");

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const pid = ctx.db.normalizeId("projects", args.project_id);
      if (!pid) notFound("Project not found");
      const project = await requireAccessibleProject(ctx, auth.userId, pid);
      requireSameWorkspace(project, db.workspace, "project");
      project_id = pid;
    }

    let plan_id: Id<"plans"> | undefined;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan)))
        notFound("Plan not found");
      requireSameWorkspace(plan, db.workspace, "plan");
      plan_id = plan._id;
    }

    // Subtask: `--parent ct-123`. Resolved (not written raw) so the stored
    // value is a real task id in this workspace — see resolveParentTask.
    // Decomposition stays inside the parent's container: a subtask created
    // without an explicit plan/project inherits the parent's.
    let parent_id: Id<"tasks"> | undefined;
    if (args.parent_id) {
      const parent = await resolveParentTask(ctx, auth.userId, args.parent_id, {
        workspace: db.workspace,
      });
      parent_id = parent._id;
      if (!plan_id && parent.plan_id) plan_id = parent.plan_id;
      if (!project_id && parent.project_id) project_id = parent.project_id;
    }
    // A task under a plan lives in the plan's project unless it names its own.
    if (!project_id) project_id = await projectFromPlan(ctx, plan_id);

    const from_call =
      (await resolveFromCall(ctx, auth.userId, args.from_call)) ?? undefined;
    const found_during = await foundDuringForCreate(ctx, auth.userId, {
      explicit: args.found_during,
      conversation: originConv,
      workspace: db.workspace,
      parent_id,
      plan_id,
    });

    // Creator enrollment is human only when a person decided the task: human
    // or meeting origin, or an explicit promotion to the human board. An
    // agent's own work task enrolls its owner as an agent act.
    const createdHuman =
      isHumanOrigin({ source: args.source || "human" }) || !!args.promoted;
    const boundary = boundaryOfWorkspace(db.workspace);
    const resolvedAssignee = args.assignee
      ? await resolveAssigneeStr(ctx, args.assignee, auth.userId, boundary)
      : await defaultSessionOwner(
          ctx,
          originConv,
          createdHuman && !parent_id,
          auth.userId,
          boundary,
        );

    if (args.client_key) {
      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_client_key", (q) =>
          q.eq("user_id", auth.userId).eq("client_key", args.client_key!),
        )
        .first();
      if (existing) {
        if (!(await canAccessTask(ctx, auth.userId, existing)))
          notFound("Task not found");
        requireSameWorkspace(existing, db.workspace, "task");
        if (
          existing.project_id !== project_id ||
          existing.plan_id !== plan_id ||
          existing.parent_id !== parent_id ||
          existing.created_from_conversation !== created_from_conversation
        ) {
          throw new Error("Task client key belongs to a different context");
        }
        return { id: existing._id, short_id: existing.short_id };
      }
    }
    const short_id = unkeyedShortId ?? (await nextShortId(ctx.db, "ct"));
    // Blockers in another workspace are refused (readiness could never clear
    // them), and a task can be named before it exists (a blocked_by ref to the
    // next id), so even a new task's blockers may already wait on it (TG4).
    await assertDependencyEdges(
      ctx,
      { short_id, blocked_by: args.blocked_by },
      db.workspace,
      { blocked_by: args.blocked_by },
    );

    const id = await db.insert("tasks", {
      project_id,
      parent_id,
      plan_id,
      short_id,
      title: args.title,
      client_key: args.client_key,
      description: args.description,
      task_type: (args.task_type || "task") as any,
      status: (statusWrite.status || "open") as any,
      status_id: statusWrite.statusId.set
        ? statusWrite.statusId.value
        : undefined,
      priority: (args.priority || "medium") as any,
      assignee: resolvedAssignee,
      labels: args.labels,
      blocked_by: args.blocked_by,
      blocks: [],
      conversation_ids,
      created_from_conversation,
      created_from_insight: args.insight_id as any,
      from_call,
      found_during,
      source: (args.source || "human") as any,
      triage_status: args.source === "insight" ? "suggested" : "active",
      confidence: args.confidence,
      promoted: args.promoted || undefined,
      attempt_count: 0,
      retry_count: 0,
      max_retries: args.max_retries ?? 3,
      ...executionHintPatch(args),
      verify_with: args.verify_with,
      max_visits: args.max_visits,
      retry_target: args.retry_target,
      thread_id: args.thread_id,
      fidelity: args.fidelity,
      condition: args.condition,
      project_path: args.project_path,
      steps: args.steps,
      acceptance_criteria: args.acceptance_criteria,
      estimated_minutes: args.estimated_minutes,
      goal_ref: args.goal_ref?.trim() || undefined,
      ...(args.predict?.trim()
        ? await predictionPatch(
            ctx,
            { workspace: db.workspaceKey, short_id },
            args.predict,
            now,
          )
        : {}),
    } as any);

    for (const dep of args.blocked_by || []) {
      await patchDepMirror(
        ctx,
        auth.userId,
        { short_id, workspace: db.workspace },
        dep,
        "blocks",
        "add",
      );
    }
    if (found_during)
      await recordTaskChange(
        ctx,
        id,
        {
          user_id: auth.userId,
          actor_type: originConv ? "agent" : "user",
          conversation_id: created_from_conversation,
        },
        [["found_during", "", found_during]],
        now,
      );
    const waits = await addWaitsAtCreate(ctx, auth.userId, short_id, args);

    // Subtasks carry plan_id for context but never join plan.task_ids — the
    // parent is the plan's unit of progress, so a decomposition can't inflate
    // the plan bar or flip its auto-done.
    if (plan_id && !parent_id) {
      const plan = await ctx.db.get(plan_id);
      if (plan) {
        const taskIds = plan.task_ids || [];
        taskIds.push(id);
        const progress = plan.progress || {
          total: 0,
          done: 0,
          in_progress: 0,
          open: 0,
        };
        progress.total++;
        progress.open++;
        await ctx.db.patch(plan._id, {
          task_ids: taskIds,
          progress,
          updated_at: now,
        });
      }
    }

    if (created_from_conversation && plan_id) {
      const conv = await ctx.db.get(created_from_conversation);
      if (conv && !conv.active_plan_id) {
        await ctx.db.patch(created_from_conversation, {
          active_plan_id: plan_id,
        });
      }
    }

    await subscribeUser(
      ctx,
      auth.userId,
      id,
      "creator",
      createdHuman ? "human" : "agent",
    );
    // A subtask created directly in progress flips its parent chain, same as a
    // later start would — the parent must never sit "open" under running work.
    if (parent_id) {
      await rollUpParentStart(
        ctx,
        { parent_id, user_id: auth.userId },
        statusWrite.status,
      );
    }
    // A defaulted owner filed the task itself: nobody assigned it to them.
    if (resolvedAssignee && args.assignee) {
      const createdTask = (await ctx.db.get(id)) as any;
      const from = args.assignment_from
        ? (
            await resolveSessionConversation(
              ctx,
              auth.userId,
              args.assignment_from,
            )
          )?._id
        : created_from_conversation;
      await announceAssignment(ctx, {
        task: createdTask,
        assignee: resolvedAssignee,
        actorUserId: auth.userId,
        via: cliVia(args),
        fromConversationId: from,
        note: args.assignment_note,
      });
    }

    await schedulePushNewTask(ctx, project_id, id);

    // session_bound: the creating session holds a task, so the CLI keeps its
    // pulse there rather than move it to what it filed along the way (TG10).
    // found_during, so the CLI can name the link a bound session made (TG5).
    return {
      id,
      short_id,
      ...(waits ? { waits } : {}),
      ...(originConv?.active_task_id ? { session_bound: true } : {}),
      ...(found_during ? { found_during } : {}),
    };
  },
});

const webCreateArgs = {
  title: v.string(),
  description: v.optional(v.string()),
  task_type: v.optional(v.string()),
  status: v.optional(v.string()),
  // Team status id refining the category (kanban "add to column").
  status_id: v.optional(v.string()),
  priority: v.optional(v.string()),
  project_id: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  plan_id: v.optional(v.string()),
  team_id: v.optional(v.id("teams")),
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  assignee: v.optional(v.string()),
  project_path: v.optional(v.string()),
  // Short id (or id) of the parent task — the web quick-add / create-modal
  // subtask path. Resolved through resolveParentTask like every surface.
  parent: v.optional(v.string()),
  // Optimistic-create idempotency key (see schema.tasks.client_key).
  client_key: v.optional(v.string()),
  // The call this task came out of (a call ref): the call page's create.
  from_call: v.optional(v.string()),
  // model, effort and ephemeral (TG8, TG9).
  ...executionHintArgs,
};

export const webCreate = mutation({
  args: webCreateArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await createTaskAs(ctx, userId, args);
  },
});

/** Create a task as `userId`, the way the web's create does: the hosted
 *  assistant's create_task runs this same path for the person it works for. */
export async function createTaskAs(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: ObjectType<typeof webCreateArgs>,
) {
  // Idempotency: a retried or replayed create carries the same client_key,
  // so return the row it already made instead of inserting a duplicate.
  if (args.client_key) {
    const existing = await ctx.db
      .query("tasks")
      .withIndex("by_client_key", (q) =>
        q.eq("user_id", userId).eq("client_key", args.client_key),
      )
      .first();
    if (existing) return { id: existing._id, short_id: existing.short_id };
  }

  // A task created onto a plan lives in the plan's workspace: when the
  // caller names a plan but no explicit workspace, inherit the plan's
  // (canAccessPlan already proves membership for a team plan). An explicit
  // workspace still has to match the plan — requireSameWorkspace below.
  let plan: any = null;
  if (args.plan_id) {
    plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
      .first();
    if (!plan || !(await canAccessPlan(ctx, userId, plan)))
      notFound("Plan not found");
  }
  const inheritFromPlan = plan && !args.workspace && !args.team_id;

  // A subtask lives in its parent's workspace: with no explicit workspace or
  // plan, the parent row decides. resolveParentTask below re-validates the
  // final workspace, so a mismatched explicit workspace still fails.
  let parentPeek: any = null;
  if (args.parent) {
    parentPeek =
      (await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.parent!))
        .first()) ??
      (await (async () => {
        const id = ctx.db.normalizeId("tasks", args.parent!);
        return id ? await ctx.db.get(id) : null;
      })());
  }
  const inheritFromParent =
    parentPeek && !inheritFromPlan && !args.workspace && !args.team_id;

  // Otherwise the workspace comes from the client's explicit picker or the
  // directory mapping — never from the user's active team. An unmapped
  // project_path with no explicit workspace lands personal ("Only Me"),
  // matching sessions.
  const db = await createDataContext(
    ctx,
    inheritFromPlan
      ? plan.team_id
        ? { userId, workspace: "team", team_id: plan.team_id }
        : { userId, workspace: "personal" }
      : inheritFromParent
        ? parentPeek.team_id
          ? { userId, workspace: "team", team_id: parentPeek.team_id }
          : { userId, workspace: "personal" }
        : {
            userId,
            workspace: args.workspace,
            team_id: args.team_id,
            project_path: args.project_path,
          },
  );

  // Now the real resolution: access, same-workspace, cycle, depth.
  let parentDoc: any = null;
  if (args.parent) {
    parentDoc = await resolveParentTask(ctx, userId, args.parent, {
      workspace: db.workspace,
    });
  }

  let project_id: Id<"projects"> | undefined;
  if (args.project_id) {
    const pid = ctx.db.normalizeId("projects", args.project_id);
    if (!pid) notFound("Project not found");
    const project = await requireAccessibleProject(ctx, userId, pid);
    requireSameWorkspace(project, db.workspace, "project");
    project_id = pid;
  }

  let plan_id: Id<"plans"> | undefined;
  if (plan) {
    requireSameWorkspace(plan, db.workspace, "plan");
    plan_id = plan._id;
  }
  // Decomposition stays inside the parent's container: no explicit
  // plan/project means the parent's.
  if (parentDoc) {
    if (!plan_id && parentDoc.plan_id) plan_id = parentDoc.plan_id;
    if (!project_id && parentDoc.project_id) project_id = parentDoc.project_id;
  }
  if (!project_id) project_id = await projectFromPlan(ctx, plan_id);

  const short_id = await nextShortId(ctx.db, "ct");

  const resolvedAssignee = await resolveAssigneeStr(
    ctx,
    args.assignee,
    userId,
    boundaryOfWorkspace(db.workspace),
  );
  const from_call =
    (await resolveFromCall(ctx, userId, args.from_call)) ?? undefined;

  // Category + custom-status resolution against the resolved workspace's
  // team. Also validates args.status (this path used to skip the assert and
  // let a bad value surface as a raw schema error at insert).
  const statusWrite = await resolveStatusWrite(
    ctx,
    db.workspace.type === "team" ? db.workspace.teamId : undefined,
    undefined,
    args,
  );

  const now = Date.now();
  const id = await db.insert("tasks", {
    project_id,
    plan_id,
    parent_id: parentDoc?._id,
    client_key: args.client_key,
    short_id,
    title: args.title,
    description: args.description,
    task_type: (args.task_type || "task") as any,
    status: (statusWrite.status || "open") as any,
    status_id: statusWrite.statusId.set
      ? statusWrite.statusId.value
      : undefined,
    // Created directly in done/dropped (the modal offers every status):
    // terminal rows always carry closed_at, same as a close would stamp.
    closed_at: isTerminalTaskStatus(statusWrite.status) ? now : undefined,
    priority: (args.priority || "medium") as any,
    labels: args.labels,
    assignee: resolvedAssignee,
    from_call,
    source: "human",
    attempt_count: 0,
    retry_count: 0,
    max_retries: 3,
    ...executionHintPatch(args),
  } as any);

  // A subtask created directly in progress flips its parent chain.
  if (parentDoc) {
    await rollUpParentStart(
      ctx,
      { parent_id: parentDoc._id, user_id: userId },
      statusWrite.status,
    );
  }

  // Subtasks carry plan_id for context but never join plan.task_ids — the
  // parent is the plan's unit of progress.
  if (plan_id && !parentDoc) {
    const plan = await ctx.db.get(plan_id);
    if (plan) {
      const taskIds = plan.task_ids || [];
      await ctx.db.patch(plan_id, {
        task_ids: [...taskIds, id],
        updated_at: now,
      });
    }
  }

  await ctx.db.insert("task_history", {
    task_id: id,
    user_id: userId,
    actor_type: "user",
    action: "created",
    created_at: now,
  });
  if (resolvedAssignee) {
    await announceAssignment(ctx, {
      task: (await ctx.db.get(id)) as any,
      assignee: resolvedAssignee,
      actorUserId: userId,
      via: "human",
    });
  }

  await schedulePushNewTask(ctx, project_id, id);

  return { id, short_id };
}
