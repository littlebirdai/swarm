import {
  canProbeCliWatchTranscript,
  orderCliWatchCandidates,
  readInboxChildren,
} from "./cli-inbox-reads.rules";
import {
  indexedInboxSessionRows,
  readCliWatchLiveness,
} from "./sessionHeartbeat";
import {
  computeFold,
  selectWorkingSet,
  HISTORY_IMPORT_INBOX_MS,
  INBOX_WINDOW_CAPS,
  isAssignedAwayFromViewer,
  type InboxTruncation,
} from "@codecast/inbox/inboxProjection";
import { Id } from "../_generated/dataModel";
import { INBOX_PINNED_CAP } from "../inboxProjection";
import { shouldShowInInbox, isAdoptedChild } from "../inboxFilters";
import { sessionOwnerRow } from "../sessionOwners";
import { viewerHiddenConversationIds } from "../inboxHides";
import { createTeamFeedFilter } from "../privacy";
import {
  EMPTY_INBOX_MAPS,
  INBOX_DISMISSED_WINDOW_MS,
  INBOX_OWNER_LOOKUP_CAP,
  INBOX_PINNED_CHILDREN_SCAN,
  INBOX_SESSION_WINDOW_MS,
  INBOX_WINDOW_CAP,
  type InboxSessionMaps,
  TEAM_INBOX_MEMBER_CAP,
  TEAM_INBOX_PER_MEMBER_CAP,
  belowFoldFor,
  buildNamedSessionMaps,
  buildUserSessionMaps,
  mergeForeignConversationLiveness,
  sessionMapsFromManagedRows,
} from "./inboxMaps";

// The live, windowed inbox computation. Extracted from the query handler so a
// test harness can drive it with an explicit userId (the query is auth-gated and
// can't be invoked via `npx convex run`).
// Shared inbox-conversation scan: the recent/pinned/dismissed/stashed/owned windows,
// explicit-extra hydration, per-user liveness maps, foreign-run liveness merge, and the
// stale-cluster cutoff. Extracted so the full inbox enrichment (computeInboxSessions)
// and the lightweight liveness overlay (computeSessionsLiveness) scan the SAME candidate
// set the same way — they only differ in what they enrich per row.
export async function scanInboxConversations(
  ctx: any,
  userId: Id<"users">,
  now: number,
  opts: {
    includeLiveness: boolean;
    extraConvIds?: string[];
    teamScope?: Id<"teams">;
    // Also read the user's recently updated SUBAGENT rows (one indexed range,
    // never merged into the candidate set). This is the fast-field ownership
    // window: the list strips message_count/updated_at from exactly the child
    // rows in it, and the liveness overlay stamps exactly those children, so
    // the two channels read one window and can never disagree about which
    // child rows carry the fields. Off for team scope, whose list never
    // strips them.
    subagentWindow?: boolean;
    indexedLiveness?: boolean;
    watchedWindow?: { showAll?: boolean };
    // The caller named its sessions (extraConvIds) and wants only those: skip
    // every window and the owner window, admit the named rows by the same
    // rule, and read their liveness per conversation (buildNamedSessionMaps).
    // Each named row classifies exactly as the full scan would; it never
    // folds, the way a deliberately named row never does.
    namedOnly?: boolean;
  },
): Promise<{
  conversations: any[];
  maps: InboxSessionMaps;
  loadIndexedLiveness?: (ids: Id<"conversations">[]) => Promise<void>;
  // The subagent window (see opts.subagentWindow): newest INBOX_WINDOW_CAP
  // subagent rows inside the recency window. Empty when not requested.
  recentSubagents: any[];
  // Rows that reached the candidate set by a deliberate act rather than by
  // recency: a label's filed extras, and sessions ASSIGNED to this user but run
  // by another account. Both are exempt from the cluster cutoff (they are old
  // by design — a parked label, a decision handed over days ago) and excluded
  // from the gap analysis so their age can't bridge a gap that should hide the
  // caller's own cruft.
  deliberateIds: Set<string>;
  clusterCutoff: number;
  // The shared selection's members and its fold set (computeFold, riders
  // included): a member's fold flag is read from here, never from the cut.
  selectionIds: ReadonlySet<string>;
  belowFold: ReadonlySet<string>;
  // Conversations in this user's owner set — drives the owned_by_me flag during
  // enrichment without a per-row session_owners lookup.
  ownedByMeIds: Set<string>;
  // My owner ROWS by conversation id — enrichment stamps assigned_ping off the
  // unacknowledged handoffs (added by someone else, seen_at unset).
  myOwnerRowById: Map<string, any>;
  // My owner row for one conversation, exact whatever the owner window held
  // (see the scan): what every stamp of owned_by_me and assigned_ping reads.
  ownerRowFor: (conv: any) => Promise<any | null>;
  // Every cap that fired, by name. Never silent (sync-convergence C2).
  truncated: Set<InboxTruncation>;
  // Pinned rows past the newest INBOX_PINNED_CHILDREN_SCAN, in pin order.
  pinnedOverflowIds: Set<string>;
  // Named path only: teammates of the named rows the windows would have
  // pooled, for groupPoolChildren. Never rows of their own.
  poolChildren: any[];
  scopedChildren?: Map<string, any[]>;
  watched?: any[];
}> {
  const dismissedCutoff = now - INBOX_DISMISSED_WINDOW_MS;
  const sessionWindowCutoff = now - INBOX_SESSION_WINDOW_MS;
  const truncated = new Set<InboxTruncation>();

  // Recent window is bounded by both the row cap AND the 30d activity window:
  // the index range stops the scan at the cutoff so old sessions are never read.
  // Pinned, dismissed, stashed and snoozed rows have their own queries below
  // and are excluded here AT THE INDEX (the four stamps pinned to absent): a
  // filed row is not recent material (shared inWorkingSet), and a stashed
  // agent keeps heartbeating, so on a busy account those fresh stamps filled
  // the 200 recent seats and cut every settled plain row older than two days
  // out of the set — dropped, not folded, so the show-old toggle had nothing
  // to show (2026-09-23).
  //
  // Subagent rows are excluded AT THE INDEX for every window. shouldShowInInbox
  // drops them anyway, but a busy account has more subagents than sessions in
  // its windows (320 of 621 candidates on one census — dismiss/stash cascade
  // to children, so the hide windows were mostly subagents), so reading them
  // cost more than the rows that survive, and they crowded real sessions out of
  // the 200-row caps. is_subagent is written as both `false` and absent, so a
  // top-level window is the union of two index ranges, merged newest-first.
  // Each range reads cap + 1 so a full window is distinguishable from an
  // overflowing one at the cost of one row.
  // The named path reads no window at all. A query starts the moment it is
  // built, not when it is awaited, so a window must not even be constructed:
  // its read set alone would re-run the caller on every write it covers.
  const noWindows = !!opts.namedOnly;
  const capWindow = (kind: InboxTruncation, cap: number) => (rows: any[]) => {
    if (rows.length > cap) truncated.add(kind);
    return rows.slice(0, cap);
  };
  const topLevelWindow = (
    rangeFor: (isSubagent: false | undefined) => Promise<any[]>,
    sortKey: string,
    kind: InboxTruncation,
  ) =>
    noWindows
      ? Promise.resolve([] as any[])
      : Promise.all([rangeFor(undefined), rangeFor(false)]).then(
          ([a, b]: [any[], any[]]) => {
            const merged = [...a, ...b].sort((x, y) => y[sortKey] - x[sortKey]);
            if (merged.length > INBOX_WINDOW_CAP) truncated.add(kind);
            return merged.slice(0, INBOX_WINDOW_CAP);
          },
        );

  const plainRange = (q: any, isSubagent: boolean | undefined) =>
    q
      .eq("user_id", userId)
      .eq("is_subagent", isSubagent)
      .eq("inbox_pinned_at", undefined)
      .eq("inbox_dismissed_at", undefined)
      .eq("inbox_stashed_at", undefined)
      .eq("inbox_snoozed_until", undefined)
      .gte("updated_at", sessionWindowCutoff);
  const recentConversationsQ = topLevelWindow(
    (isSubagent) =>
      ctx.db
        .query("conversations")
        .withIndex("by_user_plain_updated", (q: any) =>
          plainRange(q, isSubagent),
        )
        .order("desc")
        .filter((q: any) =>
          q.and(
            q.or(
              q.eq(q.field("status"), "active"),
              q.eq(q.field("status"), "completed"),
            ),
            // isStaleHistoryImport, as the replica's inWorkingSet reads it.
            q.or(
              q.neq(q.field("history_import"), true),
              q.gte(q.field("updated_at"), now - HISTORY_IMPORT_INBOX_MS),
            ),
          ),
        )
        .take(INBOX_WINDOW_CAP + 1),
    "updated_at",
    "recent",
  );

  // Newest pins first, so overflow drops the oldest pin, never a fresh one.
  const pinnedConversationsQ = noWindows
    ? Promise.resolve([] as any[])
    : ctx.db
        .query("conversations")
        .withIndex("by_user_pinned", (q: any) =>
          q.eq("user_id", userId).gt("inbox_pinned_at", 0),
        )
        .order("desc")
        .take(INBOX_PINNED_CAP + 1)
        .then(capWindow("pinned", INBOX_PINNED_CAP));

  // Nested rows the person adopted (talked to): the one window that admits a
  // nested row as a member (shared isAdoptedChild), newest adoption first,
  // inside the same 30-day horizon as the hide windows.
  const adoptedConversationsQ = noWindows
    ? Promise.resolve([] as any[])
    : ctx.db
        .query("conversations")
        .withIndex("by_user_adopted", (q: any) =>
          q.eq("user_id", userId).gte("inbox_adopted_at", dismissedCutoff),
        )
        .order("desc")
        .take(INBOX_WINDOW_CAPS.adopted + 1)
        .then(capWindow("adopted", INBOX_WINDOW_CAPS.adopted));

  // Killed rows are excluded at the index for the same reason: a kill stamps
  // inbox_dismissed_at alongside inbox_killed_at (applyHideTransition), so the
  // dismissed window was mostly retired rows the filter throws away. A pinned
  // killed row still shows, and the pinned window below covers it.
  const dismissedConversationsQ = topLevelWindow(
    (isSubagent) =>
      ctx.db
        .query("conversations")
        .withIndex("by_user_live_dismissed", (q: any) =>
          q
            .eq("user_id", userId)
            .eq("is_subagent", isSubagent)
            .eq("inbox_killed_at", undefined)
            .gte("inbox_dismissed_at", dismissedCutoff),
        )
        .order("desc")
        .take(INBOX_WINDOW_CAP + 1),
    "inbox_dismissed_at",
    "dismissed",
  );

  // Stashed (set aside, agent still alive) mirror the dismissed window so the
  // Stashed bucket is populated even for rows older than the recent window.
  const stashedConversationsQ = topLevelWindow(
    (isSubagent) =>
      ctx.db
        .query("conversations")
        .withIndex("by_user_live_stashed", (q: any) =>
          q
            .eq("user_id", userId)
            .eq("is_subagent", isSubagent)
            .eq("inbox_killed_at", undefined)
            .gte("inbox_stashed_at", dismissedCutoff),
        )
        .order("desc")
        .take(INBOX_WINDOW_CAP + 1),
    "inbox_stashed_at",
    "stashed",
  );

  const snoozedConversationsQ = topLevelWindow(
    (isSubagent) =>
      ctx.db
        .query("conversations")
        .withIndex("by_user_live_snoozed", (q: any) =>
          q
            .eq("user_id", userId)
            .eq("is_subagent", isSubagent)
            .eq("inbox_killed_at", undefined)
            .gt("inbox_snoozed_until", 0),
        )
        .order("desc")
        .take(INBOX_WINDOW_CAP + 1),
    "inbox_snoozed_until",
    "snoozed",
  );

  // Sessions this user OWNS — run by another member's account (e.g. Mr Bot) but
  // assigned to them — surface in the OWNER's inbox alongside their own.
  // Explicit assignment outranks default team visibility: routing a session into
  // someone's inbox is a deliberate act by someone who already had access.
  //
  // Reads the canonical owner SET (session_owners), NOT the denormalized
  // owner_user_id cache: a session may have several owners and the cache only
  // holds the primary, so a secondary owner's inbox would otherwise miss it.
  // Owner rows are keyed by user alone (no denormalized updated_at — that would
  // make every conversation heartbeat fan out and patch all of its owner rows),
  // so hydrate here and apply the same recency/status window as the main scan.
  let ownerLookupRows: any[] = [];
  let ownerLookupComplete = false;
  const ownerLookupCap = opts.watchedWindow
    ? INBOX_WINDOW_CAP
    : INBOX_OWNER_LOOKUP_CAP;
  const ownerRowsQ = noWindows
    ? Promise.resolve([] as any[])
    : ctx.db
        .query("session_owners")
        .withIndex("by_user", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(ownerLookupCap + 1)
        .then((rows: any[]) => {
          ownerLookupComplete = rows.length <= ownerLookupCap;
          ownerLookupRows = rows.slice(0, ownerLookupCap);
          if (rows.length > INBOX_WINDOW_CAP) truncated.add("owned");
          return rows.slice(0, INBOX_WINDOW_CAP);
        });
  const recentSubagentsQ: Promise<any[]> =
    opts.subagentWindow && !opts.teamScope && !noWindows
      ? ctx.db
          .query("conversations")
          .withIndex("by_user_plain_updated", (q: any) => plainRange(q, true))
          .order("desc")
          .filter((q: any) =>
            q.or(
              q.eq(q.field("status"), "active"),
              q.eq(q.field("status"), "completed"),
            ),
          )
          .take(INBOX_WINDOW_CAP + Number(opts.includeLiveness))
          .then(capWindow("subagents", INBOX_WINDOW_CAP))
      : Promise.resolve([]);
  const [
    recentConversations,
    pinnedConversations,
    dismissedConversations,
    stashedConversations,
    snoozedConversations,
    ownerRows,
    recentSubagents,
    adoptedConversations,
  ] = await Promise.all([
    recentConversationsQ,
    pinnedConversationsQ,
    dismissedConversationsQ,
    stashedConversationsQ,
    snoozedConversationsQ,
    ownerRowsQ,
    recentSubagentsQ,
    adoptedConversationsQ,
  ]);
  const ownedByMeIds = new Set<string>(
    ownerRows.map((r: any) => r.conversation_id.toString()),
  );
  const myOwnerRowById = new Map<string, any>(
    ownerRows.map((r: any) => [r.conversation_id.toString(), r]),
  );
  const ownerLookupById = new Map<string, any>(
    ownerLookupRows.map((r: any) => [r.conversation_id.toString(), r]),
  );
  const ownerLookups = new Map<string, Promise<any | null>>();
  const ownerRowFor = (conv: any): Promise<any | null> => {
    const idStr = conv._id.toString();
    const held = myOwnerRowById.get(idStr);
    if (held) return Promise.resolve(held);
    if (opts.watchedWindow && conv.owner_user_id === userId) {
      ownedByMeIds.add(idStr);
      return Promise.resolve(null);
    }
    const looked = ownerLookupById.get(idStr);
    if (looked) {
      ownedByMeIds.add(idStr);
      myOwnerRowById.set(idStr, looked);
      return Promise.resolve(looked);
    }
    // An empty owner range proves nothing when it was never read.
    if (ownerLookupComplete && !opts.namedOnly) return Promise.resolve(null);
    // A conversation with no owner_user_id has no owner rows at all: the
    // cache names the primary owner whenever one exists (every owner-row
    // writer resyncs it through syncPrimaryOwnerCache). Only a row with an
    // owner can have me among its owners, so only that row pays the read; on
    // a full account the per-row read for every candidate and child put
    // listInboxSessions past Convex's limits (ct-73243).
    if (!conv.owner_user_id) return Promise.resolve(null);
    let hit = ownerLookups.get(idStr);
    if (!hit) {
      hit = sessionOwnerRow(ctx, conv._id, userId).then((row: any) => {
        if (row) {
          ownedByMeIds.add(idStr);
          myOwnerRowById.set(idStr, row);
        }
        return row ?? null;
      });
      ownerLookups.set(idStr, hit);
    }
    return hit;
  };

  const byId = new Map<string, any>();
  for (const c of recentConversations) byId.set(c._id.toString(), c);
  for (const c of pinnedConversations) byId.set(c._id.toString(), c);
  const pinnedOverflowIds = new Set<string>(
    pinnedConversations
      .slice(INBOX_PINNED_CHILDREN_SCAN)
      .map((c: any) => c._id.toString()),
  );
  for (const c of dismissedConversations) byId.set(c._id.toString(), c);
  for (const c of stashedConversations) byId.set(c._id.toString(), c);
  for (const c of snoozedConversations) byId.set(c._id.toString(), c);
  for (const c of adoptedConversations) byId.set(c._id.toString(), c);

  // Hydrate only the owned conversations the window scans above didn't already
  // fetch (an owned session of my OWN is usually in the recent window — the get
  // would be a wasted read on a query that re-runs every heartbeat).
  const ownerRowsToHydrate = ownerRows.filter(
    (r: any) => !byId.has(r.conversation_id.toString()),
  );
  const ownerHydrated = await Promise.all(
    ownerRowsToHydrate.map((r: any) =>
      Promise.resolve(ctx.db.get(r.conversation_id)).catch(() => null),
    ),
  );
  // An owned row is admitted on the owner seat ALONE — no recency window, no
  // status gate. Assignment means the session sits in that person's inbox
  // until they act on it, whatever state it is in: a handoff they have not
  // opened for six weeks is exactly the one that must not quietly age out.
  // The cost is bounded by the owner cap the query above already applies.
  for (const conv of ownerHydrated) {
    if (!conv) continue;
    byId.set(conv._id.toString(), conv);
  }

  // TEAM SCOPE (inbox "team mode"): fold every teammate's team-visible session
  // into the candidate set, on top of the caller's own sessions above — so the
  // team board is a SUPERSET of the personal inbox. Visibility uses the exact
  // same rule as the team feed and search (createTeamFeedFilter), so the two can
  // never disagree about what's shared. Only the recent window is scanned per
  // member (active/completed, not their personally dismissed/stashed rows — that
  // is the teammate's own triage, not this board's). The caller's own rows are
  // skipped here; they were already gathered by the by_user scans above (which
  // also cover the caller's PRIVATE sessions, correctly visible to themselves).
  if (opts.teamScope) {
    const teamFilter = await createTeamFeedFilter(ctx, opts.teamScope);
    // The caller's own triage of teammates' rows (inbox_hides): a stash or
    // dismiss on a row they neither run nor own cannot live on the row, so it
    // lives here, and the board skips it the same way it skips the owner's.
    const viewerHidden = await viewerHiddenConversationIds(ctx, userId);
    const otherMemberIds = teamFilter.memberships
      .map((m) => m.user_id)
      .filter((id) => id.toString() !== userId.toString());
    if (otherMemberIds.length > TEAM_INBOX_MEMBER_CAP) truncated.add("members");
    const memberIds = otherMemberIds.slice(0, TEAM_INBOX_MEMBER_CAP);
    // A teammate's rows come through the same plain index as the caller's
    // recent window, keyed by the runner and filtered to this team: the
    // team index ranks by activity alone, and a teammate's stashed agents
    // keep heartbeating, so on a busy member those fresh stamps took every
    // per-member seat and the board dropped their settled sessions. The
    // filed windows a teammate's triage decides (dismissed, stashed,
    // snoozed) stay off the board; a teammate's pin is a session like any
    // other, so the pinned rows in this team are read on their own.
    const inTeamAndLive = (q: any) =>
      q.and(
        q.eq(q.field("team_id"), opts.teamScope),
        q.or(
          q.eq(q.field("status"), "active"),
          q.eq(q.field("status"), "completed"),
        ),
      );
    const memberScans = await Promise.all(
      memberIds.map((memberId) =>
        Promise.all([
          ...([undefined, false] as const).map((isSubagent) =>
            ctx.db
              .query("conversations")
              .withIndex("by_user_plain_updated", (q: any) =>
                q
                  .eq("user_id", memberId)
                  .eq("is_subagent", isSubagent)
                  .eq("inbox_pinned_at", undefined)
                  .eq("inbox_dismissed_at", undefined)
                  .eq("inbox_stashed_at", undefined)
                  .eq("inbox_snoozed_until", undefined)
                  .gte("updated_at", sessionWindowCutoff),
              )
              .order("desc")
              .filter(inTeamAndLive)
              .take(TEAM_INBOX_PER_MEMBER_CAP + 1),
          ),
          ctx.db
            .query("conversations")
            .withIndex("by_user_pinned", (q: any) =>
              q.eq("user_id", memberId).gt("inbox_pinned_at", 0),
            )
            .order("desc")
            .filter((q: any) =>
              q.and(
                inTeamAndLive(q),
                q.gte(q.field("updated_at"), sessionWindowCutoff),
              ),
            )
            .take(TEAM_INBOX_PER_MEMBER_CAP + 1),
        ]).then((ranges: any[][]) => {
          const merged = ranges
            .flat()
            .sort((x, y) => y.updated_at - x.updated_at);
          if (merged.length > TEAM_INBOX_PER_MEMBER_CAP)
            truncated.add("member_rows");
          return merged.slice(0, TEAM_INBOX_PER_MEMBER_CAP);
        }),
      ),
    );
    for (const memberRecent of memberScans) {
      for (const c of memberRecent) {
        if (byId.has(c._id.toString())) continue;
        if (c.is_subagent || !shouldShowInInbox(c)) continue; // a pinned killed row, a child
        if (viewerHidden.has(c._id.toString())) continue; // the caller's triage of it
        if (!teamFilter.isVisible(c)) continue;
        // Shared as a summary: the row lists, its prompt text and images do not.
        byId.set(
          c._id.toString(),
          teamFilter.contentVisible(c) ? c : { ...c, team_summary_only: true },
        );
      }
    }
  }

  // Hydrate explicitly-requested conversations the windows above missed.
  // Own or owned-by-me sessions only (the inbox is "mine"); cap mirrors the
  // window size.
  const extraIds = new Set(opts.extraConvIds ?? []);
  let extraBudget = 200;
  for (const idStr of extraIds) {
    if (byId.has(idStr) || extraBudget <= 0) continue;
    let conv: any = null;
    try {
      conv = await ctx.db.get(idStr as Id<"conversations">);
    } catch {
      conv = null;
    }
    if (!conv) continue;
    // Not the runner: admit only if they're an owner (ownerRowFor records it).
    if (
      conv.user_id.toString() !== userId.toString() &&
      !(await ownerRowFor(conv))
    )
      continue;
    if (conv.status !== "active" && conv.status !== "completed") continue;
    byId.set(idStr, conv);
    extraBudget--;
  }
  if (truncated.has("owned")) {
    let rows = [...byId.values(), ...recentSubagents];
    if (opts.watchedWindow) {
      const candidates = rows.filter((row) => {
        const id = String(row._id);
        if (row.owner_user_id === userId || ownerLookupById.has(id))
          ownedByMeIds.add(id);
        return (
          row.user_id === userId && row.owner_user_id && !ownedByMeIds.has(id)
        );
      });
      rows = orderCliWatchCandidates(candidates).slice(0, 64);
    }
    await Promise.all(rows.map(ownerRowFor));
  }

  const uidForAssign = userId.toString();
  for (const [idStr, conv] of [...byId.entries()]) {
    if (conv.user_id?.toString() !== uidForAssign) continue;
    if (extraIds.has(idStr)) continue;
    if (
      isAssignedAwayFromViewer(
        {
          owner_user_id: conv.owner_user_id,
          owned_by_me: ownedByMeIds.has(idStr),
        },
        uidForAssign,
      )
    ) {
      byId.delete(idStr);
    }
  }

  const conversations = Array.from(byId.values());

  const deliberateIds = new Set<string>(extraIds);
  for (const c of conversations) {
    const idStr = c._id.toString();
    if (ownedByMeIds.has(idStr) && c.user_id.toString() !== userId.toString()) {
      deliberateIds.add(idStr);
    }
  }

  const uidStr = userId.toString();
  const selectionInput: any[] = [];
  for (const c of opts.namedOnly ? [] : conversations) {
    const idStr = c._id.toString();
    if (c.user_id.toString() !== uidStr && !ownedByMeIds.has(idStr)) continue;
    selectionInput.push(
      ownedByMeIds.has(idStr) ? { ...c, owned_by_me: true } : c,
    );
  }
  const selection = selectWorkingSet(selectionInput, now);
  for (const kind of selection.truncated) truncated.add(kind);
  const { cutoff: clusterCutoff, belowFold } = computeFold(selection.members);

  const fold = {
    belowFold,
    clusterCutoff,
    selectionIds: new Set(selection.members.keys()),
    deliberateIds,
    ownedByMeIds,
  };
  const watched =
    opts.watchedWindow &&
    conversations.filter(
      (row) =>
        !row.inbox_killed_at &&
        shouldShowInInbox(row) &&
        (opts.watchedWindow?.showAll ||
          (!belowFoldFor(fold, row) &&
            !row.inbox_stashed_at &&
            !row.inbox_dismissed_at)),
    );
  let poolChildren: any[] = [];
  let scopedChildren: Map<string, any[]> | undefined;
  let maps: InboxSessionMaps;
  let loadIndexedLiveness:
    | ((ids: Id<"conversations">[]) => Promise<void>)
    | undefined;
  if (!opts.includeLiveness) {
    maps = EMPTY_INBOX_MAPS;
  } else if (watched) {
    const childParents = orderCliWatchCandidates(
      watched.filter(
        (row) =>
          !pinnedOverflowIds.has(row._id) &&
          canProbeCliWatchTranscript(row, now),
      ),
    ).slice(0, 128);
    const children = await Promise.all(
      childParents.map((row) => readInboxChildren(ctx.db, row._id)),
    );
    scopedChildren = new Map(
      childParents.map((row, i) => [row._id, children[i]]),
    );
    poolChildren = recentSubagents;
    const liveness = await readCliWatchLiveness(
      ctx.db,
      userId,
      watched,
      [...poolChildren, ...children.flat()],
      now,
    );
    maps = sessionMapsFromManagedRows(
      liveness.sessions,
      liveness.beats,
      now,
      liveness.daemonLastSeen,
    );
  } else if (opts.namedOnly) {
    const named = await buildNamedSessionMaps(ctx, userId, conversations, now);
    maps = named.maps;
    poolChildren = named.children.filter(
      (c: any) =>
        !byId.has(c._id.toString()) && pooledByWindows(c, userId, now),
    );
  } else if (opts.indexedLiveness) {
    const rows = await indexedInboxSessionRows(ctx, userId, now);
    const buildMaps = ({
      sessions,
      beats,
      latestDaemonHeartbeat,
    }: Awaited<ReturnType<typeof rows.withHistory>>) =>
      sessionMapsFromManagedRows(sessions, beats, now, latestDaemonHeartbeat);
    maps = buildMaps(rows);
    loadIndexedLiveness = async (ids) => {
      const next = buildMaps(await rows.withHistory(ids));
      if (foreignConvs.length)
        await mergeForeignConversationLiveness(ctx, next, foreignConvs, now);
      Object.assign(maps, next);
    };
  } else {
    maps = await buildUserSessionMaps(ctx, userId, now);
  }

  // buildUserSessionMaps only covers managed_sessions belonging to THIS user;
  // an owned foreign-run session's daemon rows belong to the running account,
  // so merge its liveness per-conversation or the row would always classify as
  // dead/idle even while the runner's agent is actively working.
  const foreignConvs = (watched || conversations).filter(
    (c) => c.user_id.toString() !== userId.toString(),
  );
  if (opts.includeLiveness && !loadIndexedLiveness && foreignConvs.length > 0) {
    await mergeForeignConversationLiveness(ctx, maps, foreignConvs, now);
  }

  return {
    conversations,
    maps,
    loadIndexedLiveness,
    ...fold,
    myOwnerRowById,
    ownerRowFor,
    truncated,
    pinnedOverflowIds,
    recentSubagents,
    poolChildren,
    scopedChildren,
    watched: watched || undefined,
  };
}

// Would one of the windows above have read this row? The named path asks it
// of a named row's teammates, which the full scan pools only when a window
// holds them: the runner's own top level rows, live or completed, updated
// inside the session window or filed inside the dismissed window, never a
// killed row unless pinned.
function pooledByWindows(c: any, userId: Id<"users">, now: number): boolean {
  if (c.user_id?.toString() !== userId.toString()) return false;
  if (isAdoptedChild(c))
    return c.inbox_adopted_at >= now - INBOX_DISMISSED_WINDOW_MS;
  if (c.is_subagent) return false;
  if (c.status !== "active" && c.status !== "completed") return false;
  if (c.inbox_pinned_at) return true;
  if (c.inbox_killed_at) return false;
  const filedAt = c.inbox_dismissed_at ?? c.inbox_stashed_at;
  if (filedAt !== undefined) return filedAt >= now - INBOX_DISMISSED_WINDOW_MS;
  if (c.inbox_snoozed_until) return true;
  return c.updated_at >= now - INBOX_SESSION_WINDOW_MS;
}
