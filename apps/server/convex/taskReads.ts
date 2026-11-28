import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { inlineForeignText } from "@codecast/fence/fence";
import { isActiveTask, subtaskProgressOf } from "@codecast/tasks";
import { docRelatesToTask } from "@codecast/tasks/relatedDocs";
import { resolveTaskStatus } from "@codecast/tasks/statuses";
import type { Id } from "./_generated/dataModel";
import { query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { linkedEntityIdsForConversation } from "./conversationLinks";
import { createDataContext } from "./data";
import { taskLinksOf } from "./taskLinks";
import {
  canAccessConversation,
  canAccessDoc,
  canAccessPlan,
  canAccessProject,
  canAccessTask,
  isSameWorkspace,
  resolveSessionConversation,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./lib/access";
import { taskCommentsWithSessionInfo } from "./lib/commentSessionInfo";
import { assigneeNamesFor } from "./lib/taskAssignees";
import { linkedSessionsFor } from "./lib/taskEnrich";
import { offFrontierReason } from "./lib/taskGraph";
import { changeSessionOf } from "./lib/taskOwner";
import { loadTeamTaskStatuses } from "./lib/taskStatuses";

// Generate a task snippet for agent instructions
export const snippet = query({
  args: {
    api_token: v.string(),
    conversation_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
    });

    const tasks = await db.query("tasks").collect();

    const activeTasks = tasks.filter(
      (t: any) =>
        (t.status === "open" ||
          t.status === "in_progress" ||
          t.status === "in_review") &&
        (!t.triage_status || t.triage_status === "active"),
    );

    const userIds = [
      ...new Set(activeTasks.map((t: any) => t.user_id as Id<"users">)),
    ] as Id<"users">[];
    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      const u = (await ctx.db.get(uid)) as any;
      if (u) userMap.set(uid.toString(), u.name || u.email || "unknown");
    }

    let sessionPlans: { title: string; doc_type: string }[] = [];
    let activePlanSnippet = "";
    if (args.conversation_id) {
      const conv = await resolveSessionConversation(
        ctx,
        auth.userId,
        args.conversation_id,
      );
      if (conv) {
        // Fetch only this conversation's docs through the by_conversation_id
        // index. Collecting the whole team docs table (every row's full markdown
        // content — which this snippet never even returns, only titles below)
        // blew the 64 MB UDF heap for doc-heavy teams. db.get re-applies the
        // workspace access the scoped db.query() used to provide.
        const convDocs = await ctx.db
          .query("docs")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", conv._id),
          )
          .collect();
        for (const d of convDocs) {
          if (sessionPlans.length >= 5) break;
          if (d.archived_at) continue;
          if (await db.get(d._id)) {
            sessionPlans.push({ title: d.title, doc_type: d.doc_type });
          }
        }

        if (conv.active_plan_id) {
          const plan = await ctx.db.get(conv.active_plan_id);
          if (plan) {
            const planLines: string[] = [];
            planLines.push(
              `Active Plan: ${inlineForeignText(plan.title)} (${plan.short_id}) [${plan.status}]`,
            );
            if (plan.goal)
              planLines.push(`Goal: ${inlineForeignText(plan.goal)}`);
            if (plan.progress) {
              const p = plan.progress;
              planLines.push(
                `Progress: ${p.done}/${p.total} done, ${p.in_progress} in progress, ${p.open} open`,
              );
            }
            if (plan.task_ids) {
              for (const tid of plan.task_ids.slice(0, 10)) {
                const t = await ctx.db.get(tid);
                // Skip subtasks that predate the task_ids exclusion rule.
                if (t && !t.parent_id)
                  planLines.push(
                    `  - ${t.short_id}: ${inlineForeignText(t.title)} [${t.status}]`,
                  );
              }
            }
            activePlanSnippet = planLines.join("\n");
          }
        }
      }
    }

    const lines: string[] = [];
    if (activeTasks.length > 0) {
      // The capped lists show TOP-LEVEL tasks only — one agent's decomposition
      // must never evict every other task from every agent's injected context.
      // A parent summarises its subtasks as done/total; the full tree renders
      // only for this session's own bound task below.
      const childrenByParent = new Map<string, any[]>();
      for (const t of tasks as any[]) {
        if (!t.parent_id) continue;
        const key = String(t.parent_id);
        const bucket = childrenByParent.get(key);
        if (bucket) bucket.push(t);
        else childrenByParent.set(key, [t]);
      }
      const progressNote = (t: any) => {
        const children = childrenByParent.get(String(t._id));
        if (!children || children.length === 0) return "";
        const p = subtaskProgressOf(children);
        return p.total > 0 ? ` — ${p.done}/${p.total} subtasks done` : "";
      };
      const inProgress = activeTasks.filter(
        (t: any) => t.status === "in_progress" && !t.parent_id,
      );
      const open = activeTasks.filter(
        (t: any) => t.status === "open" && !t.parent_id,
      );

      if (inProgress.length > 0) {
        lines.push("In Progress:");
        for (const t of inProgress.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(
            `- ${t.short_id}: ${inlineForeignText(t.title)}${owner ? ` (${inlineForeignText(owner)})` : ""}${t.labels?.length ? ` [${inlineForeignText(t.labels.join(", "))}]` : ""}${progressNote(t)}`,
          );
        }
      }

      if (open.length > 0) {
        lines.push("Open:");
        for (const t of open.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(
            `- ${t.short_id}: ${inlineForeignText(t.title)}${owner ? ` (${inlineForeignText(owner)})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` [${t.priority}]` : ""}${progressNote(t)}`,
          );
        }
      }

      // This session's bound task gets its full subtask tree — the one place
      // the whole decomposition belongs in agent context.
      if (args.conversation_id) {
        const conv = await resolveSessionConversation(
          ctx,
          auth.userId,
          args.conversation_id,
        );
        const boundId = conv?.active_task_id
          ? String(conv.active_task_id)
          : null;
        const bound = boundId
          ? (tasks as any[]).find((t) => String(t._id) === boundId)
          : null;
        if (bound) {
          const renderTree = (
            parentKey: string,
            indent: string,
            depth: number,
          ) => {
            if (depth > 2) return;
            for (const c of childrenByParent.get(parentKey) ?? []) {
              if (c.status === "done" || c.status === "dropped") continue;
              lines.push(
                `${indent}- ${c.short_id}: ${inlineForeignText(c.title)} [${c.status}]`,
              );
              renderTree(String(c._id), indent + "  ", depth + 1);
            }
          };
          const boundKey = String(bound._id);
          const p = subtaskProgressOf(childrenByParent.get(boundKey) ?? []);
          // Always name the session's own task — the capped lists filter out
          // subtasks, so a session that claimed a leaf subtask would otherwise
          // never see the row it is working. Show its parent breadcrumb too.
          if (bound.parent_id) {
            const bp: any = await ctx.db.get(bound.parent_id);
            lines.push(
              `Your task ${bound.short_id}: ${inlineForeignText(bound.title)} [${bound.status}]${bp ? ` — subtask of ${bp.short_id} ${inlineForeignText(bp.title)}` : ""}`,
            );
          } else if (p.total > 0) {
            lines.push(
              `Your task ${bound.short_id} — ${p.done}/${p.total} subtasks done, open ones:`,
            );
          }
          if (p.total > 0) renderTree(boundKey, "  ", 1);
        }
      }
    }

    if (activePlanSnippet) {
      lines.push(activePlanSnippet);
    }

    if (sessionPlans.length > 0) {
      lines.push("Related Plans:");
      for (const p of sessionPlans) {
        lines.push(`- ${inlineForeignText(p.title)} (${p.doc_type})`);
      }
    }

    return {
      snippet: lines.join("\n"),
      // Count the same rows the snippet prints — top-level active tasks — so
      // the number beside the snippet matches the list it summarises.
      task_count: activeTasks.filter((t: any) => !t.parent_id).length,
      plan_count: sessionPlans.length,
    };
  },
});

export const get = query({
  args: {
    api_token: v.string(),
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let task;
    if (args.short_id) {
      task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!))
        .first();
    } else if (args.id) {
      // CLI-supplied id may be malformed; normalizeId returns null rather than
      // letting ctx.db.get throw "Invalid ID length". (Mirrors tasks.webGet.)
      const taskId = ctx.db.normalizeId("tasks", args.id);
      task = taskId ? await ctx.db.get(taskId) : null;
    }

    if (!task) return null;
    if (!(await canAccessTask(ctx, auth.userId, task))) return null;

    const comments = await taskCommentsWithSessionInfo(
      ctx,
      task!._id,
      auth.userId,
    );

    // Nesting context, so `cast task show` answers both "what larger work is
    // this part of" and "what did I break this into". Children come off the
    // by_parent_id index; both sides are already same-workspace by
    // construction (resolveParentTask), so no extra access check is needed.
    const parent = task.parent_id ? await ctx.db.get(task.parent_id) : null;
    const allChildren = await ctx.db
      .query("tasks")
      .withIndex("by_parent_id", (q) => q.eq("parent_id", task!._id))
      .collect();
    // Same active predicate as every other surface (chip, context, close-guard)
    // so the count `cast task show` prints matches them all.
    const children = allChildren.filter((c: any) => isActiveTask(c));

    // The audit trail: who made the task and every recorded change since. The
    // web page shows the same rows in its Activity timeline.
    const history = await ctx.db
      .query("task_history")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect();
    const assigneeNames = await assigneeNamesFor(ctx, [
      task.assignee,
      task.user_id,
      ...history.flatMap((h) => [
        h.user_id,
        ...(h.field === "assignee" ? [h.old_value, h.new_value] : []),
      ]),
    ]);
    const plan = task.plan_id ? await ctx.db.get(task.plan_id) : null;
    // The session the task's change came from (lib/taskOwner changeSessionOf): a flow run started from a plain
    // shell takes it as its subject (flows.md FL4).
    const changeSession = await changeSessionOf(ctx, task, comments);
    return {
      ...task,
      change_session:
        changeSession &&
        (await canAccessConversation(ctx, auth.userId, changeSession))
          ? {
              short_id:
                changeSession.short_id ?? String(changeSession._id).slice(0, 7),
              conversation_id: changeSession._id,
            }
          : null,
      creator_name: assigneeNames[task.user_id],
      history: history.map((h) => ({
        created_at: h.created_at,
        actor: h.user_id ? assigneeNames[h.user_id] : h.actor_type,
        action: h.action,
        field: h.field,
        old_value:
          h.field === "assignee" && h.old_value
            ? (assigneeNames[h.old_value] ?? h.old_value)
            : h.old_value,
        new_value:
          h.field === "assignee" && h.new_value
            ? (assigneeNames[h.new_value] ?? h.new_value)
            : h.new_value,
        session: h.conversation_id
          ? h.conversation_id.toString().slice(0, 7)
          : undefined,
      })),
      status_name: resolveTaskStatus(
        task,
        await loadTeamTaskStatuses(ctx, task.team_id),
      ).name,
      assignee_name: task.assignee
        ? assigneeNames[task.assignee] || task.assignee
        : undefined,
      plan:
        plan && (await canAccessPlan(ctx, auth.userId, plan))
          ? { short_id: plan.short_id, title: plan.title, status: plan.status }
          : null,
      sessions: await linkedSessionsFor(ctx, auth.userId, task, comments, 10),
      comments,
      parent: parent
        ? {
            short_id: parent.short_id,
            title: parent.title,
            status: parent.status,
          }
        : null,
      subtask_progress: subtaskProgressOf(children as any[]),
      subtasks: children.map((child) => ({
        short_id: child.short_id,
        title: child.title,
        status: child.status,
        priority: child.priority,
      })),
      links: await taskLinksOf(ctx, auth.userId, task),
      not_ready: await offFrontierReason(ctx, task),
    };
  },
});

export const context = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) return null;

    const comments = await taskCommentsWithSessionInfo(
      ctx,
      task._id,
      auth.userId,
    );

    // Linked sessions (short id + title), each with its insight summary when
    // one exists. `sessionSummaries` stays as the flat list of summaries for
    // callers that predate `sessions`.
    const sessions: {
      short_id: string;
      title: string | null;
      summary: string | null;
    }[] = [];
    for (const s of await linkedSessionsFor(
      ctx,
      auth.userId,
      task,
      comments,
      5,
    )) {
      const insight = await ctx.db
        .query("session_insights")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", s.conversation_id),
        )
        .first();
      sessions.push({
        short_id: s.short_id,
        title: s.title,
        summary: insight?.summary ?? null,
      });
    }
    const sessionSummaries = sessions
      .map((s) => s.summary)
      .filter((x): x is string => !!x);

    // Get project info
    let project = null;
    if (task.project_id) {
      const candidate = await ctx.db.get(task.project_id);
      if (
        candidate &&
        isSameWorkspace(candidate, workspaceForResource(task)) &&
        (await canAccessProject(ctx, auth.userId, candidate))
      )
        project = candidate;
    }

    // Get related docs/plans from linked conversations. Query by conversation_id
    // so each scan loads only that conversation's docs — collecting the user's
    // entire docs table (full markdown content and all) per linked conversation
    // blew the 64 MB UDF heap for prolific doc authors.
    const relatedDocs: { title: string; doc_type: string; content: string }[] =
      [];
    if (task.conversation_ids) {
      for (const convId of task.conversation_ids.slice(-3)) {
        const conversation = await ctx.db.get(convId);
        if (
          !conversation ||
          !workspacesMatch(
            workspaceForConversation(conversation),
            workspaceForResource(task),
          ) ||
          !(await canAccessConversation(ctx, auth.userId, conversation))
        )
          continue;
        const docs = await ctx.db
          .query("docs")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", convId),
          )
          .collect();
        // A session that began after the task existed came to work on it, so
        // everything it wrote is context. A session that predates the task
        // (the one that filed it, or a long-lived loop) contributes only what
        // it wrote for the task (docRelatesToTask).
        const startedAt = conversation.started_at ?? conversation._creationTime;
        const cameForTask =
          typeof startedAt === "number" && startedAt >= task.created_at;
        for (const d of docs) {
          if (
            !d.archived_at &&
            (cameForTask || docRelatesToTask(d, task)) &&
            isSameWorkspace(d, workspaceForResource(task)) &&
            (await canAccessDoc(ctx, auth.userId, d))
          ) {
            relatedDocs.push({
              title: d.title,
              doc_type: d.doc_type,
              content: d.content || "",
            });
          }
        }
      }
    }

    // Parent + subtask tree: the surface a resumed/compacted agent regrounds
    // from, so it must see the tree it (or a sibling) already built rather
    // than re-decomposing. Two levels — direct children and grandchildren —
    // matching the depth cap. Assignee names included so a second agent can
    // tell which open subtasks are already claimed.
    let parent: { short_id: string; title: string; status: string } | null =
      null;
    if (task.parent_id) {
      const p: any = await ctx.db.get(task.parent_id);
      if (p && isSameWorkspace(p, workspaceForResource(task))) {
        parent = { short_id: p.short_id, title: p.title, status: p.status };
      }
    }
    const nameOf = async (uid: any): Promise<string | undefined> => {
      if (!uid) return undefined;
      const u: any = await ctx.db.get(uid).catch(() => null);
      return u?.name || u?.github_username || undefined;
    };
    const describeChildren = async (
      parentId: Id<"tasks">,
      depth: number,
    ): Promise<any[]> => {
      const children = await ctx.db
        .query("tasks")
        .withIndex("by_parent_id", (q: any) => q.eq("parent_id", parentId))
        .collect();
      const out: any[] = [];
      for (const c of children) {
        if (!isActiveTask(c)) continue;
        out.push({
          short_id: c.short_id,
          title: c.title,
          status: c.status,
          priority: c.priority,
          assignee_name: await nameOf(
            c.assignee && /^[a-z0-9]{32}$/.test(c.assignee) ? c.assignee : null,
          ),
          subtasks: depth > 0 ? await describeChildren(c._id, depth - 1) : [],
        });
      }
      return out;
    };
    const subtasks = await describeChildren(task._id, 1);
    const subtaskProgress =
      subtasks.length > 0
        ? subtaskProgressOf(
            await ctx.db
              .query("tasks")
              .withIndex("by_parent_id", (q: any) =>
                q.eq("parent_id", task._id),
              )
              .collect(),
          )
        : null;

    return {
      task,
      parent,
      subtasks,
      subtaskProgress,
      comments,
      sessions,
      sessionSummaries,
      assignee_name: task.assignee
        ? (await assigneeNamesFor(ctx, [task.assignee]))[task.assignee] ||
          task.assignee
        : undefined,
      project: project
        ? { title: project.title, description: project.description }
        : null,
      relatedDocs,
      // TG5: found during, found here, superseded by and related, resolved.
      links: await taskLinksOf(ctx, auth.userId, task),
      // Why it is off `cast task ready` when no blocker says (TG1).
      not_ready: await offFrontierReason(ctx, task),
    };
  },
});

// The tasks linked to one conversation, read through the reverse indexes
// instead of a scan.
//
// This used to `.collect()` every task the caller owned and filter in JS on
// `conversation_ids.includes(...)`. That is O(all the caller's tasks) in both
// documents read and bytes deserialized — an account with tens of thousands of
// tasks moved megabytes per execution, which is what the 1s user-JS cap and the
// system-operation budget both measure. It timed out in production on both
// counts (Sentry JAVASCRIPT-REACT-5K and -5F).
//
// A conversation's tasks are a handful of rows, and two indexes already point
// that way, so the answer costs a bounded number of reads:
//   - entity_conversations.by_conversation — the association rail every linking
//     path dual-writes (conversationLinks.ts), the only true reverse index;
//   - tasks.by_created_from_conversation — the task a session filed, which
//     predates the rail;
//   - conversations.active_task_id — the task a session is working right now.
// Rows written before the rail existed (2026-08-01) are reachable through the
// last two, and migrations.backfillTaskConversationLinks fills the rest in.
export const TASKS_PER_CONVERSATION_LIMIT = 200;

export const webListByConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    // Gate on the conversation first, the same way conversationLinks'
    // webListForConversation does: the task list of a session the caller cannot
    // open is not theirs to enumerate.
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || !(await canAccessConversation(ctx, userId, conv))) return [];

    const candidates = new Set<string>(
      await linkedEntityIdsForConversation(ctx, args.conversationId, "task"),
    );
    // Bounded, like every other read here — a session that filed a hundred
    // tasks must not turn this back into an unbounded scan.
    const origin = await ctx.db
      .query("tasks")
      .withIndex("by_created_from_conversation", (q) =>
        q.eq("created_from_conversation", args.conversationId),
      )
      .take(TASKS_PER_CONVERSATION_LIMIT);
    for (const t of origin) candidates.add(String(t._id));
    if (conv.active_task_id) candidates.add(String(conv.active_task_id));

    const rows = [];
    for (const raw of [...candidates].slice(0, TASKS_PER_CONVERSATION_LIMIT)) {
      // Rail ids are plain strings, and a stale row may name a deleted or
      // foreign-table id; normalizeId keeps ctx.db.get from throwing on one.
      const id = ctx.db.normalizeId("tasks", raw);
      if (!id) continue;
      const t = await ctx.db.get(id);
      if (!t || !(await canAccessTask(ctx, userId, t))) continue;
      rows.push({
        _id: t._id.toString(),
        short_id: t.short_id,
        title: t.title,
        status: t.status,
        external: t.external,
      });
    }
    return rows;
  },
});

export const webGet = query({
  args: {
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    let task;
    if (args.short_id) {
      task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!))
        .first();
    } else if (args.id) {
      // ids arrive from clickable pills/links embedded in untrusted message and
      // doc content; a malformed or cross-table id would make ctx.db.get throw
      // ("Invalid ID length") and crash the page. normalizeId returns null for
      // anything that isn't a tasks id, so we degrade to "not found". (Mirrors
      // docs.webGet.)
      const taskId = ctx.db.normalizeId("tasks", args.id);
      task = taskId ? await ctx.db.get(taskId) : null;
    }

    if (!task || !(await canAccessTask(ctx, userId, task))) return null;

    const comments = await taskCommentsWithSessionInfo(ctx, task!._id, userId);

    let plan = null;
    if (task.plan_id) {
      const p = await ctx.db.get(task.plan_id);
      if (
        p &&
        isSameWorkspace(p, workspaceForResource(task)) &&
        (await canAccessPlan(ctx, userId, p))
      ) {
        plan = {
          _id: p._id,
          short_id: p.short_id,
          title: p.title,
          status: p.status,
        };
      }
    }

    return { ...task, comments, plan };
  },
});
