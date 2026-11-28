import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./functions";
import { createDataContext, scopeByProject } from "./data";
import { bucketTs } from "./presenceState";
import {
  accessJudgeFor,
  activeTeamMembershipFor,
  canAccessConversation,
  canAccessTask,
  requireAccessibleProject,
  requireTeamMembership,
  visibleInTeamList,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./lib/access";
import { notFound } from "./lib/auth";
import { listLiveManagedSessions } from "./lib/liveSessions";
import { enrichTasks } from "./lib/taskEnrich";
import { readyTasks } from "./lib/taskGraph";

export const webList = query({
  args: {
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
    include_derived: v.optional(v.boolean()),
    triage_status: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(
      v.union(v.literal("personal"), v.literal("team"), v.literal("all")),
    ),
    project_path: v.optional(v.string()),
    // Delta cursor: when provided, only return tasks with updated_at > since.
    // First subscription omits it (full snapshot); subsequent subscriptions
    // pass the high-water-mark from the prior response. The web client merges
    // results additively — rows missing from a delta are NOT removed locally,
    // since tasks are soft-deleted via status="dropped" (which bumps
    // updated_at, so the dropped row flows through naturally).
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      return {
        items: [],
        hasMore: false,
        cursor: args.since ?? 0,
        isDelta: !!args.since,
      };
    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    const since = args.since;
    const isDelta = since !== undefined;

    // Range-scan helper: when in delta mode, use the *_updated indexes so we
    // only materialize rows whose updated_at > since. Initial (non-delta) load
    // is capped to the most-recently-updated MAX_INITIAL — the unbounded
    // collect blew the Convex isolate's 96 MiB memory limit on heavy users
    // (TooMuchMemoryCarryOver, 2026-05-13). Older rows are still reachable via
    // delta polling after the cursor advances.
    // Initial-load cap. Each task row can carry a large body, and Convex loads
    // whole documents (no field projection), so a big MAX_INITIAL pulls tens of
    // MiB into the isolate and trips the memory limit (TooMuchMemoryCarryOver),
    // forcing isolate restarts that disrupt every other in-flight function on the
    // backend. 300 most-recent rows is plenty for the list view; older rows are
    // still reachable via delta polling once the cursor advances.
    const MAX_INITIAL = 300;
    const collectByUser = async (uid: any) =>
      isDelta
        ? await ctx.db
            .query("tasks")
            .withIndex("by_user_updated", (q: any) =>
              q.eq("user_id", uid).gt("updated_at", since!),
            )
            .collect()
        : await ctx.db
            .query("tasks")
            .withIndex("by_user_updated", (q: any) => q.eq("user_id", uid))
            .order("desc")
            .take(MAX_INITIAL);
    const collectByTeam = async (tid: any) =>
      isDelta
        ? await ctx.db
            .query("tasks")
            .withIndex("by_team_updated", (q: any) =>
              q.eq("team_id", tid).gt("updated_at", since!),
            )
            .collect()
        : await ctx.db
            .query("tasks")
            .withIndex("by_team_updated", (q: any) => q.eq("team_id", tid))
            .order("desc")
            .take(MAX_INITIAL);
    const collectByAssignee = async (assignee: string) =>
      isDelta
        ? await ctx.db
            .query("tasks")
            .withIndex("by_assignee_updated", (q: any) =>
              q.eq("assignee", assignee).gt("updated_at", since!),
            )
            .collect()
        : await ctx.db
            .query("tasks")
            .withIndex("by_assignee_updated", (q: any) =>
              q.eq("assignee", assignee),
            )
            .order("desc")
            .take(MAX_INITIAL);

    let tasks: any[];
    if (args.project_id) {
      const projectId = ctx.db.normalizeId("projects", args.project_id);
      if (!projectId) notFound("Project not found");
      await requireAccessibleProject(ctx, userId, projectId);
      // project_id path has no _updated index yet; fall back to collect+filter
      // (these queries are rarely the memory hot spot — they're scoped to
      // one project at a time).
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", projectId))
        .collect();
      const authorizedRows: any[] = [];
      for (const row of rows) {
        if (await canAccessTask(ctx, userId, row)) authorizedRows.push(row);
      }
      tasks = isDelta
        ? authorizedRows.filter((t: any) => t.updated_at > since!)
        : authorizedRows;
      if (args.status) {
        tasks = tasks.filter((t) => t.status === args.status);
      } else {
        tasks = tasks.filter(
          (t) => t.status !== "done" && t.status !== "dropped",
        );
      }
    } else {
      const seen = new Set<string>();
      const allTasks: any[] = [];
      const pushUnique = (t: any) => {
        const id = String(t._id);
        if (!seen.has(id)) {
          seen.add(id);
          allTasks.push(t);
        }
      };

      // Scope scans run in parallel: this query dies with "timed out performing
      // too many system operations" when serial index reads stack up under a
      // slow-backend window, so never await these one at a time.
      if (args.workspace === "team" && args.team_id) {
        // TEAM VIEW: fetch ALL tasks for this team — no per-status limits.
        // Client does all filtering (status, source, assignee, priority).
        // STRICTLY this team's tasks: a teamless task lives in its owner's
        // personal workspace only, even when assigned to the viewer — the old
        // "rescue orphans assigned to me" union here is exactly how personal
        // tasks leaked into team views. Teamless assigned tasks stay reachable
        // in the personal view, whose assignee union below covers them. The
        // assignee scan here rescues only SAME-TEAM tasks assigned to me that
        // fell outside the team scan's MAX_INITIAL cap.
        const [teamTasks, assignedTasks] = await Promise.all([
          collectByTeam(args.team_id),
          collectByAssignee(String(userId)),
        ]);
        // The routing index returns every task tagged to the team, including
        // ones whose ACCESS key is user:<owner> (private inside a team). The
        // bootstrap floor must agree with byIds and the sync log's projection,
        // so filter through the one access rule (sync fast path on stored keys).
        for (const t of teamTasks) {
          if (await visibleInTeamList(ctx, userId, "tasks", t, args.team_id))
            pushUnique(t);
        }
        for (const t of assignedTasks) {
          if (String(t.team_id) === String(args.team_id)) pushUnique(t);
        }
      } else if (args.workspace === "all") {
        // GLOBAL VIEW: every team the user belongs to + personal tasks
        // (creator or assignee with no team). Used by the client to keep
        // the inbox store warm for cross-team mention search.
        const memberships = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
          .collect();
        const [teamLists, userTasks, assignedTasks] = await Promise.all([
          Promise.all(memberships.map((m) => collectByTeam(m.team_id))),
          collectByUser(userId),
          collectByAssignee(String(userId)),
        ]);
        for (let i = 0; i < teamLists.length; i++) {
          for (const t of teamLists[i]) {
            if (
              await visibleInTeamList(
                ctx,
                userId,
                "tasks",
                t,
                memberships[i].team_id,
              )
            )
              pushUnique(t);
          }
        }
        for (const t of userTasks) pushUnique(t);
        for (const t of assignedTasks) pushUnique(t);
      } else if (args.workspace === "personal") {
        // PERSONAL VIEW: tasks with no team_id that are mine — either as
        // creator OR assignee. Without the assignee union, a task assigned
        // to me by someone else (e.g. an ops bot) with no team_id is
        // invisible in every view.
        const [userTasks, assignedTasks] = await Promise.all([
          collectByUser(userId),
          collectByAssignee(String(userId)),
        ]);
        for (const t of userTasks) {
          if (!t.team_id) pushUnique(t);
        }
        for (const t of assignedTasks) {
          if (!t.team_id) pushUnique(t);
        }
      } else {
        // UNSCOPED: all user's tasks (creator or assignee).
        const [userTasks, assignedTasks] = await Promise.all([
          collectByUser(userId),
          collectByAssignee(String(userId)),
        ]);
        for (const t of userTasks) pushUnique(t);
        for (const t of assignedTasks) pushUnique(t);
      }
      tasks = allTasks;
    }
    if (args.project_path) {
      tasks = scopeByProject(tasks, args.project_path);
    }

    // Status filtering (supports comma-separated values from frontend)
    if (args.status) {
      const statusSet = new Set(args.status.split(","));
      tasks = tasks.filter((t: any) => statusSet.has(t.status));
    }

    if (args.triage_status) {
      tasks = tasks.filter((t: any) => t.triage_status === args.triage_status);
    } else if (!args.include_derived) {
      tasks = tasks.filter(
        (t: any) => !t.triage_status || t.triage_status === "active",
      );
    }

    if (args.execution_status) {
      tasks = tasks.filter(
        (t: any) => t.execution_status === args.execution_status,
      );
    }

    if (args.ready) {
      // The same rule as the CLI list (TG1), blockers and parents read from the database.
      tasks = (await readyTasks(ctx, tasks, { viewer: String(userId) })).ready;
    }

    // Return ALL tasks — no server-side pagination.
    // Client-side filtering handles everything; we never want to silently drop items.
    const result = tasks;

    // Compute the delta cursor from the *unfiltered* row set so the next
    // subscription doesn't keep re-fetching rows the local filters dropped.
    // For full-snapshot mode (no `since`) cursor still reflects the newest
    // row seen, so the next page can switch to delta cleanly.
    let cursor = since ?? 0;
    for (const t of tasks) {
      if (typeof t.updated_at === "number" && t.updated_at > cursor)
        cursor = t.updated_at;
    }

    await enrichTasks(ctx, userId, result);
    return { items: result, hasMore: false, cursor, isDelta };
  },
});

// Change-feed batch fetch: current state for a set of task ids the user can
// access (own or team). Same enriched row shape as webList, comments included
// (reuses enrichTasks), so the client merges via syncTable("tasks"). No status
// filter — a dropped task comes back with status:"dropped" and the client's
// read-time filter hides it.
// Inaccessible / gone ids are omitted; callers prune ids the response omits
// (authorized absence). Consumers: the sync-log applier (syncLog.ts / web
// use-sync-change-feed.ts) and, for deployed old bundles, changeFeed.ts.
export const webGetByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [] };
    const result: any[] = [];
    for (const raw of args.ids.slice(0, 300)) {
      const id = ctx.db.normalizeId("tasks", raw);
      if (!id) continue;
      const task = await ctx.db.get(id);
      if (!task || !(await canAccessTask(ctx, userId, task))) continue;
      result.push(task);
    }
    await enrichTasks(ctx, userId, result);
    return { items: result };
  },
});

// Full, uncapped task loader — paginated so the client can crawl EVERY task in
// a workspace into its store without the 96 MiB isolate OOM that an unbounded
// collect triggers (TooMuchMemoryCarryOver). webList caps the live snapshot at
// the 300 most-recently-updated rows; on a busy team that window is entirely
// consumed by recently-dropped tasks, hiding cold open tasks (e.g. ones assigned
// to teammates) forever — there was no "load more". This query is the load-more:
// the client (useSyncTasks) pages through it one-shot (NOT a live subscription),
// pacing the crawl, and surfaces a visible "loading all tasks" state.
//
// Soft-deleted (status="dropped") rows are excluded — they are deletions the UI
// never renders; loading thousands of them would only waste pages and store.
// Scoping mirrors webList: team view → all team tasks; personal/unscoped → mine.
export const webListPaginated = query({
  args: {
    workspace: v.optional(
      v.union(v.literal("personal"), v.literal("team"), v.literal("all")),
    ),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
    include_derived: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
    // Incremental top-up: when set, only page rows with updated_at > since. The
    // client passes its persisted watermark so a periodic reconcile re-crawls a
    // handful of changed rows instead of the whole table (the "syncing 4,529"
    // every few minutes). Omitted on the FIRST crawl for a workspace (cold cache)
    // so that initial pass is a full backfill. Mirrors webList's `since` delta.
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    // Defensive clamp. Each row carries its comments and their sessions'
    // session_info (enrichTasks): a comments query per task, then a read, an
    // owner lookup, a membership lookup and a role read per session that
    // commented. A function may make 4,096 of those, and a team page of 300
    // comment-heavy tasks went past it ("Too many reads", 92 refused pages on
    // 2026-11-12), so that client's backfill failed every time it ran. 100
    // keeps a page well inside the cap. The client pages on isDone, so a
    // smaller page only adds round trips to a cold-cache backfill.
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 100),
    };

    const since = args.since;
    const isDelta = since !== undefined;

    // Primary stream: newest-updated first, scoped to the workspace. Team view
    // reads by_team_updated so EVERY team task (any assignee, any age) is
    // reachable across pages — the whole point of the fix. In delta mode the
    // index range is bounded to updated_at > since (only changed rows), so a
    // top-up crawl is cheap regardless of how big the table is.
    const range = (q: any) => (isDelta ? q.gt("updated_at", since!) : q);
    const base =
      args.workspace === "team" && args.team_id
        ? ctx.db
            .query("tasks")
            .withIndex("by_team_updated", (q: any) =>
              range(q.eq("team_id", args.team_id)),
            )
            .order("desc")
        : ctx.db
            .query("tasks")
            .withIndex("by_user_updated", (q: any) =>
              range(q.eq("user_id", userId)),
            )
            .order("desc");

    const result = await base.paginate(paginationOpts);

    // Full backfill skips the dropped graveyard (never load thousands of dead
    // rows). A delta pass KEEPS dropped rows: a task dropped on another device
    // must flow through as a status="dropped" overlay so this client's read-time
    // filter hides it — otherwise it would linger in the cache forever.
    let rows = isDelta
      ? result.page
      : result.page.filter((t: any) => t.status !== "dropped");
    // Strict workspace boundary: the personal crawl walks by_user_updated, which
    // also holds the user's team-tagged tasks — those belong to their team
    // workspaces and must not ship in a personal-scoped response.
    if (args.workspace === "personal")
      rows = rows.filter((t: any) => !t.team_id);
    // Team crawl: same access rule as webList (private-inside-a-team rows never
    // reach a teammate's floor).
    if (args.workspace === "team" && args.team_id) {
      const kept: any[] = [];
      for (const t of rows)
        if (await visibleInTeamList(ctx, userId, "tasks", t, args.team_id))
          kept.push(t);
      rows = kept;
    }
    if (args.project_path) rows = scopeByProject(rows, args.project_path);
    await enrichTasks(ctx, userId, rows);

    return {
      page: rows,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// Companion to webList: the dormant origin-session badge data ("who · when" on
// a task row's session pill). The client calls this ONE-SHOT (convex.query, not
// a subscription) for conversation ids referenced by its task rows: a dormant
// session's badge fields don't change, and a live one is covered by the
// webActiveSessions overlay — so subscribing would only re-run a query per
// message written to any referenced conversation, which is exactly the churn
// enrichTasks used to inflict on webList. Access mirrors canAccessConversation;
// ids the caller can't see are omitted.
//
// Returns: { [conversationId]: { conversation_id, session_id, title?, agent_type?, started_by?, last_message_at?, message_count? } }
export const webTaskOrigins = query({
  args: { conversation_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return {};
    const out: Record<string, any> = {};
    const nameCache = new Map<string, string | undefined>();
    const ownerName = async (uid: any): Promise<string | undefined> => {
      const key = uid.toString();
      if (nameCache.has(key)) return nameCache.get(key);
      let name: string | undefined;
      try {
        const u = await ctx.db.get(uid as Id<"users">);
        name = u ? u.name || u.email || undefined : undefined;
      } catch {}
      nameCache.set(key, name);
      return name;
    };
    await Promise.all(
      args.conversation_ids.slice(0, 300).map(async (raw) => {
        const id = ctx.db.normalizeId("conversations", raw);
        if (!id) return;
        const c = await ctx.db.get(id);
        if (!c || !c.session_id) return;
        if (!(await canAccessConversation(ctx, userId, c as any))) return;
        out[raw] = {
          conversation_id: raw,
          session_id: c.session_id,
          title: c.title || undefined,
          agent_type: c.agent_type || undefined,
          started_by: await ownerName(c.user_id),
          last_message_at: c.updated_at,
          message_count: c.message_count,
        };
      }),
    );
    return out;
  },
});

// Companion to webList: the live-session overlay for the task list. Tiny
// payload, but invalidates on every daemon heartbeat — keep it separate from
// webList so the 13MB task payload doesn't re-ship on every heartbeat.
//
// Returns: { [taskId]: { _id, session_id, title?, agent_status?, agent_type?, started_by?, last_message_at? } }
// Split from the query wrapper (like performListActiveSessions) so the body is
// callable from the debugTmp timing probes without auth.
export const webActiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return {};
    return performWebActiveSessions(ctx, userId);
  },
});

export async function performWebActiveSessions(
  ctx: { db: any },
  userId: Id<"users">,
) {
  const managedSessions = await listLiveManagedSessions(ctx, userId);

  // started_by = the session owner's display name, last_message_at =
  // conv.updated_at (bumped on every message). Together the badge reads
  // "who · when" ("ashot · now"), consistent with the dormant origin badge.
  // Owner names are cached since this overlay is scoped to the viewer's own
  // daemons — typically one or two distinct users. The cache holds promises
  // so the concurrent per-session lookups below coalesce into one fetch.
  const nameCache = new Map<string, Promise<string | undefined>>();
  const ownerName = (uid: any): Promise<string | undefined> => {
    const key = uid.toString();
    const cached = nameCache.get(key);
    if (cached) return cached;
    const p: Promise<string | undefined> = ctx.db
      .get(uid as Id<"users">)
      .then((u: any) => (u ? u.name || u.email || undefined : undefined))
      .catch(() => undefined);
    nameCache.set(key, p);
    return p;
  };

  // Per-session reads run concurrently (like webTaskOrigins): with dozens of
  // live sessions, a sequential get/access-check chain is hundreds of serial
  // round-trips and times out under backend load ("too many system operations").
  const entries = await Promise.all(
    managedSessions.map(async (s) => {
      if (!s.conversation_id) return null;
      const conv = await ctx.db.get(s.conversation_id);
      if (
        !conv ||
        !(await canAccessConversation(ctx, userId, conv)) ||
        !conv.active_task_id
      )
        return null;
      const task = await ctx.db.get(conv.active_task_id);
      if (
        !task ||
        !workspacesMatch(
          workspaceForConversation(conv),
          workspaceForResource(task),
        ) ||
        !(await canAccessTask(ctx, userId, task))
      )
        return null;
      return [
        conv.active_task_id.toString(),
        {
          _id: conv._id.toString(),
          session_id: conv.session_id,
          title: conv.title || undefined,
          agent_status: s.agent_status || undefined,
          agent_type: conv.agent_type || undefined,
          started_by: await ownerName(conv.user_id),
          // Bucketed to the minute: this overlay is always mounted on the task
          // board and updated_at moves on every streamed flush, so the raw value
          // re-pushed the whole map seconds apart. The badge renders it as a
          // relative age (relTimeShort in LivenessDot), which is coarser than a
          // minute. Invalidation is unchanged.
          last_message_at: bucketTs(conv.updated_at),
        },
      ] as const;
    }),
  );
  const map: Record<
    string,
    {
      _id: string;
      session_id: string;
      title?: string;
      agent_status?: string;
      agent_type?: string;
      started_by?: string;
      last_message_at?: number;
    }
  > = {};
  for (const e of entries) if (e) map[e[0]] = e[1];
  return map;
}

// Compact projection of tasks for mention/@-search store sync. Returns only
// the fields needed to render and filter in the dropdown — orders of magnitude
// smaller than `webList`, which enriches with creator/plan/active-session data.
export const webMentionList = query({
  args: {
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(
      v.union(v.literal("personal"), v.literal("team"), v.literal("all")),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    // Cap to a small recent slice — the mention dropdown only renders ~6–12
    // results (top-6-per-type in useMentionQuery), and the long tail is served
    // by `mentionSearch`. `.take()` loads whole rows, so a small cap keeps the
    // scan well under both the 8192-array return limit and the 64 MB isolate
    // memory cap (see docs.webMentionList). Per-team cap keeps any single
    // high-volume team from crowding out smaller teams the user belongs to.
    const MAX_TOTAL = 50;
    const MAX_PER_TEAM = 25;
    const seen = new Set<string>();
    const tasks: any[] = [];
    const pushUnique = (t: any) => {
      if (tasks.length >= MAX_TOTAL) return;
      const id = String(t._id);
      if (!seen.has(id)) {
        seen.add(id);
        tasks.push(t);
      }
    };
    // by_team_id is the ROUTING index: a task routed to a team can still be
    // private to its owner (workspace user:<owner>), so every team row passes
    // the access judge before its title is returned.
    const judge = await accessJudgeFor(ctx, userId);
    const pushReadable = async (rows: any[]) => {
      for (const t of rows) if (await judge("tasks", t)) pushUnique(t);
    };

    if (args.workspace === "all") {
      // The person's own rows first: filled after the teams, two busy teams
      // took every slot and a search could not find their own to-dos.
      const userTasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(MAX_PER_TEAM);
      for (const t of userTasks) pushUnique(t);
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      for (const m of memberships) {
        if (tasks.length >= MAX_TOTAL) break;
        const teamTasks = await ctx.db
          .query("tasks")
          .withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id))
          .order("desc")
          .take(MAX_PER_TEAM);
        await pushReadable(teamTasks);
      }
    } else if (args.workspace === "team" && args.team_id) {
      const teamTasks = await ctx.db
        .query("tasks")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id))
        .order("desc")
        .take(MAX_TOTAL);
      await pushReadable(teamTasks);
    } else {
      const userTasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(MAX_TOTAL);
      for (const t of userTasks) {
        if (args.workspace === "personal" && t.team_id) continue;
        pushUnique(t);
      }
    }

    return {
      items: tasks.map((t: any) => ({
        _id: String(t._id),
        title: t.title,
        short_id: t.short_id,
        status: t.status,
        priority: t.priority,
        updated_at: t.updated_at,
        team_id: t.team_id ?? null,
        user_id: t.user_id ?? null,
      })),
    };
  },
});

// Team-scoped list for web
export const webTeamList = query({
  args: {
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    promoted_only: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let teamId = args.team_id;
    if (!teamId) {
      teamId = (await activeTeamMembershipFor(ctx, userId))?.teamId;
    }
    if (!teamId) return [];
    const db = await createDataContext(ctx, {
      userId,
      workspace: "team",
      team_id: teamId,
    });

    let tasks = await db.query("tasks").collect();

    if (args.status) {
      tasks = tasks.filter((t: any) => t.status === args.status);
    } else {
      tasks = tasks.filter(
        (t: any) => t.status !== "done" && t.status !== "dropped",
      );
    }

    if (args.execution_status) {
      tasks = tasks.filter(
        (t: any) => (t as any).execution_status === args.execution_status,
      );
    }

    if (args.promoted_only) {
      tasks = tasks.filter(
        (t: any) => !t.triage_status || t.triage_status === "active",
      );
    }

    tasks.sort(
      (a: any, b: any) =>
        (b.updated_at || b._creationTime || 0) -
        (a.updated_at || a._creationTime || 0),
    );
    return tasks.slice(0, args.limit || 300);
  },
});
