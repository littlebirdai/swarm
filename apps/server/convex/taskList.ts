import { v, type ObjectType } from "convex/values";
import { chainAssignees } from "@codecast/org/orgAssignee";
import { isStaleTask } from "@codecast/tasks/frontier";
import { blockersHoldingBack, readinessOf } from "@codecast/tasks/graph";
import {
  TASK_STATUS_CATEGORIES,
  TERMINAL_TASK_CATEGORIES,
  findTeamTaskStatus,
  isTaskStatusCategory,
  isTerminalTaskStatus,
  resolveTaskStatus,
  type TeamTaskStatus,
} from "@codecast/tasks/statuses";
import type { Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { createDataContext, explicitWorkspace } from "./data";
import {
  accessStampFromDoc,
  activeTeamMembershipFor,
  authorizedFor,
  canAccessPlan,
  canAccessTask,
  heldKeysFor,
  isSameWorkspace,
  resolveSessionConversation,
  workspaceForResource,
} from "./lib/access";
import { requireInitiative } from "./lib/initiativeRef";
import { allRolesInBoundary } from "./lib/orgAccess";
import { projectTasks, projectTasksIn } from "./lib/projectWork";
import {
  assigneeInfoFor,
  assigneeNameOf,
  boundaryOfWorkspace,
  resolveAssigneeStr,
  resolveAssigneeToUserId,
} from "./lib/taskAssignees";
import {
  buildDependencyChain,
  orderFrontier,
  readinessLookups,
  readyTasks,
} from "./lib/taskGraph";
import { loadTeamTaskStatuses } from "./lib/taskStatuses";

const listArgs = {
  api_token: v.string(),
  project_id: v.optional(v.string()),
  // `cast task ls --initiative in-N`: the tasks of the initiative's projects.
  initiative: v.optional(v.string()),
  status: v.optional(v.string()),
  execution_status: v.optional(v.string()),
  ready: v.optional(v.boolean()),
  // With ready: also surface open subtasks of actively-worked parents.
  include_subtasks: v.optional(v.boolean()),
  limit: v.optional(v.number()),
  team: v.optional(v.boolean()),
  // An explicit workspace (`cast task ls --team <name>|personal`): a named
  // team, or the personal workspace as a positive value, whatever the
  // active team pointer or the directory mapping says.
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
  include_derived: v.optional(v.boolean()),
  include_done: v.optional(v.boolean()),
  project_path: v.optional(v.string()),
  query: v.optional(v.string()),
  assignee: v.optional(v.string()),
  // A person ("me", a name, a handle): their tasks plus the tasks of every
  // role that reports up to them (`cast task ls --chain me`). The chain is
  // read from the roles' reports_to at query time, never stored on a task
  // (org-roles-run-work.md R5).
  chain: v.optional(v.string()),
  plan_id: v.optional(v.string()),
  // Case-insensitive match against the task's labels (CLI --label).
  label: v.optional(v.string()),
  // Ephemeral bookkeeping (TG9) is left out unless asked for; the ready
  // frontier keeps the caller's own: the asking session's (conversation_id,
  // as `cast task ready` sends it), else the person's.
  include_ephemeral: v.optional(v.boolean()),
  conversation_id: v.optional(v.string()),
};

// The status categories a search reads, one index range each so finished
// work cannot crowd open matches out of the bounded take; null reads every
// status (--all, or a team status name resolved per row afterwards).
function searchCategories(args: {
  status?: string;
  include_done?: boolean;
}): string[] | null {
  if (isTaskStatusCategory(args.status)) return [args.status];
  if (!args.status && !args.include_done)
    return TASK_STATUS_CATEGORIES.filter(
      (s) => !TERMINAL_TASK_CATEGORIES.includes(s),
    );
  return null;
}

const LIST_LIMIT = 300;
// The triage states of a row that is not derived (keepRow's rule).
const NOT_DERIVED = [undefined, "active"] as const;
const SEARCH_TAKE = 120;
const RECENT_SCAN = 300;

// `cast task ls -q`: one workspace's tasks matching the words, read in bounded
// slices. Collecting a large team's open set to filter it in memory ran out of
// the server's 64 MB (Union, 2026-11). Titles come from the search index; a
// short id is looked up directly; descriptions are matched over the most
// recently touched tasks. Rows are keyed by id; the caller's filters run after.
async function searchWorkspaceTasks(
  ctx: QueryCtx,
  workspace: string,
  query: string,
  categories: string[] | null,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const keep = (row: any) => {
    if (row && row.workspace === workspace) out.set(String(row._id), row);
  };
  const ranges = categories ?? [null];
  for (const status of ranges) {
    const hits = await ctx.db
      .query("tasks")
      .withSearchIndex("search_tasks_v2", (s: any) => {
        const q = s.search("title", query).eq("workspace", workspace);
        return status ? q.eq("status", status) : q;
      })
      .take(categories ? SEARCH_TAKE : SEARCH_TAKE * 2);
    hits.forEach(keep);
  }
  const byShortId = await ctx.db
    .query("tasks")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", query.toLowerCase()))
    .first();
  keep(byShortId);
  const lower = query.toLowerCase();
  const recent = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_updated", (q: any) => q.eq("workspace", workspace))
    .order("desc")
    .take(RECENT_SCAN);
  for (const row of recent) {
    if (
      (row.description || "").toLowerCase().includes(lower) ||
      (row.title || "").toLowerCase().includes(lower)
    )
      keep(row);
  }
  return out;
}

async function listTasksCore(
  ctx: QueryCtx,
  args: ObjectType<typeof listArgs> & {
    cursor?: string | null;
    page_size?: number;
  },
) {
  const auth = await verifyApiToken(ctx, args.api_token, false);
  if (!auth) throw new Error("Unauthorized");
  if (args.chain && args.assignee)
    throw new Error(
      "Use --assignee or --chain, not both: --chain already covers the person and every role under them.",
    );

  let teamIdForScope: Id<"teams"> | undefined;
  if (args.team) {
    teamIdForScope = (await activeTeamMembershipFor(ctx, auth.userId))?.teamId;
  }
  // A listing (a plain list or a page) is the workspace's: the CLI's working
  // directory picks the workspace through its mapping and narrows nothing,
  // the same rows the search, assignee and project branches read. The ready
  // frontier stays in this checkout, because `cast task ready --claim` and the
  // claim frontier must not hand a session work filed from another repo.
  const db = await createDataContext(ctx, {
    userId: auth.userId,
    project_path: args.project_path,
    narrowToProject: !!args.ready,
    ...explicitWorkspace(
      args,
      args.team && teamIdForScope
        ? { workspace: "team" as const, team_id: teamIdForScope }
        : {},
    ),
  });

  // The assignee values to read: one for --assignee, the person and every
  // role under them for --chain.
  const boundary = boundaryOfWorkspace(db.workspace);
  let assignees: string[] = [];
  // A read names what a task holds: a retired role's tasks can still be
  // listed by its handle or id, where a write would refuse the role.
  if (args.assignee) {
    const one = await resolveAssigneeStr(
      ctx,
      args.assignee,
      auth.userId,
      boundary,
      { read: true },
    );
    if (one) assignees = [one];
  } else if (args.chain) {
    const head = await resolveAssigneeToUserId(
      ctx,
      (await resolveAssigneeStr(ctx, args.chain, auth.userId, boundary, {
        read: true,
      })) ?? "",
      boundary.team_id,
    );
    if (!head)
      throw new Error(
        `No person matches "${args.chain}". --chain takes a person: me, a name or a GitHub handle.`,
      );
    assignees = chainAssignees(head, await allRolesInBoundary(ctx, boundary));
  }

  let tasks: any[];
  let nextPage: string | null = null;
  let paged = false;
  // Rows the title search matched by word, kept even where the words are not
  // one substring of the title.
  let searched: Map<string, any> | null = null;
  // The filters that judge one row by itself. A bounded read applies them as
  // it streams, so its limit counts rows the list will show; every read
  // applies them again below.
  const planTaskIdList: any[] = args.plan_id
    ? [
        ...new Set(
          (
            (
              await ctx.db
                .query("plans")
                .withIndex("by_short_id", (q) =>
                  q.eq("short_id", args.plan_id!),
                )
                .first()
            )?.task_ids || []
          ).map((id: any) => String(id)),
        ),
      ]
    : [];
  const planTaskIds = args.plan_id ? new Set(planTaskIdList) : null;
  const wantedQuery = args.query?.toLowerCase();
  const wantedLabel = args.label?.toLowerCase();
  const keepRow = (t: any): boolean => {
    if (
      !args.include_derived &&
      t.triage_status &&
      t.triage_status !== "active"
    )
      return false;
    if (!args.include_ephemeral && !args.ready && t.ephemeral) return false;
    if (args.execution_status && t.execution_status !== args.execution_status)
      return false;
    if (planTaskIds && !planTaskIds.has(String(t._id))) return false;
    if (
      wantedQuery &&
      !(
        searched?.has(String(t._id)) ||
        (t.title || "").toLowerCase().includes(wantedQuery) ||
        (t.description || "").toLowerCase().includes(wantedQuery) ||
        (t.short_id || "").toLowerCase().includes(wantedQuery)
      )
    )
      return false;
    if (
      wantedLabel &&
      !(t.labels || []).some((l: string) => l.toLowerCase() === wantedLabel)
    )
      return false;
    return true;
  };

  // The assignee and project_id indexes are global — they return rows the
  // caller may not be able to see, so those two branches get an explicit
  // owner-or-team-member filter below. The other branches are already
  // user/workspace-scoped.
  let needsAccessFilter = false;
  if (assignees.length > 0) {
    // When filtering by assignee, query the assignee index directly so
    // tasks assigned to the user but missing team_id aren't dropped by
    // the workspace-scoped query.
    tasks = (
      await Promise.all(
        assignees.map((assignee) =>
          ctx.db
            .query("tasks")
            .withIndex("by_assignee_updated", (q: any) =>
              q.eq("assignee", assignee),
            )
            .collect(),
        ),
      )
    ).flat();
    needsAccessFilter = true;
  } else if (args.project_id || args.initiative) {
    // A task reaches an initiative through its project. With both flags the
    // project must be one the initiative names. projectTasks decides access
    // from each row's workspace stamp, the way `cast initiative show`
    // counts, so a task routed to a team but readable by its owner only is
    // not listed to the team.
    const inInitiative = args.initiative
      ? (
          await requireInitiative(
            ctx,
            auth.userId as Id<"users">,
            args.initiative,
          )
        ).project_ids.map(String)
      : null;
    const projectIds: string[] = args.project_id
      ? !inInitiative || inInitiative.includes(args.project_id)
        ? [args.project_id]
        : []
      : inInitiative!;
    // Known status categories read one index range each, newest first, and
    // stop at the limit; the frontier (--ready) needs every open row.
    // Every category when finished work is wanted too; a team status name
    // is resolved per row, so it reads the project.
    const statuses =
      searchCategories(args) ?? (args.status ? null : TASK_STATUS_CATEGORIES);
    const bound = {
      ...(args.ready ? {} : { limit: args.limit || LIST_LIMIT, keep: keepRow }),
      ...(args.include_derived ? {} : { triage: NOT_DERIVED }),
    };
    tasks = (
      await Promise.all(
        projectIds.map((projectId) =>
          statuses
            ? projectTasksIn(
                ctx,
                auth.userId as Id<"users">,
                projectId as any,
                statuses,
                bound,
              )
            : projectTasks(ctx, auth.userId as Id<"users">, projectId as any),
        ),
      )
    ).flat();
  } else if (args.plan_id) {
    // A plan names its tasks: read those, never the workspace. Collecting a
    // large team's tasks to keep one plan's 15 ran out of the server's 64 MB
    // (Union, Nov 17, ct-95906).
    tasks = (
      await Promise.all(planTaskIdList.map((id) => db.getScoped("tasks", id)))
    ).filter(Boolean);
    if (args.query?.trim())
      searched = await searchWorkspaceTasks(
        ctx,
        db.workspaceKey,
        args.query.trim(),
        searchCategories(args),
      );
  } else if (args.cursor !== undefined) {
    const got = await db
      .query("tasks")
      .withIndex("by_workspace_updated", (q: any) =>
        q.eq("workspace", db.workspaceKey),
      )
      .order("desc")
      .paginate({
        cursor: args.cursor,
        numItems: Math.min(Math.max(args.page_size ?? 200, 1), 500),
      });
    tasks = got.page;
    paged = true;
    nextPage = got.isDone ? null : got.continueCursor;
  } else if (args.query?.trim()) {
    searched = await searchWorkspaceTasks(
      ctx,
      db.workspaceKey,
      args.query.trim(),
      searchCategories(args),
    );
    tasks = [...searched.values()];
  } else {
    // The status filters below run in the database first where they can, so
    // rows they would drop never reach JS memory: finished work is most of a
    // team's table. A team status name ("today") is resolved per row below.
    // Each wanted category is its own index range: a filter would still read
    // every finished task (22k rows on a large team) to drop them. Legacy
    // rows (no stored key) ride along on every range; the map dedupes them.
    const categories = searchCategories(args);
    if (categories) {
      const byId = new Map<string, any>();
      for (const status of categories) {
        const rows = await db
          .query("tasks")
          .withIndex("by_workspace_status", (q: any) =>
            q.eq("workspace", db.workspaceKey).eq("status", status),
          )
          .collect();
        for (const row of rows) byId.set(String(row._id), row);
      }
      tasks = [...byId.values()];
    } else {
      tasks = await db.query("tasks").collect();
    }
  }

  if (needsAccessFilter) {
    // Access is the row's workspace stamp, never the team it is routed to
    // (CLAUDE.md): a teammate's task routed to the team but readable by its
    // owner only is not listed to whoever asks for the role's tasks. The
    // keys the caller holds are read once; a row with a stored key is judged
    // in memory by the access layer's own evaluator, and a row minted before
    // the key backfill takes the lazy path.
    const held = await heldKeysFor(ctx, auth.userId);
    const keep = await Promise.all(
      tasks.map((t: any) =>
        t.workspace
          ? authorizedFor(
              accessStampFromDoc("tasks", t),
              String(auth.userId),
              held,
            )
          : canAccessTask(ctx, auth.userId, t),
      ),
    );
    tasks = tasks.filter((_: any, i: number) => keep[i]);
  }

  // Each task resolves against its own team's statuses, loaded once per team.
  const teamStatuses = new Map<string, Promise<TeamTaskStatus[]>>();
  const statusesOf = (t: any) => {
    const key = String(t.team_id ?? "");
    if (!teamStatuses.has(key))
      teamStatuses.set(key, loadTeamTaskStatuses(ctx, t.team_id));
    return teamStatuses.get(key)!;
  };

  if (args.status) {
    // A category matches every task in it; a team status ("today") matches
    // the tasks that render as that status.
    const ref = args.status;
    const keep = await Promise.all(
      tasks.map(async (t: any) => {
        if (isTaskStatusCategory(ref)) return t.status === ref;
        const statuses = await statusesOf(t);
        return (
          findTeamTaskStatus(statuses, ref)?.id ===
          resolveTaskStatus(t, statuses).id
        );
      }),
    );
    tasks = tasks.filter((_: any, i: number) => keep[i]);
  } else if (!args.include_done) {
    tasks = tasks.filter(
      (t: any) => !TERMINAL_TASK_CATEGORIES.includes(t.status),
    );
  }

  tasks = tasks.filter(keepRow);

  // Ready is graph.ts's rule (task-graph.md TG1). Blockers and parents the
  // filtered page dropped are read from the database: a finished blocker is
  // exactly what the default page leaves out. `include_subtasks` (CLI
  // --subtasks) counts subtasks of a parent being worked.
  const asker = args.conversation_id
    ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id)
    : null;
  const readiness = {
    viewer: String(auth.userId),
    viewerSession: asker ? String(asker._id) : null,
    includeSubtasks: args.include_subtasks,
  };
  let lookupsFor: Awaited<ReturnType<typeof readinessLookups>> | undefined;
  if (args.ready)
    ({ ready: tasks, lookupsFor } = await readyTasks(ctx, tasks, readiness));

  // The frontier reads in the order work should be taken (TG7); every other
  // list reads newest first.
  const now = Date.now();
  if (args.ready) tasks = await orderFrontier(ctx, tasks, now);
  else
    tasks.sort(
      (a: any, b: any) =>
        (b.updated_at || b._creationTime || 0) -
        (a.updated_at || a._creationTime || 0),
    );
  const limit = args.limit || LIST_LIMIT;
  const result = paged ? tasks : tasks.slice(0, limit);

  const assigneeInfo = await assigneeInfoFor(
    ctx,
    result.map((t: any) => t.assignee),
  );
  const statusNames = await Promise.all(
    result.map(
      async (t: any) => resolveTaskStatus(t, await statusesOf(t)).name,
    ),
  );
  // Every row carries its verdict and open blockers, so the CLI's "blocked"
  // tag and counts render from the rule, never from a raw blocked_by.
  const lookupsOf = lookupsFor
    ? lookupsFor
    : await readinessLookups(ctx, result);
  const rows = result.map((t: any, i: number) => {
    const { statusOf, parentStatusOf } = lookupsOf(t);
    return {
      ...t,
      status_name: statusNames[i],
      assignee_name: t.assignee
        ? assigneeNameOf(assigneeInfo[t.assignee]) || t.assignee
        : undefined,
      // The contract's shape (orgAssignee.ts), so the CLI tells a role from a
      // person by `kind`, never by the look of a label.
      assignee_info: t.assignee ? (assigneeInfo[t.assignee] ?? null) : null,
      parent_short_id:
        (t.parent_id ? statusOf(String(t.parent_id)) : undefined)?.short_id ??
        undefined,
      // A ready page holds only rows readyTasks already judged ready.
      ready: args.ready
        ? true
        : readinessOf(t, {
            statusOf,
            parentStatusOf,
            ...readiness,
          }).ready,
      // Structured (TG1): the reader labels them, a time wait in its own zone.
      // A closed task waits on nothing, so no reader marks it blocked.
      open_blockers: isTerminalTaskStatus(t.status)
        ? []
        : blockersHoldingBack(t, statusOf),
      // Untouched 30+ days: the frontier folds it into a count (TG7).
      ...(args.ready ? { stale: isStaleTask(t, now) } : {}),
    };
  });
  return { rows, nextPage };
}

export const list = query({
  args: listArgs,
  handler: async (ctx, args) => (await listTasksCore(ctx, args)).rows,
});

// A page of the whole board, newest touched first, and where the next one
// starts (`cast task ls --all`): one call holding every task of a large team
// ran out of memory (Union, Oct 26).
export const listPage = query({
  args: {
    ...listArgs,
    cursor: v.union(v.string(), v.null()),
    page_size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { rows, nextPage } = await listTasksCore(ctx, args);
    return { tasks: rows, cursor: nextPage };
  },
});

export const getReadyTasks = query({
  args: {
    api_token: v.string(),
    plan_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
    });

    let tasks: any[];
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan)))
        throw new Error("Plan not found");
      if (!plan.task_ids) return [];
      const planTasks: any[] = [];
      for (const tid of plan.task_ids) {
        const t = await ctx.db.get(tid);
        if (
          t &&
          isSameWorkspace(t, workspaceForResource(plan)) &&
          (await canAccessTask(ctx, auth.userId, t))
        )
          planTasks.push(t);
      }
      tasks = planTasks;
    } else {
      tasks = await db.query("tasks").collect();
    }

    return (await readyTasks(ctx, tasks, { viewer: String(auth.userId) }))
      .ready;
  },
});

export const getDependencyChain = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
    });

    const root = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!root || !(await canAccessTask(ctx, auth.userId, root)))
      throw new Error("Task not found");

    const allTasks = await db.query("tasks").collect();
    return {
      task: root,
      ...buildDependencyChain(allTasks, args.short_id),
    };
  },
});
