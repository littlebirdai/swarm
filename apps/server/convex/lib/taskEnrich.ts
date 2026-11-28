import type { Id } from "../_generated/dataModel";
import {
  canAccessConversation,
  canAccessPlan,
  isSameWorkspace,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./access";
import {
  taskCommentsWithSessionInfo,
  type CommentSessionCache,
} from "./commentSessionInfo";
import { stampGraphStatus } from "./taskGraph";

// The sessions linked to a task, named the way every other CLI surface names
// a session (short id + title), oldest first, limited to what the caller can
// see. Two sources, unioned: the task's own `conversation_ids` (sessions that
// claimed it) and the `conversation_id` on each comment (sessions that only
// reported on it — a task filed from the web and worked by agents has an
// empty `conversation_ids` and a comment trail full of sessions). `cast task
// show/context` print these so an agent that wants a task's working session
// reads it off the task instead of regexing `jx…` ids out of comment text.
export async function linkedSessionsFor(
  ctx: any,
  userId: Id<"users">,
  task: any,
  comments: {
    conversation_id?: Id<"conversations"> | null;
    created_at: number;
  }[],
  limit: number,
): Promise<
  {
    short_id: string;
    title: string | null;
    conversation_id: Id<"conversations">;
  }[]
> {
  const ordered = [
    ...(task.conversation_ids || []),
    ...[...comments]
      .sort((a, b) => a.created_at - b.created_at)
      .map((cm) => cm.conversation_id)
      .filter((id): id is Id<"conversations"> => !!id),
  ];
  const convIds = [...new Set(ordered.map(String))].slice(-limit);
  const out: {
    short_id: string;
    title: string | null;
    conversation_id: Id<"conversations">;
  }[] = [];
  for (const convId of convIds) {
    const conversation = await ctx.db.get(convId as Id<"conversations">);
    if (
      !conversation ||
      !workspacesMatch(
        workspaceForConversation(conversation),
        workspaceForResource(task),
      ) ||
      !(await canAccessConversation(ctx, userId, conversation))
    )
      continue;
    out.push({
      short_id:
        conversation.short_id ?? conversation._id.toString().slice(0, 7),
      title: conversation.title ?? null,
      conversation_id: conversation._id,
    });
  }
  return out;
}

// Enrich a page of task rows in place with comments and creator/assignee/plan
// info. The one row builder of the tasks collection: webList (the bootstrap
// floor), webListPaginated (the reconcile crawl) and webGetByIds (the sync
// log's refetch) all call it, so every channel returns one row shape for a
// viewer (tasks.convergence.test.ts). Mutates `result` in
// place — the spread form `{...t, ...}` doubled peak heap and was a top
// contributor to TooMuchMemoryCarryOver on these UDFs.
export async function enrichTasks(
  ctx: any,
  userId: Id<"users">,
  result: any[],
): Promise<any[]> {
  const allUserIds = new Set<string>();
  for (const t of result) {
    allUserIds.add(t.user_id.toString());
    if (t.assignee) allUserIds.add(t.assignee.toString());
  }
  const userMap = new Map<
    string,
    { name: string; image?: string; github_username?: string }
  >();
  await Promise.all(
    [...allUserIds].map(async (uid) => {
      // A role assignee (org-roles-run-work.md R5) is NOT read here. A role row
      // is patched on every message its sessions sync (the daily token counter),
      // so reading one would re-run and re-ship this whole list each time. The
      // client resolves a role's face from the org tree slice instead
      // (lib/liveEntities resolveAssigneeInfo), which is also what makes a
      // rename show everywhere at once. normalizeId reads no row.
      if (ctx.db.normalizeId("org_roles", uid)) return;
      try {
        const u = await ctx.db.get(uid as Id<"users">);
        if (u)
          userMap.set(uid, {
            name: u.name || u.email || "Unknown",
            image: u.image || u.github_avatar_url,
            github_username: u.github_username,
          });
      } catch {
        const lower = uid.toLowerCase();
        const u =
          (await ctx.db
            .query("users")
            .withIndex("by_github_username", (q: any) =>
              q.eq("github_username", uid),
            )
            .first()) ||
          (await ctx.db
            .query("users")
            .withIndex("by_github_username", (q: any) =>
              q.eq("github_username", lower),
            )
            .first());
        if (u) {
          userMap.set(uid, {
            name: u.name || u.email || "Unknown",
            image: u.image || u.github_avatar_url,
            github_username: u.github_username,
          });
        }
      }
    }),
  );

  const planIds = new Set<string>();
  for (const t of result) {
    if (t.plan_id) planIds.add(t.plan_id.toString());
  }
  const planMap = new Map<
    string,
    {
      _id: any;
      user_id: Id<"users">;
      team_id?: Id<"teams">;
      short_id: string;
      title: string;
      status: string;
    }
  >();
  await Promise.all(
    [...planIds].map(async (pid) => {
      try {
        const p = await ctx.db.get(pid as Id<"plans">);
        if (p && (await canAccessPlan(ctx, userId, p))) {
          planMap.set(pid, {
            _id: p._id,
            user_id: p.user_id,
            team_id: p.team_id,
            short_id: p.short_id,
            title: p.title,
            status: p.status,
          });
        }
      } catch {}
    }),
  );

  // NOTE: session enrichment is intentionally NOT inlined here — reading
  // managed_sessions or conversations from a list query subscribes it to tables
  // that churn on every heartbeat/message, re-running the query and re-shipping
  // a multi-MB response every few seconds (isolate memory churn + "too many
  // system operations" timeouts under load). The live overlay is
  // `webActiveSessions`; the dormant origin badge is `webTaskOrigins`, fetched
  // one-shot by the client (a dormant session's badge data no longer changes).
  //
  // Comments are the one join every channel carries, so the bootstrap floor,
  // the crawl and byIds write one row shape: a row that arrived by a list and
  // a row refetched by byIds (the sync log's refetch on last_comment_at) are
  // the same row. Every caller is one-shot (webList is the E8 bootstrap floor,
  // the crawl and byIds are convex.query calls), so the conversation reads the
  // session_info join makes re-run nothing. One cache serves the whole list.
  const sessionInfo: CommentSessionCache = new Map();
  await Promise.all(
    result.map(async (t) => {
      t.comments = await taskCommentsWithSessionInfo(
        ctx,
        t._id,
        userId,
        sessionInfo,
      );
    }),
  );

  for (const t of result) {
    t.creator = userMap.get(t.user_id.toString()) || null;
    t.assignee_info = t.assignee
      ? userMap.get(t.assignee.toString()) || null
      : null;
    const relatedPlan = t.plan_id
      ? planMap.get(t.plan_id.toString())
      : undefined;
    t.plan =
      relatedPlan && isSameWorkspace(relatedPlan, workspaceForResource(t))
        ? {
            _id: relatedPlan._id,
            short_id: relatedPlan.short_id,
            title: relatedPlan.title,
            status: relatedPlan.status,
          }
        : null;
    t.session_count = (t.conversation_ids || []).length;
    // The guide carries its hunks and rides the evidence read, never a list.
    delete t.change_guide;
  }
  await stampGraphStatus(ctx, result);
  return result;
}
