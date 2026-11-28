import { v } from "convex/values";
import { briefGoalRefs } from "@codecast/goals/goalsBrief";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation } from "./functions";
import { causeBrief } from "./goals";
import { predictionPatch } from "./predictions";
import { outcomeOfDeclaration, subagentEnded } from "./subagentFleet";
import { pendingReleases, tellReleased } from "./taskWaits";
import { linkConversationToEntityBestEffort } from "./conversationLinks";
import {
  canAccessPlan,
  isSameWorkspace,
  requireAccessibleProject,
  requireSameWorkspace,
  requireTeamMembership,
  resolveSessionConversation,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./lib/access";
import { resolveActor } from "./lib/actor";
import { forbidden, notFound } from "./lib/auth";
import { changeGuideInputValidator } from "./lib/changeGuideValidator";
import { watchUntilFor } from "./lib/lineWatch";
import { projectFromPlan } from "./lib/planFiling";
import {
  assigneeScopeOf,
  boundaryOfWorkspace,
  resolveAssigneeStr,
  roleTakingTask,
} from "./lib/taskAssignees";
import { requireAccessibleTaskByToken } from "./lib/taskClaimLifecycle";
import {
  handleTaskUpdateClaim,
  resolveTaskUpdateConversation,
} from "./lib/taskClaims";
import { insertTaskComment } from "./lib/taskComments";
import { syncDepEdgeMirrors } from "./lib/taskDeps";
import { executionHintArgs, executionHintPatch } from "./lib/taskExecution";
import { groundArgs, groundPatch, resolveFromCall } from "./lib/taskFields";
import {
  assertDependencyEdges,
  openBlockersOf,
  storedGraphRefs,
} from "./lib/taskGraph";
import { recordTaskChange, type TaskChangeBy } from "./lib/taskHistory";
import {
  announceAssignment,
  cliVia,
  schedulePushKeptTask,
} from "./lib/taskNotifications";
import {
  claimTaskOwnership,
  releaseBoundSessions,
  type TaskOwnerRef,
} from "./lib/taskOwner";
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
  heldError,
  holdingDecisionFor,
  liveRun,
  noteMovedPastHold,
} from "./lib/taskTransitions";
import { patchTask } from "./lib/taskWrite";

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    // `cast task update --call cl-42`: the call this task came out of; "" clears.
    from_call: v.optional(v.string()),
    status: v.optional(v.string()),
    // Team status id refining the category; "" clears back to the default.
    status_id: v.optional(v.string()),
    priority: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    promoted: v.optional(v.boolean()),
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    // Short id of the parent task; empty string detaches back to the top level.
    parent: v.optional(v.string()),
    // Close-guard resolution when closing a parent with open subtasks:
    // "cascade" closes the open subtree too, "only_parent" closes just this task.
    subtask_resolution: v.optional(
      v.union(v.literal("cascade"), v.literal("only_parent")),
    ),
    plan_id: v.optional(v.string()),
    blocked_by: v.optional(v.array(v.string())),
    blocks: v.optional(v.array(v.string())),
    last_session_summary: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    // `cast task start --take`: move the task's one owning session here even
    // while the current owner is still working (lib/taskOwner.ts).
    take: v.optional(v.boolean()),
    // Structured execution fields
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
    execution_status: v.optional(v.string()),
    execution_concerns: v.optional(v.string()),
    verification_evidence: v.optional(v.string()),
    files_changed: v.optional(v.array(v.string())),
    // `cast task handoff --guide`: the author's walkthrough, stamped here.
    change_guide: v.optional(changeGuideInputValidator),
    estimated_minutes: v.optional(v.number()),
    // The review station's verdict (the-line.md L3), recorded with the status
    // move in this one write. by_conversation_id is the caller's session.
    review_verdict: v.optional(
      v.union(v.literal("approve"), v.literal("changes"), v.literal("reject")),
    ),
    review_note: v.optional(v.string()),
    // The ground node's fields (the-line-end-to-end.md LE5). An empty string
    // clears one; goal_ref "none" is a value (the cause threatens no goal).
    ...groundArgs,
    // The watch after ship (LE12): days from now until a quiet cause closes
    // as resolved; 0 ends the watch.
    watch_days: v.optional(v.number()),
    // A predicted effect on a goal metric (predictions.ts); "" clears it.
    predict: v.optional(v.string()),
    // model, effort and ephemeral (TG8, TG9); ephemeral:false is `cast task keep`.
    ...executionHintArgs,
    claim_token: v.optional(v.number()),
    claim_request_id: v.optional(v.string()),
    claim_purpose: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { auth, task } = await requireAccessibleTaskByToken(
      ctx,
      args.api_token,
      args.short_id,
    );
    // Edges are stored canonical; a wait goes through cast task dep.
    args = { ...args, ...storedGraphRefs(ctx, args) };

    // The category every status side effect below keys on. args.status alone
    // is not enough: a status_id-only write still moves the category.
    const statusWrite = await resolveStatusWrite(
      ctx,
      task.team_id,
      task.status,
      args,
    );
    const { conv, unresolved: unresolvedConv } =
      await resolveTaskUpdateConversation(
        ctx,
        auth.userId,
        args.conversation_id,
      );
    // A session handing off a task held by a decision (L5): the evidence is
    // recorded and the task stays at its station, where the person's answer
    // moves it. Any other session move of a held task is refused below.
    const heldHandoff =
      conv && args.verification_evidence !== undefined
        ? await holdingDecisionFor(
            ctx,
            task,
            statusWrite.status,
            statusWrite.statusId,
          )
        : null;
    if (heldHandoff) {
      statusWrite.status = undefined;
      statusWrite.statusId = { set: false };
    }
    // A review approve inside a live run is one station, not the end: the
    // run decides when the task is done (LE16, runEndStatus), so it stays in
    // review. An approve that closed the task left it done after Land then
    // stopped the run at Not shipped (ct-98836).
    if (
      args.review_verdict === "approve" &&
      statusWrite.status === "done" &&
      (await liveRun(ctx, task))
    ) {
      statusWrite.status = "in_review";
    }
    const nextStatus = statusWrite.status;

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (statusWrite.statusId.set)
      updates.status_id = statusWrite.statusId.value;
    if (nextStatus) updates.status = nextStatus;
    if (args.priority) updates.priority = args.priority;
    if (args.title) {
      updates.title = args.title;
      // The generated short name follows the title; the cron refills it.
      updates.short_title = undefined;
    }
    if (args.description !== undefined) updates.description = args.description;
    if (args.labels) updates.labels = args.labels;
    if (args.promoted !== undefined) updates.promoted = args.promoted;
    const fromCall = await resolveFromCall(ctx, auth.userId, args.from_call);
    if (fromCall !== undefined) updates.from_call = fromCall ?? undefined;
    const targetWorkspace = args.team_id
      ? { type: "team" as const, teamId: args.team_id }
      : task.team_id
        ? { type: "team" as const, teamId: task.team_id }
        : { type: "personal" as const, userId: task.user_id };
    // Who may take the task is decided by its ACCESS key (boundaryOfTask),
    // not by the team it is routed to; a move to another team names that team.
    const assigneeBoundary = args.team_id
      ? boundaryOfWorkspace(targetWorkspace)
      : await assigneeScopeOf(ctx, task);
    if (args.assignee !== undefined)
      updates.assignee =
        (await resolveAssigneeStr(
          ctx,
          args.assignee,
          auth.userId,
          assigneeBoundary,
        )) || args.assignee;
    if (args.team_id) {
      await requireTeamMembership(ctx, auth.userId, args.team_id);
      if (
        task.team_id &&
        String(task.team_id) !== String(args.team_id) &&
        String(task.user_id) !== String(auth.userId)
      ) {
        forbidden("Forbidden: only the task owner may move it between teams");
      }
    }
    if (args.project_id !== undefined) {
      if (!args.project_id) {
        updates.project_id = undefined;
      } else {
        const projectId = ctx.db.normalizeId("projects", args.project_id);
        if (!projectId) notFound("Project not found");
        const project = await requireAccessibleProject(
          ctx,
          auth.userId,
          projectId,
        );
        requireSameWorkspace(project, targetWorkspace, "project");
        updates.project_id = projectId;
      }
    }
    if (args.project_path !== undefined)
      updates.project_path = args.project_path || undefined;
    if (args.team_id) updates.team_id = args.team_id;
    // Reparent (or `--parent ""` to detach and return the task to the top level).
    if (args.parent !== undefined) {
      if (!args.parent) {
        updates.parent_id = undefined;
      } else {
        // A parent shares the child's ACCESS key as this write leaves it (a
        // team move changes it only on a row with no stored key), never the
        // team it is routed to: readiness reads a parent only there.
        const parent = await resolveParentTask(ctx, auth.userId, args.parent, {
          workspace: workspaceForResource({
            ...task,
            team_id: args.team_id ?? task.team_id,
          }),
          child: task,
        });
        updates.parent_id = parent._id;
      }
    }
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan)))
        notFound("Plan not found");
      requireSameWorkspace(plan, targetWorkspace, "plan");
      updates.plan_id = plan._id;
      // A task that followed its old plan's project (or had none) follows the
      // new plan's; one filed in some other project on purpose keeps it.
      if (
        !("project_id" in updates) &&
        plan.project_id &&
        String(plan._id) !== String(task.plan_id ?? "")
      ) {
        const oldPlanProject = await projectFromPlan(ctx, task.plan_id);
        if (
          !task.project_id ||
          String(task.project_id) === String(oldPlanProject ?? "")
        )
          updates.project_id = plan.project_id;
      }
      // Subtasks carry plan_id for context but never join plan.task_ids — the
      // parent is the plan's unit of progress. Branch on key PRESENCE, not
      // value: `updates.parent_id === undefined` is also how detach is
      // expressed, so a value test would mistake a detach for "unchanged".
      const willBeSubtask =
        "parent_id" in updates ? !!updates.parent_id : !!task.parent_id;
      const taskIds = plan.task_ids || [];
      if (!willBeSubtask && !taskIds.some((id: any) => id === task._id)) {
        taskIds.push(task._id);
        await ctx.db.patch(plan._id, { task_ids: taskIds, updated_at: now });
      }
    }
    // Snapshot the pre-write edges: the mirror patches below run after the
    // main patch, which may mutate `task` in place.
    const prevDeps = {
      blocked_by: task.blocked_by || [],
      blocks: task.blocks || [],
    };
    if (args.blocked_by) updates.blocked_by = args.blocked_by;
    if (args.blocks) updates.blocks = args.blocks;
    if (args.last_session_summary)
      updates.last_session_summary = args.last_session_summary;
    if (args.steps) updates.steps = args.steps;
    if (args.acceptance_criteria)
      updates.acceptance_criteria = args.acceptance_criteria;
    if (args.execution_status) updates.execution_status = args.execution_status;
    if (args.execution_concerns !== undefined)
      updates.execution_concerns = args.execution_concerns;
    if (args.verification_evidence !== undefined)
      updates.verification_evidence = args.verification_evidence;
    if (args.files_changed) updates.files_changed = args.files_changed;
    if (args.change_guide)
      updates.change_guide = { ...args.change_guide, written_at: now };
    if (args.estimated_minutes !== undefined)
      updates.estimated_minutes = args.estimated_minutes;
    // A cause's goal is one its own goals brief offers (LE5): its project's,
    // or a metric of an initiative carrying it. A ref from another project's
    // brief ties the cause to a goal its people do not hold.
    if (args.goal_ref?.trim() && task.source === "signal" && task.workspace) {
      const offered = briefGoalRefs(await causeBrief(ctx, task));
      if (!offered.has(args.goal_ref.trim())) {
        throw new Error(
          `goal_ref "${args.goal_ref.trim()}" is not one of ${task.short_id}'s goals; its goals brief offers: ${[...offered].join(", ")} (cast goals --brief --task ${task.short_id})`,
        );
      }
    }
    Object.assign(updates, groundPatch(args), executionHintPatch(args));
    // Judged against the status this same call sets: `--status open --predict` on a shipped task is a reopen, then a prediction.
    if (args.predict !== undefined)
      Object.assign(
        updates,
        await predictionPatch(
          ctx,
          { ...task, status: nextStatus ?? task.status },
          args.predict,
          now,
        ),
      );
    if (args.watch_days !== undefined) {
      // The watch station runs right after the ship: the fix is live from now, and older evidence never reopens it.
      updates.watch_until = watchUntilFor(args.watch_days, now);
      updates.watch_from = updates.watch_until ? now : undefined;
    }

    // Only a move into a closed status stamps when it closed: a repeat "done" keeps the close it had.
    if (
      (nextStatus === "done" || nextStatus === "dropped") &&
      nextStatus !== task.status
    ) {
      updates.closed_at = now;
    }

    let linkedConvId: Id<"conversations"> | undefined;
    let startedForRole: any | null = null;
    let releasedOwners: TaskOwnerRef[] = [];
    let claimResult: { claimToken: number; leaseUntil: number } | null = null;
    if (args.review_verdict) {
      updates.review_verdict = {
        verdict: args.review_verdict,
        ...(conv ? { by_conversation_id: conv._id } : {}),
        at: now,
        ...(args.review_note ? { note: args.review_note } : {}),
      };
    }
    // The hold (the-line.md L5): a session is refused; a person moves past it
    // and the note below names the decision.
    const hold = await holdingDecisionFor(
      ctx,
      task,
      nextStatus,
      statusWrite.statusId,
    );
    if (hold && conv) throw heldError(hold, task);
    if (conv) {
      // A conversation in another workspace may still drive the write (an agent
      // working a cross-workspace task); only the conversation↔task linkage is
      // skipped, since relationships may not join authorization domains.
      const convMatchesWorkspace = workspacesMatch(
        workspaceForConversation(conv),
        targetWorkspace,
      );
      if (convMatchesWorkspace) {
        linkedConvId = conv._id;
        const existing = task.conversation_ids || [];
        if (!existing.some((id) => id === conv._id)) {
          updates.conversation_ids = [...existing, conv._id];
          // Compatibility dual-write: the entity-conversation association row alongside
          // the legacy conversation_ids field. Best-effort — this update may
          // simultaneously move the task's workspace, which the strict
          // containment check reads from the pre-patch row.
          await linkConversationToEntityBestEffort(ctx, auth.userId, {
            entityType: "task",
            entityId: String(task._id),
            conversationId: conv._id,
            relationship: "work",
          });
        }
      }
      // An explicit start (cast task start). A `changes` verdict also moves
      // to in_progress but must not bind the reviewer to the work it judges.
      const explicitStart =
        nextStatus === "in_progress" && !args.review_verdict;
      // A session that takes a task assigns it to the role it works for
      // (org-roles-run-work.md R5), so the board shows who owns the work. A
      // task that already names a person stays theirs: the session is
      // helping them, not taking it from them. Decided apart from the binding
      // below: a hand whose first task sits in review still holds it as
      // active_task_id, and its next start must reach the role all the same.
      if (
        convMatchesWorkspace &&
        explicitStart &&
        args.assignee === undefined
      ) {
        const taker = await roleTakingTask(ctx, task, conv, assigneeBoundary);
        if (taker) {
          updates.assignee = String(taker._id);
          startedForRole = taker;
        }
      }
      // Only bind conversation to task on explicit start. The start makes this
      // session the task's one owner and moves its own focus here, so a
      // session bound to another task rebinds rather than silently staying.
      if (explicitStart) {
        const owned = await claimTaskOwnership(ctx, conv, task, {
          take: args.take === true,
          now,
          holder: auth.userId,
          expectedToken: args.claim_token,
          requestId: args.claim_request_id,
          purpose: args.claim_purpose,
        });
        releasedOwners = owned.released;
        claimResult = {
          claimToken: owned.claimToken,
          leaseUntil: owned.leaseUntil,
        };
        // The binding may file the session under the lead that owns the work (S35).
        await ctx.scheduler.runAfter(
          0,
          internal.sessionOwnership.reconcileHold,
          { conversation_id: conv._id },
        );
        if (convMatchesWorkspace && task.plan_id && !conv.active_plan_id) {
          const relatedPlan = await ctx.db.get(task.plan_id);
          if (
            relatedPlan &&
            isSameWorkspace(relatedPlan, targetWorkspace) &&
            (await canAccessPlan(ctx, auth.userId, relatedPlan))
          ) {
            await ctx.db.patch(conv._id, { active_plan_id: task.plan_id });
          }
        }
      }
      // A worker closing or handing off its task ends its turn at its fleet
      // slot (subagentFleet.ts): done merges its worktree back, blocked keeps it.
      if (conv.parent_conversation_id) {
        const outcome = outcomeOfDeclaration(
          args.execution_status === "done_with_concerns"
            ? "done"
            : (args.execution_status ??
                (nextStatus === "done" ? "done" : undefined)),
        );
        if (outcome) await subagentEnded(ctx, conv, outcome);
      }
    }

    const handledClaim = await handleTaskUpdateClaim(ctx, {
      task,
      holder: auth.userId,
      conv,
      unresolvedConversation: unresolvedConv,
      nextStatus,
      reviewVerdict: args.review_verdict,
      claimToken: args.claim_token,
      requestId: args.claim_request_id,
      purpose: args.claim_purpose,
      take: args.take,
      now,
      claimStarted: claimResult !== null,
      releaseBound: (claimConvId) =>
        releaseBoundSessions(ctx, task, conv?._id, claimConvId),
    });
    if (handledClaim) claimResult = handledClaim;

    if (nextStatus === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
      if (!task.started_at) updates.started_at = now;
    }

    if (nextStatus === "done" && task.started_at) {
      updates.actual_minutes = Math.round((now - task.started_at) / 60000);
    }

    // Close-guard: refuses done/dropped on a parent with open subtasks unless
    // resolved; returns the subtree to cascade-close. Runs before any write.
    const cascadeIds = await guardParentClose(
      ctx,
      task,
      nextStatus,
      args.subtask_resolution,
    );

    // Did the parent actually change? (Reparent/detach need history + plan reconcile.)
    const parentChanged =
      "parent_id" in updates &&
      String(updates.parent_id ?? "") !== String(task.parent_id ?? "");

    // Record history for changed fields
    const trackFields: [string, any, any][] = [];
    if (nextStatus && nextStatus !== task.status)
      trackFields.push(["status", task.status, nextStatus]);
    if (args.priority && args.priority !== task.priority)
      trackFields.push(["priority", task.priority, args.priority]);
    if (args.title && args.title !== task.title)
      trackFields.push(["title", task.title, args.title]);
    if ("assignee" in updates && updates.assignee !== task.assignee)
      trackFields.push([
        "assignee",
        task.assignee || "",
        updates.assignee || "",
      ]);
    if (parentChanged)
      trackFields.push([
        "parent",
        task.parent_id ?? "",
        updates.parent_id ?? "",
      ]);
    if (args.review_verdict)
      trackFields.push([
        "review_verdict",
        task.review_verdict?.verdict ?? "",
        args.review_verdict,
      ]);
    if (args.labels) trackFields.push(["labels", task.labels, args.labels]);
    if (args.blocked_by)
      trackFields.push(["blocked_by", prevDeps.blocked_by, args.blocked_by]);

    // A new edge on either side must stay in the workspace and not close a
    // loop (TG4). Edges join tasks by their stored access key, as addDep and
    // readiness judge them, never by the team the task is routed to (a team
    // move here changes routing, not `workspace`).
    const depWorkspace = workspaceForResource(task);
    await assertDependencyEdges(
      ctx,
      {
        short_id: task.short_id,
        _id: String(task._id),
        blocked_by: args.blocked_by ?? prevDeps.blocked_by,
      },
      depWorkspace,
      {
        blocked_by: args.blocked_by?.filter(
          (d) => !prevDeps.blocked_by.includes(d),
        ),
        blocks: args.blocks?.filter((d) => !prevDeps.blocks.includes(d)),
      },
    );
    // Dropping an edge here can release a task, as removeDep does (TG2).
    const releases = await pendingReleases(ctx, task, args);

    // Who did it (lib/actor): a role's standing session writes as the role's
    // bot user; a hand keeps its host.
    const actor = await resolveActor(ctx, auth.userId, conv);
    const changedBy: TaskChangeBy = {
      user_id: actor.user_id,
      actor_type: actor.kind === "role" ? "agent" : "user",
      conversation_id: linkedConvId,
    };
    await recordTaskChange(ctx, task._id, changedBy, trackFields, now);

    await patchTask(ctx, task, updates);
    await schedulePushKeptTask(ctx, task, updates);
    if (hold)
      await noteMovedPastHold(
        ctx,
        task,
        hold,
        nextStatus ?? task.status,
        actor.name || "unknown",
        auth.userId,
      );
    if (conv && releasedOwners.length) {
      const who = linkedConvId
        ? `Session ${conv.short_id ?? conv._id}`
        : actor.name || "A session";
      await insertTaskComment(
        ctx,
        task._id,
        {
          author: actor.name || "unknown",
          text: `${who} took over as owner from ${releasedOwners.map((o) => o.short_id).join(", ")}.`,
          comment_type: "note",
          conversation_id: linkedConvId,
        },
        auth.userId,
        undefined,
        true,
      );
    }
    await syncDepEdgeMirrors(
      ctx,
      auth.userId,
      task,
      depWorkspace,
      prevDeps,
      args,
      changedBy,
    );
    await tellReleased(ctx, releases, changedBy);
    if (cascadeIds.length > 0)
      await cascadeClose(ctx, cascadeIds, nextStatus!, auth.userId, task);
    // Rollup walks the EFFECTIVE parent (the new one on a reparent+start), not
    // the pre-patch parent, so the task's actual parent flips to in_progress.
    await rollUpParentStart(
      ctx,
      {
        ...task,
        parent_id: "parent_id" in updates ? updates.parent_id : task.parent_id,
      },
      nextStatus,
    );

    // Reparent/detach changed the task's subtask-ness: reconcile plan.task_ids
    // and progress on the plan it now belongs to (its own or its new parent's).
    if (parentChanged) {
      const finalPlan = (updates.plan_id ?? task.plan_id) as
        | Id<"plans">
        | undefined;
      await reconcilePlanMembership(
        ctx,
        task._id,
        finalPlan,
        !!updates.parent_id,
      );
    }

    await afterStatusMove(ctx, task, nextStatus, auth.userId, linkedConvId);
    if (args.assignee !== undefined && updates.assignee !== task.assignee) {
      await announceAssignment(ctx, {
        task,
        assignee: updates.assignee,
        actorUserId: auth.userId,
        actorName: actor.name,
        via: cliVia(args),
        fromConversationId: conv?._id,
      });
    }

    let planShortId: string | undefined;
    if (task.plan_id) {
      const plan = await ctx.db.get(task.plan_id);
      if (
        plan &&
        isSameWorkspace(plan, targetWorkspace) &&
        (await canAccessPlan(ctx, auth.userId, plan))
      ) {
        planShortId = plan.short_id;
      }
    }
    return {
      success: true,
      plan_id: planShortId,
      // Set when this start handed the task to the caller's role, so the CLI
      // can say so.
      assigned_role:
        startedForRole && updates.assignee !== task.assignee
          ? { handle: startedForRole.handle, name: startedForRole.name }
          : undefined,
      // Sessions this start released as the task's owner, so the CLI can say
      // which one lost the binding and whether it was still working.
      released_owners: releasedOwners.length
        ? releasedOwners.map(({ short_id, title, live }) => ({
            short_id,
            title,
            live,
          }))
        : undefined,
      // A start of a task still waiting on something says what (TG1), so a
      // session that picked it by name, not from `ready`, learns it.
      open_blockers:
        nextStatus === "in_progress"
          ? await openBlockersOf(ctx, task)
          : undefined,
      // A handoff recorded on a held task, which stayed at its station (L5).
      held: heldHandoff
        ? {
            decision: heldHandoff.short_id ?? String(heldHandoff._id),
            station: heldHandoff.station,
          }
        : undefined,
      ...(claimResult
        ? {
            claim_token: claimResult.claimToken,
            lease_until: claimResult.leaseUntil,
          }
        : {}),
    };
  },
});
