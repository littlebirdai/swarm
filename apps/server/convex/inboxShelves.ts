import { noteWriteCause } from "./lifecycleEvents";
import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { patchConversationLifecycle } from "./lib/sessionStatusWriter";
import { inboxEpoch } from "@codecast/inbox/inboxProjection";
import { isClosedSession } from "@codecast/inbox/closedSession";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireSessionCommandTarget } from "./daemonCommandUtils";
import {
  shouldShowInInbox,
  isOrphanOrSubagent,
  isAdoptedChild,
  isRunLog,
} from "./inboxFilters";
import { isSessionOwner, sessionOwnerRow } from "./sessionOwners";
import {
  buildSubagentChildRow,
  enrichInboxSessionRow,
} from "./lib/inboxEnrich";
import {
  EMPTY_INBOX_MAPS,
  INBOX_DISMISSED_WINDOW_MS,
  makeMemoGet,
  stampInboxViewerFields,
  stripInboxLiveness,
} from "./lib/inboxMaps";

// The Killed shelf — a user's kills newest-first, paged ON DEMAND from the
// sidebar's Killed bucket ("Load more"). The inbox scan excludes killed rows
// at the index (window-cap efficiency, see scanInboxConversations), and the
// shared working-set selection mirrors that exclusion on every replica, so a
// kill reaches a client only as a stamp on a row it already cached. This is
// the one channel that serves the rows themselves: kills older than the
// client's cache, and kills on a client that never held the row. One-shot
// pagination, never a subscription — it costs nothing until someone reaches
// for history. Rows go through enrichInboxSessionRow like favorites do, so a
// shelf row is byte-identical to an inbox row and can never clobber a cached
// rich row with a thin one. Subagent children are skipped: they render nested
// under their parent, and the parent is what the shelf lists.
export const listKilledSessions = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    const now = Date.now();
    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_killed", (q) =>
        q.eq("user_id", userId).gt("inbox_killed_at", 0),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const getDoc = makeMemoGet(ctx);
    const rows: any[] = [];
    for (const conv of result.page) {
      if (isOrphanOrSubagent(conv) || isRunLog(conv)) continue;
      const { row } = await enrichInboxSessionRow(
        ctx,
        conv,
        EMPTY_INBOX_MAPS,
        now,
        false,
        undefined,
        getDoc,
      );
      await stampInboxViewerFields(
        row,
        conv,
        userId,
        await sessionOwnerRow(ctx, conv._id, userId),
        getDoc,
      );
      stripInboxLiveness(row);
      rows.push(row);
    }
    return {
      page: rows,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// The Closed shelf's other half: the user's closes newest-first, paged with
// listKilledSessions from the Closed bucket's "Load older". A closed row is in
// the inbox scan (it is not killed), but only inside the scan's recency window;
// this serves the older ones. A row whose close was later undone keeps a stale
// inbox_closed_at, which isClosedSession reads as not closed, so it is skipped.
export const listClosedSessions = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    const now = Date.now();
    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_closed", (q) =>
        q.eq("user_id", userId).gt("inbox_closed_at", 0),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const getDoc = makeMemoGet(ctx);
    const rows: any[] = [];
    for (const conv of result.page) {
      if (!isClosedSession(conv) || isOrphanOrSubagent(conv) || isRunLog(conv))
        continue;
      const { row } = await enrichInboxSessionRow(
        ctx,
        conv,
        EMPTY_INBOX_MAPS,
        now,
        false,
        undefined,
        getDoc,
      );
      await stampInboxViewerFields(
        row,
        conv,
        userId,
        await sessionOwnerRow(ctx, conv._id, userId),
        getDoc,
      );
      stripInboxLiveness(row);
      rows.push(row);
    }
    return {
      page: rows,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listDismissedSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const now = Date.now();
    const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = now - WINDOW_MS;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_dismissed", (q) =>
        q.eq("user_id", userId).gte("inbox_dismissed_at", cutoff),
      )
      .order("desc")
      .take(200);

    const results = [];

    for (const conv of conversations) {
      if (!shouldShowInInbox(conv)) continue;

      const isDismissedCompleted = conv.status === "completed";

      let implementationSession: { _id: string; title?: string } | undefined;
      if (isDismissedCompleted) {
        const children = await ctx.db
          .query("conversations")
          .withIndex("by_parent_conversation_id", (q) =>
            q.eq("parent_conversation_id", conv._id),
          )
          .take(5);
        const implChild = children.find(
          (c) => c.parent_message_uuid === "plan-handoff" && !c.is_subagent,
        );
        if (implChild) {
          implementationSession = {
            _id: implChild._id.toString(),
            title: implChild.title,
          };
        }
      }

      results.push({
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title,
        subtitle: conv.subtitle,
        updated_at: conv.updated_at,
        project_path: conv.project_path,
        git_root: conv.git_root,
        git_branch: conv.git_branch,
        agent_type: conv.agent_type,
        message_count: conv.message_count,
        idle_summary: conv.idle_summary,
        is_idle: true,
        has_pending: false,
        implementation_session: implementationSession,
        worktree_name: conv.worktree_name,
        worktree_branch: conv.worktree_branch,
        cloud_seed: conv.cloud_seed ?? null,
        icon: conv.icon,
        icon_color: conv.icon_color,
        dismissed_at: conv.inbox_dismissed_at,
      });
    }

    results.sort(
      (a, b) =>
        (b.dismissed_at || b.updated_at) - (a.dismissed_at || a.updated_at),
    );
    return results;
  },
});

// requireSessionCommandTarget lives in daemonCommandUtils (shared with
// users.resumeSession and the dispatch resume handler); re-exported for callers
// and tests that reach it through this module.
export { requireSessionCommandTarget };

// COMPLETENESS FLOOR: page through EVERY owned, non-dismissed active/completed
// conversation that belongs in the inbox — not just the live channel's 200-row
// recent window. Driven by the client's reconcile crawl (runReconcileCrawl,
// additive/never-prune), this guarantees an idle, owned, non-dismissed session
// is present even when it was never cached on this device AND the live
// subscription was stale (the cross-device + saturation gap). One-shot paginated
// query — bypasses the stalled live subscription. Returns the SAME enriched rows
// as listInboxSessions so the store overlays them without schema drift.
// `since` (optional) restricts to conversations updated at/after a watermark for
// cheap incremental top-ups after the first full backfill.
export const listInboxSessionsPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    return collectInboxSessionsPaginated(ctx, userId, args);
  },
});

// Auth-free body of listInboxSessionsPaginated, exported for tests.
export async function collectInboxSessionsPaginated(
  ctx: any,
  userId: Id<"users">,
  args: { paginationOpts: any; since?: number },
) {
  // Liveness is the overlay's job (sync-convergence C1): the completeness
  // crawl carries bodies only, so the maps are the empty set and every
  // liveness field is stripped below, exactly as getInboxSessionsByIds does.
  // No managed_sessions read on this path.
  const now = inboxEpoch(Date.now());
  const maps = EMPTY_INBOX_MAPS;

  // Owned conversations, most-recent first. Active OR completed (matches the
  // live recent window's status filter). `since` trims to changed rows for
  // incremental crawls. Dismissed are filtered in the LOOP (not the query) via
  // the canonical `!conv.inbox_dismissed_at` truthiness check — a query-level
  // `eq(field, undefined)` would wrongly drop sessions whose dismissal was
  // cleared to null/0 rather than removed. Dismissed are excluded because they
  // accumulate locally via their own keepWhere path; re-surfacing them here
  // would fight that design. Cluster-cutoff is disabled (clusterCutoff=0):
  // completeness is the whole point of the floor.
  // The lower bound is the caller's watermark ONLY — it must be STABLE across
  // every page of one crawl, or each page's continuation cursor belongs to a
  // different query and Convex throws InvalidCursor. The 30d activity window is
  // therefore applied client-side (the client seeds `since = now - 30d` on the
  // first backfill); never fold a wall-clock value into the index range here.
  const q = ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (qb: any) =>
      args.since !== undefined
        ? qb.eq("user_id", userId).gte("updated_at", args.since)
        : qb.eq("user_id", userId),
    )
    .order("desc")
    .filter((qb: any) =>
      qb.or(
        qb.eq(qb.field("status"), "active"),
        qb.eq(qb.field("status"), "completed"),
      ),
    );

  const result = await q.paginate(args.paginationOpts);

  const getDoc = makeMemoGet(ctx);
  const rows: any[] = [];
  for (const conv of result.page) {
    if (conv.inbox_dismissed_at || conv.inbox_stashed_at) continue; // dismissed/stashed: own accumulation path
    if (!shouldShowInInbox(conv)) continue;
    const { row, subagentChildren } = await enrichInboxSessionRow(
      ctx,
      conv,
      maps,
      now,
      false,
      { auq: true },
      getDoc,
    );
    await stampInboxViewerFields(
      row,
      conv,
      userId,
      await sessionOwnerRow(ctx, conv._id, userId),
      getDoc,
    );
    stripInboxLiveness(row);
    rows.push(row);
    for (const child of subagentChildren) {
      // An adopted child is a top-level row of its own (shared isAdoptedChild),
      // listed by the scan itself, as listInboxSessions does.
      if (isAdoptedChild(child)) continue;
      const childRow = await buildSubagentChildRow(
        child,
        maps,
        now,
        conv._id,
        (id) => ctx.db.get(id),
      );
      await stampInboxViewerFields(
        childRow,
        child,
        userId,
        await sessionOwnerRow(ctx, child._id, userId),
        getDoc,
      );
      stripInboxLiveness(childRow);
      rows.push(childRow);
    }
  }

  return {
    page: rows,
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}

// Durable cross-device dismiss reconcile. Returns ONLY {_id, inbox_dismissed_at}
// for the caller's conversations dismissed within the live window — NO per-session
// enrichment, so it's cheap to page even on a saturation-prone backend. This is the
// backstop the live `listInboxSessions` subscription lacks: that channel only
// reaches a CONNECTED client, and the session crawl (`listInboxSessionsPaginated`)
// can't carry a dismiss at all — it's keyed on `updated_at` (a dismiss never moves
// it) and skips dismissed rows outright. This query is keyed on the
// `by_user_dismissed` index (inbox_dismissed_at — the field a dismiss DOES move),
// so a device that was offline at dismiss time heals on its next reconcile.
// The client overlays the result via applyDismissedReconcile (SET on reported,
// CLEAR on no-longer-reported = un-dismissed elsewhere). Window mirrors the live
// query's INBOX_DISMISSED_WINDOW_MS — keep them in sync.
// Shared handler for the dismissed/stashed lite crawls. The window lower bound
// MUST be a STABLE value supplied by the caller — it becomes the index range
// bound, and a wall-clock value recomputed per page (Date.now() in the handler)
// shifts the range between pages, so each continuation cursor belongs to a
// different query and Convex throws InvalidCursor on page 2. That capped this
// crawl at its FIRST page (~500 rows) — a heavy account's older dismisses then
// never reconciled, so dismissed sessions resurfaced on other tabs/devices. The
// client seeds `since = now - 30d` once per crawl (mirrors
// listInboxSessionsPaginated). Never fold Date.now() into the range here. The
// fallback is only for a single un-paginated probe call.
async function listHiddenSessionsLite(
  ctx: any,
  args: { paginationOpts: any; since?: number },
  index: "by_user_dismissed" | "by_user_stashed",
  field: "inbox_dismissed_at" | "inbox_stashed_at",
) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return { page: [], isDone: true, continueCursor: "" };
  return collectHiddenSessionsLite(ctx, userId, args, index, field);
}

// Auth-free body, exported for tests (perform* convention).
export async function collectHiddenSessionsLite(
  ctx: any,
  userId: any,
  args: { paginationOpts: any; since?: number },
  index: "by_user_dismissed" | "by_user_stashed",
  field: "inbox_dismissed_at" | "inbox_stashed_at",
) {
  const cutoff = args.since ?? Date.now() - INBOX_DISMISSED_WINDOW_MS;
  const result = await ctx.db
    .query("conversations")
    .withIndex(index, (q: any) => q.eq("user_id", userId).gte(field, cutoff))
    .order("desc")
    .paginate(args.paginationOpts);
  const page = result.page.map((c: any) => ({
    _id: c._id,
    [field]: c[field] ?? null,
  }));
  // Sessions ASSIGNED to this user (session_owners) but run by another account
  // live outside the by_user index above, yet the client's reconcile CLEAR pass
  // arbitrates them like any cached row — if their hide is missing from this
  // set, every complete crawl un-hides them ("dismiss doesn't stick"). Append
  // the owner-set's hidden rows on the final page: outside the paginated index
  // scan, so cursors stay untouched, and present in the whole-set the CLEAR
  // gate checks. Bounded by the same 200-owner cap as the inbox scan.
  if (result.isDone) {
    const ownerRows = await ctx.db
      .query("session_owners")
      .withIndex("by_user", (q: any) => q.eq("user_id", userId))
      .take(200);
    const seen = new Set(page.map((r: any) => r._id.toString()));
    for (const r of ownerRows) {
      const idStr = r.conversation_id.toString();
      if (seen.has(idStr)) continue;
      let conv: any = null;
      try {
        conv = await ctx.db.get(r.conversation_id);
      } catch {
        conv = null;
      }
      if (!conv || conv.user_id.toString() === userId.toString()) continue;
      const at = conv[field];
      if (!at || at < cutoff) continue;
      page.push({ _id: conv._id, [field]: at });
    }
  }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

export const listDismissedSessionsLite = query({
  args: {
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    listHiddenSessionsLite(
      ctx,
      args,
      "by_user_dismissed",
      "inbox_dismissed_at",
    ),
});

// Stashed twin of the dismissed reconcile — same contract, keyed on
// inbox_stashed_at via by_user_stashed.
export const listStashedSessionsLite = query({
  args: {
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    listHiddenSessionsLite(ctx, args, "by_user_stashed", "inbox_stashed_at"),
});

// Which of these conversation ids still exist as the caller's own? Powers the
// inbox ghost sweep: the client's never-prune sessions cache verifies before
// dropping blank rows the empty-conversation GC (cleanup.gcEmptyConversations)
// may have hard-deleted server-side. Verify-then-prune keeps the sweep safe —
// a blank row the GC skipped (live terminal, parked draft) reports back as
// existing and stays cached.
export const existingConversationIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const out: string[] = [];
    for (const raw of args.ids.slice(0, 200)) {
      const id = ctx.db.normalizeId("conversations", raw);
      if (!id) continue;
      const conv = await ctx.db.get(id);
      if (!conv) continue;
      // Vouch for rows the caller runs OR owns (assigned sessions) — reading a
      // live assigned session as "gone" would ghost-prune it with a sticky
      // exclude, permanently blinding this client to it.
      if (
        conv.user_id.toString() === userId.toString() ||
        (await isSessionOwner(ctx, id, userId))
      )
        out.push(raw);
    }
    return out;
  },
});

// Change-feed batch fetch: current inbox-row state for a set of conversation ids
// the user OWNS (the inbox is owner-only). Returns rows in the EXACT shape of the
// listInboxSessions base payload (include_liveness:false — liveness stripped so
// the sessionsLiveness overlay keeps owning it), so the client merges them through
// the same syncTable("sessions") path. Reuses enrichInboxSessionRow — no
// presentation filter, so a dismissed/stashed session comes back WITH its flag
// (the client re-buckets it). Ids that are gone or foreign are simply omitted;
// callers prune ids the response omits (authorized absence). Consumers: the
// sync-log applier (syncLog.ts / web useSyncChangeFeed.ts) and, for deployed
// old bundles, changeFeed.ts.
export const getInboxSessionsByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { sessions: [] };
    return collectInboxSessionsByIds(ctx, userId, args.ids);
  },
});

// Auth-free body of getInboxSessionsByIds, exported for tests.
export async function collectInboxSessionsByIds(
  ctx: any,
  userId: Id<"users">,
  ids: string[],
) {
  const now = inboxEpoch(Date.now());
  const getDoc = makeMemoGet(ctx);
  const sessions: any[] = [];
  for (const raw of ids.slice(0, 300)) {
    const id = ctx.db.normalizeId("conversations", raw);
    if (!id) continue;
    const conv = await ctx.db.get(id);
    if (!conv) continue;
    // The runner, or an owner (session_owners) — the same admission the scan's
    // owned window applies, so a replica can heal an assigned row it missed.
    // The owner seat is stamped so the client's foreign-row rule keeps it.
    // One owner-row read gives admission, owned_by_me and assigned_ping.
    const myOwnerRow = await sessionOwnerRow(ctx, conv._id, userId);
    if (conv.user_id.toString() !== userId.toString() && !myOwnerRow) continue;
    if (conv.status !== "active" && conv.status !== "completed") continue;
    const { row } = await enrichInboxSessionRow(
      ctx,
      conv,
      EMPTY_INBOX_MAPS,
      now,
      false,
      { auq: true },
      getDoc,
    );
    await stampInboxViewerFields(row, conv, userId, myOwnerRow, getDoc);
    stripInboxLiveness(row);
    sessions.push(row);
  }
  return { sessions };
}

export const dismissFromInbox = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "web:dismissFromInbox");
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    await patchConversationLifecycle(ctx, args.conversation_id, {
      inbox_dismissed_at: Date.now(),
    });
  },
});

// Bulk-dismiss the caller's sessions whose last activity (updated_at) is older
// than `older_than_days` (default 30). Clears the accumulated working set without
// deleting anything — dismissed rows stay searchable and accessible. FIRE-ONCE:
// the heavy work is handed to a self-draining background job, NOT looped from the
// client. A client-side loop of dozens of write-mutations is fragile on a
// saturation-prone deployment (one flaky call surfaced a scary error toast); a
// single scheduled drainer can't fail the user's click and drains durably on the
// server's own clock. The client has already dismissed locally (optimistic), so
// this only needs to make it stick server-side / cross-device.
export const dismissStaleInboxSessions = mutation({
  args: {
    older_than_days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const cutoff =
      Date.now() - (args.older_than_days ?? 30) * 24 * 60 * 60 * 1000;
    await ctx.scheduler.runAfter(0, internal.inboxShelves.drainStaleDismiss, {
      userId,
      cutoff,
      cursor: null,
      attempt: 0,
    });
    return { scheduled: true };
  },
});

// Self-draining background dismiss. Dismisses one bounded page of the caller's
// >cutoff-old sessions (skipping pinned + already-dismissed) and reschedules
// itself with the next cursor until the whole backlog is cleared. Range-scans
// only the OLD region (by_user_updated, lt cutoff). EVERYTHING stale but pinned
// is dismissed — including subagents/orphans, because a dismissed parent promotes
// its old subagent children to the top level and they'd refill the inbox. A
// thrown page (transient backend hiccup) rolls back untouched and retries the
// SAME cursor with backoff up to a cap; work is idempotent (dismissed rows are
// skipped), so retries never double-count and a give-up only loses cross-device
// completeness, never the local clear the user already saw.
export const drainStaleDismiss = internalMutation({
  args: {
    userId: v.id("users"),
    cutoff: v.number(),
    cursor: v.union(v.string(), v.null()),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "cron:drainStaleDismiss");
    const now = Date.now();
    try {
      const result = await ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) =>
          q.eq("user_id", args.userId).lt("updated_at", args.cutoff),
        )
        .paginate({ cursor: args.cursor, numItems: 100 });

      for (const conv of result.page) {
        if (conv.inbox_dismissed_at) continue;
        if (conv.inbox_pinned_at || conv.inbox_snoozed_until) continue;
        await patchConversationLifecycle(ctx, conv._id, {
          inbox_dismissed_at: now,
        });
      }

      if (!result.isDone) {
        await ctx.scheduler.runAfter(
          150,
          internal.inboxShelves.drainStaleDismiss,
          {
            userId: args.userId,
            cutoff: args.cutoff,
            cursor: result.continueCursor,
            attempt: 0,
          },
        );
      }
    } catch {
      const attempt = args.attempt + 1;
      if (attempt <= 6) {
        await ctx.scheduler.runAfter(
          2000 * attempt,
          internal.inboxShelves.drainStaleDismiss,
          {
            userId: args.userId,
            cutoff: args.cutoff,
            cursor: args.cursor,
            attempt,
          },
        );
      }
    }
  },
});
