import { cliWatchPageOrder, readCliFiling } from "./lib/cli-inbox-reads.rules";
import { query, type QueryCtx } from "./functions";
import { v } from "convex/values";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { identityFieldsOf } from "./lib/sessionIdentityFields";
import {
  trustedStatusAt,
  isSessionActivityFresh,
  type InboxBucket,
  type SessionActivity,
} from "@codecast/inbox/inboxProjection";
import { Doc, Id } from "./_generated/dataModel";
import {
  classifyRetirement,
  normalizeWorkStateFilter,
  type WorkState,
} from "./inboxFilters";
import { matchBucketByName } from "./buckets";
import { projectOverlaps } from "./projectPaths";
import {
  getAuthenticatedUserId,
  resolveActingAuthor,
} from "./lib/conversationHelpers";
import { computeInboxSessions } from "./lib/inboxCompute";
import { makeMemoGet } from "./lib/inboxMaps";

// The `cast sessions` tally + row filter, split out of inboxForCLI as a PURE
// function over already-enriched rows. This logic has been wrong twice — a
// killed row double-counted under a comment denying it, then `-a` zeroing the
// retirement figures while listing the rows — and both times a test would have
// caught it, so it gets a seam rather than living inside a db-heavy query.
export function tallyInboxRows(
  sessions: any[],
  opts: {
    showAll?: boolean;
    stateFilter?: string | null;
    labelByConv: Map<string, string>;
    /**
     * Conversation ids the caller named explicitly (`cast sessions <id>`).
     * Subagent rows are hidden from the top-level monitor, but a row you ask
     * for by id must answer — it is the wait signal an orchestrator watches
     * for a `cast spawn --subagent` worker.
     */
    requestedIds?: Set<string>;
    // The clock the activity freshness rule reads; a query passes its frozen
    // Date.now(), a test passes a fixed instant.
    now?: number;
  },
) {
  const now = opts.now ?? Date.now();
  // `unstamped` is a HEALTH figure, not a bucket: rows this tally had to drop
  // because an upstream emitter skipped the projection. It should always read
  // 0; a non-zero value names a gap in computeInboxSessions.
  const counts = {
    working: 0,
    needs_input: 0,
    done: 0,
    dormant: 0,
    idle: 0,
    pinned: 0,
    live: 0,
    stashed: 0,
    dismissed: 0,
    killed: 0,
    below_fold: 0,
    total: 0,
    unstamped: 0,
  };
  const rows: Array<{
    id: string;
    session_id: string;
    title: string;
    short_title: string | null;
    project_path: string | null;
    updated_at: string;
    ts: number;
    message_count: number;
    agent_type?: string;
    agent_status?: string;
    hibernated_at?: number | null;
    work_state: WorkState;
    // The projection placement (shared placeInboxRow) and the fold flag, next
    // to the verdict the CLI has always tallied.
    bucket: InboxBucket;
    below_fold: boolean;
    is_killed: boolean;
    is_pinned: boolean;
    is_live: boolean;
    is_unresponsive: boolean;
    awaiting_input: boolean;
    // The park kind when the newest turn is an unresolved login / limit /
    // connection banner ("limit", "auth", ...), else null: needs_input that
    // is plumbing, not a question. The workflow runner waits out the kinds
    // that recover on their own instead of reading the park as settled.
    blocked_on: string | null;
    // Why the row's start failed (a machine's refusal, a cloud host's failed
    // preparation), else null: a hand that never started reads idle forever,
    // and the workflow runner fails its station on this instead of a timeout.
    session_error: string | null;
    idle_summary: string | null;
    thread_state: string | null;
    thread_state_status: string | null;
    last_user_message: string | null;
    label: string | null;
    active_plan: { short_id: string; title: string } | null;
    active_task: { short_id: string; title: string } | null;
    // Second-party ownership: run_by = the member whose account runs the
    // session when that isn't the caller; owner = the assigned owner if any.
    run_by: string | null;
    role: { handle: string; name: string } | null;
    owner: { name: string | null; email: string | null } | null;
    owned_by_me: boolean;
    // What the agent is doing now, only while the row is working and the
    // stamp is fresh (shared isSessionActivityFresh); null otherwise.
    activity: SessionActivity | null;
  }> = [];

  // A subagent row can arrive twice — the top-level recency scan and its
  // parent's child enumeration both emit it (the web dedups by _id; this
  // tally must too, or a requested subagent lists and counts double).
  const seenSubagents = new Set<string>();
  for (const s of sessions) {
    // Keep the monitor to top-level sessions — unless this row was named.
    if (s.is_subagent) {
      const id = s._id.toString();
      if (!opts.requestedIds?.has(id) || seenSubagents.has(id)) continue;
      seenSubagents.add(id);
    }
    // The three retirement states are TALLIES, not buckets — the same shape as
    // `pinned` and `live`, and deliberately NOT mutually exclusive with the
    // work-state counts. A rendered row lands in both its work_state figure
    // and its retirement figure (a pinned killed session is counted in `idle`,
    // `pinned`, `killed` and `total`); a collapsed row appears only in its
    // retirement figure. Counting is therefore unconditional — gating it on
    // !show_all left every figure at 0 under `-a` while the rows were listed,
    // which made `stashed` useless for its whole purpose (how many agents are
    // still running). See classifyRetirement for why killed outranks the rest.
    //
    // Only the COLLAPSE is conditional. A killed row renders through: it only
    // reaches here while pinned (shouldShowInInbox drops killed-and-unpinned),
    // and pinning is how you hold onto a killed row — swallowing it was the
    // CLI overriding a decision the server already made. Stashed and dismissed
    // keep collapsing, mirroring the web's separate parked group, so
    // already-triaged sessions don't inflate the active buckets; `-a` lists them.
    const retired = classifyRetirement(s);
    if (retired) counts[retired]++;
    if (retired && retired !== "killed" && !opts.showAll) continue;
    // The verdict is STAMPED upstream (computeInboxSessions with `projection`
    // runs the shared placeInboxRow); this tally never classifies — one
    // classifier, one alphabet (sync-convergence C3).
    const work_state: WorkState = s.work_state;
    const bucket: InboxBucket = s.bucket;
    // A stampless row is a bug in whoever emitted it, but it must cost ONE
    // ROW, not the inbox. Throwing here failed the whole query, so a single
    // unstamped subagent turned `cast sessions` into "Internal error" and hid
    // every other session the user has (ct-49761). Skip it, count it, and name
    // it in the logs so the upstream gap stays visible instead of silent.
    if (!work_state || !bucket) {
      counts.unstamped++;
      console.error(
        `tallyInboxRows: row ${s._id} is not stamped with a projection — skipped`,
      );
      continue;
    }
    const is_live = !!s.is_connected && s.agent_status !== "hibernated";

    counts.total++;
    counts[work_state]++;
    if (s.is_pinned) counts.pinned++;
    if (is_live) counts.live++;
    if (s.below_fold) counts.below_fold++;
    const rowLabel = opts.labelByConv.get(s._id.toString()) ?? null;

    if (opts.stateFilter === "pinned" && !s.is_pinned) continue;
    if (opts.stateFilter === "live" && !is_live) continue;
    if (opts.stateFilter === "hibernated" && s.agent_status !== "hibernated")
      continue;
    if (
      opts.stateFilter &&
      opts.stateFilter !== "pinned" &&
      opts.stateFilter !== "live" &&
      opts.stateFilter !== "hibernated" &&
      work_state !== opts.stateFilter
    )
      continue;

    rows.push({
      id: s._id,
      session_id: s.session_id,
      title: s.title || s.last_user_message || "New Session",
      short_title: s.short_title || null,
      project_path: s.project_path || null,
      updated_at: new Date(s.updated_at).toISOString(),
      ts: s.updated_at,
      message_count: s.message_count || 0,
      agent_type: s.agent_type,
      agent_status: trustedStatusAt(s, now),
      hibernated_at: s.hibernated_at ?? null,
      work_state,
      bucket,
      below_fold: !!s.below_fold,
      // A retired row (still listed while pinned, or under --all). The watch
      // stream reads it to emit a kill as a departure, not a transition.
      is_killed: !!s.inbox_killed_at,
      is_pinned: !!s.is_pinned,
      is_live,
      is_unresponsive: !!s.is_unresponsive,
      awaiting_input: !!s.awaiting_input,
      blocked_on: s.pending_api_error
        ? (s.pending_api_error_kind ?? "error")
        : null,
      session_error: s.session_error || null,
      idle_summary: s.idle_summary || null,
      // The agent's own pinned state beats the generated blurb when both exist:
      // one is what the agent says is true now, the other is a description.
      thread_state: s.thread_state || null,
      thread_state_status: s.thread_state_status || null,
      last_user_message: s.last_user_message || null,
      label: rowLabel,
      active_plan: s.active_plan
        ? { short_id: s.active_plan.short_id, title: s.active_plan.title }
        : null,
      active_task: s.active_task
        ? { short_id: s.active_task.short_id, title: s.active_task.title }
        : null,
      run_by: s.author_name ?? null,
      role: s.role ? { handle: s.role.handle, name: s.role.name } : null,
      owner: s.owner_user_id
        ? { name: s.owner_name ?? null, email: s.owner_email ?? null }
        : null,
      owned_by_me: !!s.owned_by_me,
      activity: isSessionActivityFresh(s.activity, work_state, now)
        ? s.activity
        : null,
    });
  }
  return { counts, rows };
}

async function readCliWatchPage(
  ctx: QueryCtx,
  viewer: Id<"users">,
  page: ReturnType<typeof tallyInboxRows>["rows"],
  sources: ReadonlyMap<string, Doc<"conversations">>,
) {
  const getDoc = makeMemoGet(ctx);
  await Promise.all(
    page.map(async (row) => {
      const source = sources.get(row.id);
      if (!source) return;
      const [plan, task, runner, owner, identity] = await Promise.all([
        source.active_plan_id ? getDoc(source.active_plan_id) : null,
        source.active_task_id ? getDoc(source.active_task_id) : null,
        source.user_id === viewer
          ? resolveActingAuthor(ctx, source, getDoc)
          : getDoc(source.user_id),
        source.owner_user_id ? getDoc(source.owner_user_id) : null,
        identityFieldsOf(source, getDoc),
      ]);
      if (plan)
        row.active_plan = { short_id: plan.short_id, title: plan.title };
      if (task)
        row.active_task = { short_id: task.short_id, title: task.title };
      row.run_by = runner?.name ?? runner?.email ?? null;
      if (identity.role)
        row.role = { name: identity.role.name, handle: identity.role.handle };
      if (source.owner_user_id)
        row.owner = { name: owner?.name ?? null, email: owner?.email ?? null };
    }),
  );
}

// CLI-facing inbox: the same fully-enriched, per-user session set the web inbox
// renders (computeInboxSessions), collapsed to a single `work_state` per row via
// the shared classifier and sorted most-actionable-first. Powers `cast monitor`
// and `cast feed`'s precise `--state` view. api_token authed (CLI has no cookie).
export const inboxForCLI = query({
  args: {
    api_token: v.string(),
    show_all: v.optional(v.boolean()),
    state: v.optional(v.string()),
    limit: v.optional(v.number()),
    watch: v.optional(v.boolean()),
    label: v.optional(v.string()),
    project_path: v.optional(v.string()),
    // Explicit session refs from `cast sessions <id> …` (short id, session UUID,
    // or conversation id). Resolved own-only; the rows are hydrated past the
    // recency window and a subagent row among them is listed instead of hidden.
    session_ids: v.optional(v.array(v.string())),
    // With session_ids alone: list those rows even when killed (computeInboxSessions includeKilled).
    include_killed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };

    const requestedIds = new Set<string>();
    for (const ref of args.session_ids ?? []) {
      const conv = await findConversationByAnyRef(ctx, ref, userId);
      if (conv) requestedIds.add(conv._id.toString());
    }

    const namedWatch =
      requestedIds.size > 0 && !args.label && !args.project_path;
    const scopedWatch =
      args.watch === true && !args.label && !args.project_path;
    const hasRefs = !!args.session_ids?.length;
    const watchedWindow = scopedWatch && !hasRefs;
    const { assignments, activeBuckets, bucketNameById, labelByConv } =
      await readCliFiling(
        ctx.db,
        userId,
        scopedWatch
          ? []
          : namedWatch
            ? ([...requestedIds] as Id<"conversations">[])
            : undefined,
      );

    let labelConvIds: Set<string> | null = null;
    if (args.label) {
      const matched = matchBucketByName(activeBuckets, args.label);
      if ("error" in matched) return { error: matched.error };
      const matchedBucketIds = new Set(
        activeBuckets
          .filter((b) => b.name === matched.name)
          .map((b) => b._id.toString()),
      );
      labelConvIds = new Set(
        assignments
          .filter(
            (a) => a.bucket_id && matchedBucketIds.has(a.bucket_id.toString()),
          )
          .map((a) => a.conversation_id.toString()),
      );
    }

    const extraConvIds = [...(labelConvIds ?? []), ...requestedIds];
    const namedOnly =
      (scopedWatch ? hasRefs : requestedIds.size > 0) && !labelConvIds;
    let { sessions, hidden_count, watchSources, truncated } =
      await computeInboxSessions(ctx, userId, {
        show_all: !!args.show_all,
        extraConvIds: extraConvIds.length ? extraConvIds : undefined,
        projection: true,
        watchedWindow,
        namedOnly,
        includeKilled: !!args.include_killed,
      });

    if (args.project_path) {
      const bound = args.project_path;
      sessions = sessions.filter(
        (s) =>
          projectOverlaps(bound, s.project_path) ||
          projectOverlaps(bound, s.git_root),
      );
    }

    if (labelConvIds) {
      // Counts below reflect the label scope, like show_all narrows the whole view.
      const lci = labelConvIds;
      sessions = sessions.filter((s) => lci.has(s._id.toString()));
    }
    const stateFilter = normalizeWorkStateFilter(args.state);
    const ORDER: Record<WorkState, number> = {
      needs_input: 0,
      done: 1,
      working: 2,
      dormant: 3,
      idle: 4,
    };

    const { counts, rows } = tallyInboxRows(
      watchSources ? sessions.filter((row) => !row.inbox_killed_at) : sessions,
      {
        showAll: args.show_all,
        stateFilter,
        labelByConv,
        requestedIds,
        now: Date.now(),
      },
    );
    if (!args.show_all) counts.below_fold = hidden_count;

    rows.sort((a, b) => {
      const actionable = watchSources ? cliWatchPageOrder(a, b) : 0;
      if (actionable) return actionable;
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      if (ORDER[a.work_state] !== ORDER[b.work_state])
        return ORDER[a.work_state] - ORDER[b.work_state];
      return b.ts - a.ts || a.id.localeCompare(b.id);
    });

    const limit = args.limit ?? 200;
    const page = rows.slice(
      0,
      watchSources ? Math.max(0, Math.min(200, limit)) : limit,
    );
    if (scopedWatch) {
      const { labelByConv: labels } = await readCliFiling(
        ctx.db,
        userId,
        page.map((row) => row.id as Id<"conversations">),
      );
      for (const row of page) row.label = labels.get(row.id) ?? null;
      if (watchSources) await readCliWatchPage(ctx, userId, page, watchSources);
    }

    const nameToConvIds = new Map<string, Set<string>>();
    for (const a of assignments) {
      const name = a.bucket_id ? bucketNameById.get(a.bucket_id) : undefined;
      if (!name) continue;
      if (!nameToConvIds.has(name)) nameToConvIds.set(name, new Set());
      nameToConvIds.get(name)!.add(a.conversation_id.toString());
    }
    let inBound: ((id: string) => Promise<boolean>) | null = null;
    if (args.project_path) {
      const bound = args.project_path;
      const pathById = new Map<
        string,
        { project_path?: string | null; git_root?: string | null } | null
      >();
      for (const s of sessions)
        pathById.set(s._id.toString(), {
          project_path: s.project_path,
          git_root: s.git_root,
        });
      let hydrationBudget = 500;
      inBound = async (id: string) => {
        if (!pathById.has(id)) {
          if (hydrationBudget-- <= 0) return false;
          let conv: any = null;
          try {
            conv = await ctx.db.get(id as Id<"conversations">);
          } catch {
            conv = null;
          }
          pathById.set(
            id,
            conv && conv.user_id.toString() === userId.toString()
              ? { project_path: conv.project_path, git_root: conv.git_root }
              : null,
          );
        }
        const p = pathById.get(id);
        return (
          !!p &&
          (projectOverlaps(bound, p.project_path) ||
            projectOverlaps(bound, p.git_root))
        );
      };
    }
    const labels: Array<{ name: string; count: number }> = [];
    const seenLabelNames = new Set<string>();
    for (const b of namedWatch ? [] : activeBuckets) {
      if (seenLabelNames.has(b.name)) continue;
      seenLabelNames.add(b.name);
      const ids = nameToConvIds.get(b.name) ?? new Set<string>();
      let count = 0;
      for (const id of ids) {
        if (!inBound || (await inBound(id))) count++;
      }
      if (args.project_path && count === 0) continue;
      labels.push({ name: b.name, count });
    }

    return {
      sessions: page,
      counts,
      hidden_count,
      labels,
      scope: "mine",
      ...(watchSources && (page.length < rows.length || truncated.length)
        ? {
            watch_truncation: {
              shown: page.length,
              matching: rows.length,
              windows: truncated,
            },
          }
        : {}),
    };
  },
});
