import { query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { identityFieldsOf } from "./lib/sessionIdentityFields";
import {
  parseSearchTerms,
  rankConversationsByCoverage,
  groupMessagesByConversation,
  originMatch,
} from "./searchCore";
import { relevanceTier } from "@codecast/search/terms";
import { parseSessionQuery } from "@codecast/search/sessionQuery";
import { formatSlugAsTitle } from "./lib/conversationBasics";
import {
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
  loadConversationSearchScope,
  resolveFirstMessageTitles,
  searchableAs,
  usersViewerFirst,
} from "./lib/sessionSearchScope";

export const searchConversations = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    userOnly: v.optional(v.boolean()),
    // The workspace to search: unset searches the active team (else personal).
    activeTeamId: v.optional(v.id("teams")),
    // Every team the caller belongs to, each row labelled with its team.
    allTeams: v.optional(v.boolean()),
    mineOnly: v.optional(v.boolean()),
    since: v.optional(v.number()),
    sort: v.optional(v.union(v.literal("recent"), v.literal("relevance"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return [];
    }

    const scope = await loadConversationSearchScope(ctx, userId, user, args);

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return [];
    }

    const limit = args.limit ?? 20;
    const userOnly = args.userOnly ?? false;
    const parsed = parseSessionQuery(searchTerm);
    if (parsed.errors.length > 0) {
      return {
        results: [],
        totalMatches: 0,
        totalSessions: 0,
        error: parsed.errors.join("\n"),
      };
    }
    // Operators narrow first; the range picker is the same window as after:.
    const operatorRun = parsed.hasFilters
      ? await searchByOperators(
          ctx,
          {
            ...parsed,
            after: Math.max(parsed.after ?? 0, args.since ?? 0) || undefined,
          },
          // Operators read what a session did (files, commits, its text), so
          // they only reach sessions whose content the viewer may read.
          {
            viewerId: userId,
            users: usersViewerFirst(scope.userById, userId),
            contentVisible: scope.contentVisible,
            teamIds: scope.teamIds,
          },
          { userOnly },
        )
      : null;
    if (operatorRun && "error" in operatorRun) {
      return {
        results: [],
        totalMatches: 0,
        totalSessions: 0,
        error: operatorRun.error,
      };
    }
    const terms = operatorRun
      ? operatorRun.terms
      : parseSearchTerms(searchTerm);
    const { pool: searchResults, tier: contentTier } = operatorRun
      ? { pool: [] as SearchPoolMessage[], tier: operatorRun.tier }
      : await fetchMessageSearchPool(ctx, terms, {
          userId,
          teamIds: scope.teamIds,
        });
    const matchedAt = new Map(
      operatorRun?.hits.map((h) => [h.conv._id.toString(), h.matchedAt]),
    );

    // Which conversations qualify, as cast search decides it: a short query
    // needs every word, a longer one at least half, so a sentence degrades to
    // its best matches instead of to nothing. Quoted phrases stay required.
    const ranked = rankConversationsByCoverage(
      groupMessagesByConversation(searchResults, terms, userOnly),
      terms,
    );

    // Hydrate conversation docs for message matches in parallel (was a serial
    // await-in-loop, the dominant source of latency on common queries).
    const matchConvs = await Promise.all(
      ranked.map(({ messages }) => ctx.db.get(messages[0].conversation_id)),
    );
    const candidates: SearchCandidate[] = [];
    const seen = new Set<string>();
    ranked.forEach((r, i) => {
      const conv = matchConvs[i];
      // A message match is the session's content: only where it may show.
      if (!conv || !scope.contentVisible(conv)) return;
      seen.add(r.convId);
      candidates.push(searchCandidate(conv, r, terms));
    });
    // A session only its title or summaries matched has no message rows.
    if (!userOnly && !operatorRun) {
      for (const [convId, hit] of await fetchTitleFieldHits(ctx, terms, (c) =>
        searchableAs(scope, c),
      )) {
        if (!seen.has(convId)) candidates.push(hit);
      }
    }
    for (const hit of operatorRun?.hits ?? []) {
      candidates.push({ ...hit, workers: 0 });
    }

    // Visibility filter is synchronous (no DB): drop non-visible candidates
    // first, then fold workers into the sessions that ran them.
    const visible = await foldWorkersUnderParents(
      ctx,
      candidates.filter(({ conv }) => scope.isVisible(conv)),
      terms,
      scope.isVisible,
    );

    // Time-range filter applies before totals so the counts reflect what's
    // actually browsable under the current filters.
    const scored = args.since
      ? visible.filter((c) => c.conv.updated_at >= args.since!)
      : visible;

    if (args.sort === "relevance") {
      scored.sort(
        (a, b) =>
          b.relevance - a.relevance ||
          b.messages.length - a.messages.length ||
          b.conv.updated_at - a.conv.updated_at,
      );
    } else {
      // Newest first within a relevance tier: a near tie goes to the recent
      // session, a clear win does not. An operator match is as recent as the
      // change that matched it.
      const at = (c: SearchCandidate) =>
        matchedAt.get(c.conv._id.toString()) ?? c.conv.updated_at;
      scored.sort(
        (a, b) =>
          relevanceTier(b.relevance) - relevanceTier(a.relevance) ||
          at(b) - at(a),
      );
    }

    const results: Array<{
      conversationId: string;
      title: string;
      matchCount: number;
      matches: Array<{
        messageId: string;
        content: string;
        role: string;
        timestamp: number;
      }>;
      updatedAt: number;
      authorName: string;
      authorAvatar: string | null;
      isOwn: boolean;
      messageCount: number;
      relevance: number;
      // What the session began as and was called before, when that answers the
      // query and the current title may not (searchCore.originMatch).
      origin?: { started_as?: string; earlier_titles?: string[] };
      // Worker sessions that matched and are folded into this row.
      workerCount: number;
      titleMatch: boolean;
      projectPath: string | null;
      agentType: string | null;
      // The workspace the session belongs to (team:<id> or user:<id>), and its
      // team's name when the search spans every team.
      workspace: string;
      teamName?: string;
      // Who the row is (docs/architecture/session-characters.md S1), so a
      // search result wears the same face as its inbox card.
      identity: Awaited<ReturnType<typeof identityFieldsOf>>;
    }> = [];
    const totalMatches = scored.reduce((sum, c) => sum + c.messages.length, 0);
    const totalSessions = scored.length;
    const top = scored.slice(0, limit);

    const firstMsgByConv = await resolveFirstMessageTitles(
      ctx,
      top.map((c) => c.conv).filter(scope.contentVisible),
    );

    for (const candidate of top) {
      const { conv } = candidate;
      const messages = scope.contentVisible(conv) ? candidate.messages : [];
      const isOwn = conv.user_id.toString() === userId.toString();
      const conversationUser = scope.userById.get(conv.user_id.toString());
      const firstUserMessage = firstMsgByConv.get(conv._id.toString()) || "";

      const title =
        conv.title ||
        firstUserMessage ||
        (conv.slug ? formatSlugAsTitle(conv.slug) : null) ||
        "New Session";

      results.push({
        conversationId: conv._id,
        title,
        matchCount: messages.length,
        matches: searchSnippets({ ...candidate, messages }, terms).map(
          ({ message, content }) => ({
            messageId: message._id,
            content,
            role: message.role,
            timestamp: message.timestamp,
          }),
        ),
        updatedAt: conv.updated_at,
        authorName: conversationUser?.name || "Unknown",
        authorAvatar:
          (conversationUser as any)?.image ||
          (conversationUser as any)?.github_avatar_url ||
          null,
        isOwn,
        messageCount: conv.message_count || 0,
        relevance: candidate.relevance,
        origin: originMatch(searchableAs(scope, conv), terms),
        workerCount: candidate.workers,
        titleMatch: messages.length === 0 && terms.all.length > 0,
        projectPath: conv.project_path || null,
        agentType: conv.agent_type || null,
        workspace: scope.workspaceOf(conv),
        ...(scope.teamNameOf(conv) ? { teamName: scope.teamNameOf(conv) } : {}),
        identity: await identityFieldsOf(conv, (id: any) => ctx.db.get(id)),
      });
    }

    return {
      results,
      totalMatches,
      totalSessions,
      // Which pool served content matches ("recent" mirror vs "deep" full
      // index) and the mirror's coverage, so UI copy about time filters
      // beyond the window stays truthful (see searchMirror.ts).
      contentTier,
      contentWindowDays: CONTENT_WINDOW_DAYS,
      // Operator walks that stopped at a budget: the rows are the newest part
      // of the answer, and each line says how to reach the rest.
      truncated: operatorRun?.truncated ?? [],
    };
  },
});

// The cheap, reliable half of global search: only the conversation-level
// search indexes (title/subtitle/idle_summary), never the messages full-text
// index. Common tokens can blow the read budget on the message search (see
// the fetchMessageSearchPool NOTE) and kill searchConversations wholesale —
// clients call this alongside it, render these rows immediately, and merge in
// message matches if/when the full search returns (dedup by conversationId,
// message rows win). Result rows are shaped exactly like searchConversations
// results so the merge is a plain concat. userOnly callers skip this query:
// title matches aren't user-authored messages.
export const searchConversationTitles = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    activeTeamId: v.optional(v.id("teams")),
    allTeams: v.optional(v.boolean()),
    mineOnly: v.optional(v.boolean()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const empty = { results: [], totalMatches: 0, totalSessions: 0 };
    const userId = await getAuthUserId(ctx);
    if (!userId) return empty;
    const user = await ctx.db.get(userId);
    if (!user) return empty;

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) return empty;
    // Title hits cannot honor file:/pr:/... operators; searchConversations
    // answers an operator query on its own.
    if (parseSessionQuery(searchTerm).hasFilters) return empty;

    const terms = parseSearchTerms(searchTerm);
    if (terms.all.length === 0) return empty;
    const scope = await loadConversationSearchScope(ctx, userId, user, args);
    const hits = await fetchTitleFieldHits(ctx, terms, (c) =>
      searchableAs(scope, c),
    );

    const visible = [...hits.values()].filter(({ conv }) =>
      scope.isVisible(conv),
    );
    const scoped = args.since
      ? visible.filter(({ conv }) => conv.updated_at >= args.since!)
      : visible;
    scoped.sort(
      (a, b) =>
        relevanceTier(b.relevance) - relevanceTier(a.relevance) ||
        b.conv.updated_at - a.conv.updated_at,
    );
    const top = scoped.slice(0, args.limit ?? 20);
    const firstMsgByConv = await resolveFirstMessageTitles(
      ctx,
      top.map(({ conv }) => conv).filter(scope.contentVisible),
    );

    const results = await Promise.all(
      top.map(async ({ conv, relevance }) => {
        const conversationUser = scope.userById.get(conv.user_id.toString());
        const title =
          conv.title ||
          firstMsgByConv.get(conv._id.toString()) ||
          (conv.slug ? formatSlugAsTitle(conv.slug) : null) ||
          "New Session";
        return {
          conversationId: conv._id as string,
          title,
          matchCount: 0,
          matches: [] as Array<{
            messageId: string;
            content: string;
            role: string;
            timestamp: number;
          }>,
          updatedAt: conv.updated_at,
          authorName: conversationUser?.name || "Unknown",
          authorAvatar:
            (conversationUser as any)?.image ||
            (conversationUser as any)?.github_avatar_url ||
            null,
          isOwn: conv.user_id.toString() === userId.toString(),
          messageCount: conv.message_count || 0,
          relevance,
          origin: originMatch(conv, terms),
          workerCount: 0,
          titleMatch: true,
          projectPath: conv.project_path || null,
          agentType: conv.agent_type || null,
          workspace: scope.workspaceOf(conv),
          ...(scope.teamNameOf(conv)
            ? { teamName: scope.teamNameOf(conv) }
            : {}),
          identity: await identityFieldsOf(conv, (id: any) => ctx.db.get(id)),
        };
      }),
    );

    return { results, totalMatches: 0, totalSessions: results.length };
  },
});
