import { cliSessionClassifier, recencyRankOf } from "./cliSessionClassifier";
import { query } from "./functions";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { isTeamMember } from "./privacy";
import { resolveSearchSelf, selfFamilyTest } from "./lib/searchSelf";
import { resolveLabelConvIds } from "./buckets";
import { projectOverlaps } from "./projectPaths";
import {
  parseSearchTerms,
  rankConversationsByCoverage,
  groupMessagesByConversation,
  evidenceWithFields,
  missingWords,
  partialCoverage,
  searchFieldsOf,
  originMatch,
} from "./searchCore";
import { MIRROR_WINDOW_MS } from "./searchMirror";
import { emptyEvidence, relevanceTier } from "@codecast/search/terms";
import {
  parseSessionQuery,
  type SessionQuery,
} from "@codecast/search/sessionQuery";
import { formatSlugAsTitle } from "./lib/conversationBasics";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";
import { resolveCliSearchPartial } from "./lib/cliSearchHelpers";
import {
  type OperatorHit,
  type SearchCandidate,
  type SearchPoolMessage,
  fetchMessageSearchPool,
  foldWorkersUnderParents,
  searchByOperators,
  searchCandidate,
  searchSnippets,
} from "./lib/sessionSearchPool";
import {
  CONTENT_WINDOW_DAYS,
  fetchTitleFieldHits,
  resolveFirstMessageTitles,
  resolveReadScope,
  scopeLabels,
  searchRowFacts,
  searchableAs,
} from "./lib/sessionSearchScope";

export const searchForCLI = query({
  args: {
    api_token: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    project_path: v.optional(v.string()),
    user_only: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    member_name: v.optional(v.string()),
    mine_only: v.optional(v.boolean()),
    label: v.optional(v.string()),
    titles_only: v.optional(v.boolean()),
    // `cast search -g`: every team the caller belongs to, rows labelled by team.
    all_teams: v.optional(v.boolean()),
    // The calling session (see resolveSearchSelf). It and its workers are
    // left out of the results unless include_self is set.
    self_conversation_id: v.optional(v.string()),
    self_session_id: v.optional(v.string()),
    include_self: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    let labelConvIds: Set<string> | null = null;
    if (args.label) {
      const resolved = await resolveLabelConvIds(ctx, authUserId, args.label);
      if ("error" in resolved) return { error: resolved.error };
      labelConvIds = resolved.convIds;
    }

    const scope = await resolveReadScope(ctx, authUserId, user, {
      teamId: args.team_id,
      projectPath: args.project_path,
      allTeams: args.all_teams,
    });
    if ("error" in scope) return { error: scope.error };
    const {
      teamUsers,
      teamIds: effectiveTeamIds,
      ownTeamId: resolvedTeamId,
    } = scope;
    const teamUserMap = scope.userById;
    // A pull request is readable by its team's members (canAccessPullRequest),
    // whichever team this read is scoped to.
    const teamMemberCache = new Map<string, boolean>();
    const canSeeTeam = async (teamId: Id<"teams">) => {
      const key = String(teamId);
      if (!teamMemberCache.has(key))
        teamMemberCache.set(key, await isTeamMember(ctx, authUserId, teamId));
      return teamMemberCache.get(key)!;
    };
    const effectiveTeamIdSet = new Set(
      effectiveTeamIds.map((id) => id.toString()),
    );

    let filterUserId: string | null = null;
    if (args.mine_only) {
      filterUserId = authUserId.toString();
    } else if (args.member_name) {
      const memberNameLower = args.member_name.toLowerCase();
      const matchingMember = teamUsers.find((u) => {
        const name = u.name?.toLowerCase() || "";
        const email = u.email?.toLowerCase() || "";
        return (
          name.includes(memberNameLower) || email.includes(memberNameLower)
        );
      });
      if (!matchingMember) {
        return { error: `No team member found matching "${args.member_name}"` };
      }
      filterUserId = matchingMember._id.toString();
    }

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return { error: "Query must be at least 2 characters" };
    }

    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    const startTime = args.start_time;
    const endTime = args.end_time ?? Date.now();
    const contextBefore = args.context_before ?? 0;
    const contextAfter = args.context_after ?? 0;
    const projectPath = args.project_path;
    const userOnly = args.user_only ?? false;
    const parsed = parseSessionQuery(searchTerm);
    if (parsed.errors.length > 0) {
      return { error: parsed.errors.join("\n") };
    }
    let terms = parseSearchTerms(searchTerm);

    // Who this caller may search at all: their own sessions, and teammates'
    // sessions the team feed shows them.
    const isVisibleConv = (conv: any): boolean => {
      if (!scope.isVisible(conv)) return false;
      const isOwn = conv.user_id.toString() === authUserId.toString();
      if (isOwn && resolvedTeamId) {
        // Own sessions: filter by team when team is resolved from directory
        const convTeamId = (conv.team_id ?? conv.active_team_id)?.toString();
        if (!convTeamId || !effectiveTeamIdSet.has(convTeamId)) return false;
      }
      return true;
    };

    // Shared by the message-match path and the titles_only path: every filter
    // that decides whether a conversation is in scope for this caller.
    const isEligibleConv = (conv: any): boolean => {
      if (!isVisibleConv(conv)) return false;

      // Filter by specific member (or self via --mine)
      if (filterUserId && conv.user_id.toString() !== filterUserId)
        return false;

      // Filter to sessions the caller filed under the given label —
      // project-bounded by default (the CLI passes cwd unless -g).
      if (labelConvIds) {
        if (!labelConvIds.has(conv._id.toString())) return false;
        if (
          projectPath &&
          !(
            projectOverlaps(projectPath, conv.project_path) ||
            projectOverlaps(projectPath, conv.git_root)
          )
        )
          return false;
      }

      if (startTime && conv.updated_at < startTime) return false;
      if (endTime && conv.updated_at > endTime) return false;
      return true;
    };

    // Every row carries the same liveness fields as a feed card, and ties below
    // relevance break toward sessions an agent can still reach cheaply: a
    // killed or long-quiet session keeps its seat in the results (its history
    // is worth reading) but sorts below a recent one.
    const now = Date.now();
    const classifier = cliSessionClassifier(ctx, now);
    const convRank = (conv: any) => recencyRankOf(conv, now);
    const byRankThenRecency = (a: any, b: any) =>
      convRank(a) - convRank(b) || b.updated_at - a.updated_at;

    // The calling session and its workers leave the results unless asked for;
    // the reply names what it left out, so an empty page never reads as "no
    // prior work" when the only matches were the caller's own.
    const selfId = args.include_self
      ? null
      : await resolveSearchSelf(ctx, authUserId, {
          conversation_id: args.self_conversation_id,
          session_id: args.self_session_id,
        });
    const inSelfFamily = selfId ? selfFamilyTest(ctx, selfId) : null;
    const excludedSelf = new Set<string>();
    const withoutSelf = async <T>(
      rows: T[],
      convOf: (row: T) => Doc<"conversations">,
    ): Promise<T[]> => {
      if (!inSelfFamily) return rows;
      const keep = await Promise.all(
        rows.map(async (row) => {
          const conv = convOf(row);
          if (!(await inSelfFamily(conv))) return true;
          excludedSelf.add(conv._id.toString());
          return false;
        }),
      );
      return rows.filter((_, i) => keep[i]);
    };
    const selfReport = async () => {
      if (!selfId || excludedSelf.size === 0) return {};
      const self = await ctx.db.get(selfId);
      return {
        excluded_self: {
          id: self?.short_id || selfId.toString().slice(0, 7),
          sessions: excludedSelf.size,
        },
      };
    };

    // One row shape for every path: what the session is, where it works,
    // whether it is live, and what it did (searchRowFacts).
    const deviceLabels = new Map<string, string | undefined>();
    const machineOf = async (conv: Doc<"conversations">) => {
      const devId = (conv as any).owner_device_id as string | undefined;
      if (!devId) return undefined;
      const devKey = `${conv.user_id.toString()}:${devId}`;
      if (!deviceLabels.has(devKey)) {
        const device = await ctx.db
          .query("devices")
          .withIndex("by_user_device", (q: any) =>
            q.eq("user_id", conv.user_id).eq("device_id", devId),
          )
          .first();
        deviceLabels.set(devKey, device?.label);
      }
      return deviceLabels.get(devKey);
    };
    type SearchRowMatch = {
      line: number;
      message_id?: Id<"messages">;
      role: string;
      content: string;
      timestamp: string;
      tool_calls_count?: number;
      tool_results_count?: number;
    };
    const rowOf = async (
      conv: Doc<"conversations">,
      title: string,
      hit: {
        relevance: number;
        coverage: number;
        workers?: number;
        matches?: SearchRowMatch[];
        title_match?: boolean;
      },
    ) => {
      const isOwnConv = conv.user_id.toString() === authUserId.toString();
      const owner =
        teamUserMap.get(conv.user_id.toString()) || (isOwnConv ? user : null);
      const machine = await machineOf(conv);
      const base = {
        id: conv.short_id || conv._id.toString().slice(0, 7),
        title,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || 0,
        relevance: hit.relevance,
        coverage: hit.coverage,
        // What the session began as and was called before, when that answers
        // the query and the current title may not (searchCore.originMatch).
        origin: originMatch(searchableAs(scope, conv), terms),
        // Worker sessions that matched and are folded into this row.
        ...(hit.workers ? { workers: hit.workers } : {}),
        user:
          !isOwnConv && owner
            ? { name: owner.name || null, email: owner.email || null }
            : undefined,
        ...(scope.contentVisible(conv) &&
        conv.recent_files &&
        conv.recent_files.length > 0
          ? { recent_files: conv.recent_files }
          : {}),
        ...((conv as any).worktree_name &&
        (conv as any).worktree_status !== "merged" &&
        (conv as any).worktree_status !== "archived"
          ? { worktree: (conv as any).worktree_name as string }
          : {}),
        ...(machine ? { machine } : {}),
        ...(await classifier.rowFields(conv)),
        // What a session did is its content: only where content may show.
        ...(scope.contentVisible(conv)
          ? await searchRowFacts(ctx, conv, canSeeTeam)
          : {}),
        matches: hit.matches ?? [],
        context: [] as Array<{ line: number; role: string; content: string }>,
        ...(hit.title_match ? { title_match: true } : {}),
        ...scopeLabels(scope, conv),
      };
      const row: typeof base & { missing_terms?: string[] } = base;
      rowConvIds.set(row, conv._id.toString());
      return row;
    };
    const rowConvIds = new WeakMap<object, string>();
    const titleOf = (
      conv: Doc<"conversations">,
      firstMessages: Map<string, string>,
    ) =>
      conv.title ||
      firstMessages.get(conv._id.toString()) ||
      (conv.slug ? formatSlugAsTitle(conv.slug) : null) ||
      "New Session";

    // titles_only: the reliable half of search — only the conversation-table
    // indexes (title/subtitle/idle_summary), never the messages full-text
    // index, which blows the read budget on common tokens (see the
    // fetchMessageSearchPool NOTE). The CLI retries with this after a content
    // search dies, so agents get title/summary hits instead of a hard error.
    // Operators in the query (file:, commit:, pr:, ...) take the operator
    // path, and the flags become the operators they are sugar for: --label is
    // label:, -s/-e are after:/before:, --mine and -m are author:.
    let operatorHits: OperatorHit[] | null = null;
    let operatorTruncated: string[] = [];
    if (parsed.hasFilters) {
      const operatorQuery: SessionQuery = {
        ...parsed,
        labels: [...parsed.labels, ...(args.label ? [args.label] : [])],
        authors: [
          ...parsed.authors,
          ...(args.mine_only
            ? ["me"]
            : args.member_name
              ? [args.member_name]
              : []),
        ],
        after:
          args.start_time !== undefined
            ? Math.max(parsed.after ?? 0, args.start_time)
            : parsed.after,
        before:
          args.end_time !== undefined
            ? Math.min(parsed.before ?? Infinity, args.end_time)
            : parsed.before,
      };
      const operatorRun = await searchByOperators(
        ctx,
        operatorQuery,
        {
          viewerId: authUserId,
          users: [user, ...teamUsers.filter((u) => u._id !== authUserId)],
          // Labels stay bounded to this project, as they are for --label.
          // Operators read what a session did: content-visible sessions only.
          contentVisible: (conv) =>
            isVisibleConv(conv) &&
            scope.contentVisible(conv) &&
            (operatorQuery.labels.length === 0 ||
              !projectPath ||
              projectOverlaps(projectPath, conv.project_path) ||
              projectOverlaps(projectPath, conv.git_root)),
          teamIds: effectiveTeamIds,
        },
        // A titles_only retry means the shared message pool blew the budget;
        // the per-session lookups still run.
        { userOnly, skipPool: args.titles_only },
      );
      if ("error" in operatorRun) return { error: operatorRun.error };
      terms = operatorRun.terms;
      operatorHits = await withoutSelf(operatorRun.hits, (hit) => hit.conv);
      operatorTruncated = operatorRun.truncated;
    }

    if (args.titles_only && !operatorHits) {
      const hits = await fetchTitleFieldHits(ctx, terms, (c) =>
        searchableAs(scope, c),
      );
      const tierOf = new Map(
        [...hits.values()].map((h) => [
          h.conv._id.toString(),
          relevanceTier(h.relevance),
        ]),
      );
      const visibleConvs = (
        await withoutSelf(
          [...hits.values()].map(({ conv }) => conv).filter(isEligibleConv),
          (conv) => conv,
        )
      ).sort(
        (a, b) =>
          tierOf.get(b._id.toString())! - tierOf.get(a._id.toString())! ||
          byRankThenRecency(a, b),
      );
      const page = visibleConvs.slice(offset, offset + limit);
      const firstMsgByConv = await resolveFirstMessageTitles(
        ctx,
        page.filter(scope.contentVisible),
      );
      const conversations = await Promise.all(
        page.map((conv) =>
          rowOf(conv, titleOf(conv, firstMsgByConv), {
            relevance: hits.get(conv._id.toString())?.relevance ?? 0,
            coverage: hits.get(conv._id.toString())?.coverage ?? 1,
            title_match: true,
          }),
        ),
      );
      // Titles match on half a long query's words too. Messages were not
      // searched here, so no word is named as held nowhere.
      const partial = partialCoverage(
        visibleConvs.map((conv) => ({
          missing: hits.get(conv._id.toString())?.missing ?? [],
        })),
        terms,
      );
      if (partial) {
        partial.missing_everywhere = [];
        for (const row of conversations) {
          const missing = hits.get(rowConvIds.get(row) ?? "")?.missing;
          if (missing?.length) row.missing_terms = missing;
        }
      }
      return {
        total_matches: 0,
        conversations,
        search_scope: projectPath || "global",
        titles_only: true,
        ...(partial ? { partial } : {}),
        ...(await selfReport()),
      };
    }

    const { pool: searchResults, saturated: poolSaturated } = operatorHits
      ? { pool: [] as SearchPoolMessage[], saturated: false }
      : await fetchMessageSearchPool(ctx, terms, {
          userId: authUserId,
          teamIds: effectiveTeamIds,
        });

    // Best-coverage selection: full-coverage conversations first, then partial
    // matches for longer queries, so a natural-language task description degrades
    // to best-match instead of no-match. Quoted phrases stay required.
    const messageGroups = groupMessagesByConversation(
      searchResults,
      terms,
      userOnly,
    );
    const rankedMatches = rankConversationsByCoverage(messageGroups, terms);

    const results: Array<Awaited<ReturnType<typeof rowOf>>> = [];

    let totalMatches = 0;

    // Hydrate candidate conversations in parallel (a serial await per candidate
    // was a major latency source), then apply the sync filters before any
    // further reads. Bounded to the best candidates — coverage order means the
    // tail is the weakest matches anyway. The label filter applies before the
    // bound: it's keyed by conversation id alone, and a small labeled set would
    // otherwise vanish whenever it falls outside the top candidates.
    const lci = labelConvIds;
    const rankedEligible = lci
      ? rankedMatches.filter((r) => lci.has(r.convId))
      : rankedMatches;
    // The caller's own family leaves inside the bound and the bound grows by
    // what it took, so a session whose workers hold the top candidates still
    // gets a page of other sessions; at most three bounds' worth of reads.
    const bound = Math.max(50, offset + limit * 3);
    const matched: SearchCandidate[] = [];
    let taken = 0;
    let want = bound;
    while (taken < want && taken < rankedEligible.length && taken < bound * 3) {
      const chunk = rankedEligible.slice(taken, Math.min(want, bound * 3));
      taken += chunk.length;
      const hydratedConvs = await Promise.all(
        chunk.map(({ messages }) => ctx.db.get(messages[0].conversation_id)),
      );
      const round: SearchCandidate[] = [];
      chunk.forEach((r, i) => {
        const conv = hydratedConvs[i];
        if (!conv) return;
        // A message match is the session's content: only where it may show.
        if (!isEligibleConv(conv) || !scope.contentVisible(conv)) return;
        round.push(searchCandidate(conv, r, terms));
      });
      const kept = await withoutSelf(round, (c) => c.conv);
      matched.push(...kept);
      want += round.length - kept.length;
    }
    // Workers fold into the session that ran them, then relevance tier, then
    // recency rank (live and recent above long-quiet above killed), then the
    // better answer, then the newer session. The caller's family is already
    // out, so its words never pull its parent onto the page either.
    const eligible = await foldWorkersUnderParents(
      ctx,
      matched,
      terms,
      isEligibleConv,
    );
    eligible.sort(
      (a, b) =>
        relevanceTier(b.relevance) - relevanceTier(a.relevance) ||
        convRank(a.conv) - convRank(b.conv) ||
        b.relevance - a.relevance ||
        b.conv.updated_at - a.conv.updated_at,
    );
    // Operator hits arrive ranked: coverage, then the newest matching change.
    if (operatorHits)
      eligible.push(...operatorHits.map((hit) => ({ ...hit, workers: 0 })));
    const page = eligible.slice(offset, offset + limit);

    const pageFirstMessages = await resolveFirstMessageTitles(
      ctx,
      page.map(({ conv }) => conv).filter(scope.contentVisible),
    );

    for (const candidate of page) {
      const { conv, coverage, relevance, workers } = candidate;

      // Line numbers are the match's rank, not its place in the transcript:
      // exact ones would need every message, which hits read limits. The
      // message id opens the match in place (`cast read <id>#<message_id>`).
      const formattedMatches = searchSnippets(
        {
          ...candidate,
          messages: scope.contentVisible(conv) ? candidate.messages : [],
        },
        terms,
      ).map(({ message: m, content }, idx) => ({
        line: idx + 1,
        message_id: m._id,
        role: m.role,
        content,
        timestamp: new Date(m.timestamp).toISOString(),
        tool_calls_count: m.tool_calls_count,
        tool_results_count: m.tool_results_count,
      }));
      totalMatches += formattedMatches.length;

      results.push(
        await rowOf(conv, titleOf(conv, pageFirstMessages), {
          relevance,
          coverage,
          workers,
          matches: formattedMatches,
        }),
      );
    }

    // A dated window usually points at history the content mirror no longer
    // holds (it only covers the last CONTENT_WINDOW_DAYS days), so a windowed
    // search also sweeps the title/subtitle/summary indexes — those live on
    // the conversations table and reach all time. Title hits rank below every
    // content hit and only fill seats the content page left open.
    let windowTitleRows: typeof results = [];
    const windowTitleMissing = new Map<string, string[]>();
    const hasTimeWindow =
      !operatorHits &&
      (args.start_time !== undefined || args.end_time !== undefined);
    if (hasTimeWindow) {
      const titleHits = await fetchTitleFieldHits(ctx, terms, (c) =>
        searchableAs(scope, c),
      );
      const contentIds = new Set(
        eligible.map(({ conv }) => conv._id.toString()),
      );
      const titleConvs = (
        await withoutSelf(
          [...titleHits.values()]
            .map(({ conv }) => conv)
            .filter((c) => !contentIds.has(c._id.toString()))
            .filter(isEligibleConv),
          (conv) => conv,
        )
      ).sort(byRankThenRecency);
      // Content pages consume the offset first; title rows page through once
      // the content matches are exhausted.
      const titleOffset = Math.max(0, offset - eligible.length);
      const fill = Math.max(0, limit - page.length);
      const titlePage = titleConvs.slice(titleOffset, titleOffset + fill);
      const firstMsgByConv = await resolveFirstMessageTitles(
        ctx,
        titlePage.filter(scope.contentVisible),
      );
      windowTitleRows = await Promise.all(
        titlePage.map((conv) =>
          rowOf(conv, titleOf(conv, firstMsgByConv), {
            relevance: 0,
            coverage: 0,
            title_match: true,
          }),
        ),
      );
      for (const conv of titleConvs) {
        windowTitleMissing.set(
          conv._id.toString(),
          missingWords(
            evidenceWithFields(
              { evidence: emptyEvidence(terms) },
              searchFieldsOf(conv),
              terms,
            ),
            terms,
          ),
        );
      }
    }

    const { partial, missingById } = await resolveCliSearchPartial({
      ctx,
      terms,
      eligible,
      page,
      windowTitleMissing,
      messageGroups,
      scope,
      poolSaturated,
      hasOperatorHits: !!operatorHits,
      userOnly,
      isEligibleConv,
      inSelfFamily,
    });
    if (partial) {
      for (const row of [...results, ...windowTitleRows]) {
        const missing = missingById.get(rowConvIds.get(row) ?? "");
        if (missing?.length) row.missing_terms = missing;
      }
    }

    const windowPredatesContent =
      args.start_time !== undefined &&
      args.start_time < Date.now() - MIRROR_WINDOW_MS;
    return {
      total_matches: totalMatches,
      conversations: [...results, ...windowTitleRows].slice(0, limit),
      search_scope: projectPath || "global",
      // Tells the CLI to explain that content matches can't reach the
      // requested window, so title hits are the reliable signal there.
      ...(windowPredatesContent
        ? { content_window_days: CONTENT_WINDOW_DAYS }
        : {}),
      ...(operatorTruncated.length ? { truncated: operatorTruncated } : {}),
      ...(partial ? { partial } : {}),
      ...(await selfReport()),
    };
  },
});
