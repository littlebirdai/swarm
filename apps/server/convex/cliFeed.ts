import { cliSessionClassifier, type RecencyRank } from "./cliSessionClassifier";
import { query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { normalizeWorkStateFilter, type WorkState } from "./inboxFilters";
import { resolveLabelConvIds } from "./buckets";
import { projectOverlaps } from "./projectPaths";
import {
  parseSearchTerms,
  rankConversationsByCoverage,
  groupMessagesByConversation,
} from "./searchCore";
import { formatSlugAsTitle } from "./lib/conversationBasics";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";
import { fetchMessageSearchPool } from "./lib/sessionSearchPool";
import { resolveReadScope, scopeLabels } from "./lib/sessionSearchScope";

export const feedForCLI = query({
  args: {
    // Optional so the WEB can call this too (session auth) — the new-session
    // page previews exactly what the stable-context hook will inject, from the
    // same query with the same params. The CLI always passes a token.
    api_token: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    query: v.optional(v.string()),
    project_path: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    member_name: v.optional(v.string()),
    mine_only: v.optional(v.boolean()),
    live_only: v.optional(v.boolean()),
    state: v.optional(v.string()),
    label: v.optional(v.string()),
    // `cast feed -g`: every team the caller belongs to, rows labelled by team.
    // Unset, the feed reads one workspace: the named or mapped team, else the
    // active team, else personal.
    all_teams: v.optional(v.boolean()),
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

    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    const projectPath = args.project_path;
    const startTime = args.start_time;
    const endTime = args.end_time ?? Date.now();
    const query = args.query?.trim();

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

    // Label filter: the labeled set IS the candidate pool. Labels exist to park
    // old sessions, which the recency-window fetches below would miss, so when a
    // label is given we hydrate its conversations directly instead.
    let labelConvIds: Set<string> | null = null;
    let labeledConvs: NonNullable<
      Awaited<ReturnType<typeof ctx.db.get<"conversations">>>
    >[] = [];
    if (args.label) {
      const resolved = await resolveLabelConvIds(ctx, authUserId, args.label);
      if ("error" in resolved) return { error: resolved.error };
      const hydrated = await Promise.all(
        [...resolved.convIds]
          .slice(0, 200)
          .map((id) => ctx.db.get(id as Id<"conversations">)),
      );
      labeledConvs = hydrated.filter(
        (c): c is (typeof labeledConvs)[number] => c !== null,
      );
      // Labels are project-bounded by default: the CLI passes cwd unless -g.
      if (args.project_path) {
        const bound = args.project_path;
        labeledConvs = labeledConvs.filter(
          (c) =>
            projectOverlaps(bound, c.project_path) ||
            projectOverlaps(bound, (c as any).git_root),
        );
      }
      labelConvIds = new Set(labeledConvs.map((c) => c._id.toString()));
    }

    let matchingConvIds: Set<string> | null = null;
    let queryMatchedOwnConversations: typeof ownConversations = [];
    let queryMatchedTeamConversations: typeof ownConversations = [];
    if (query && query.length >= 2) {
      // Single combined lookup (see fetchMessageSearchPool), then best-coverage
      // selection instead of a strict all-terms AND.
      const terms = parseSearchTerms(query);
      const { pool: searchResults } = await fetchMessageSearchPool(ctx, terms, {
        userId: authUserId,
        teamIds: effectiveTeamIds,
      });

      const rankedMatches = rankConversationsByCoverage(
        groupMessagesByConversation(searchResults, terms),
        terms,
      );
      matchingConvIds = new Set(rankedMatches.map((r) => r.convId));

      const matchedConvs = await Promise.all(
        Array.from(matchingConvIds)
          .slice(0, 25)
          .map(async (convId) => {
            try {
              return await ctx.db.get(convId as Id<"conversations">);
            } catch {
              return null;
            }
          }),
      );
      const validConvs = matchedConvs.filter(
        (c): c is NonNullable<typeof c> => c !== null,
      );

      // Filter own conversations by team when team is resolved
      queryMatchedOwnConversations = validConvs.filter((c) => {
        if (c.user_id.toString() !== authUserId.toString()) return false;
        if (resolvedTeamId) {
          const convTeamId = (
            (c as any).team_id ?? (c as any).active_team_id
          )?.toString();
          if (!convTeamId || !effectiveTeamIdSet.has(convTeamId)) return false;
        }
        return true;
      });

      const teamUserIdSet = new Set(
        teamUsers
          .filter((u) => u._id.toString() !== authUserId.toString())
          .map((u) => u._id.toString()),
      );
      // A message match is content: only sessions whose content may show.
      queryMatchedTeamConversations = validConvs.filter(
        (c) =>
          teamUserIdSet.has(c.user_id.toString()) && scope.contentVisible(c),
      );
    }

    const fetchLimit = query
      ? Math.min(offset + limit + 20, 100)
      : Math.min(offset + limit + 50, 200);
    // When the caller sets a date window, bound the index range itself. The
    // recency fetches below only see the newest rows per user, so an older
    // window post-filtered against them always came back empty — the range
    // has to ride by_user_updated for old windows to return their own top-N.
    const hasTimeWindow =
      args.start_time !== undefined || args.end_time !== undefined;
    const boundByWindow = <Q extends { gte: any; lte: any }>(q: Q): Q => {
      let qq: any = q;
      if (args.start_time !== undefined)
        qq = qq.gte("updated_at", args.start_time);
      if (args.end_time !== undefined) qq = qq.lte("updated_at", args.end_time);
      return qq;
    };
    let ownConversations = labelConvIds
      ? labeledConvs.filter(
          (c) => c.user_id.toString() === authUserId.toString(),
        )
      : await ctx.db
          .query("conversations")
          .withIndex("by_user_updated", (q) =>
            boundByWindow(q.eq("user_id", authUserId)),
          )
          .order("desc")
          .take(fetchLimit);

    // Merge in query-matched conversations that might be older
    if (queryMatchedOwnConversations.length > 0) {
      const existingIds = new Set(
        ownConversations.map((c) => c._id.toString()),
      );
      const additionalConvs = queryMatchedOwnConversations.filter(
        (c) => !existingIds.has(c._id.toString()),
      );
      ownConversations = [...ownConversations, ...additionalConvs];
    }

    // Include non-private team conversations whose team_id matches effective teams
    let teamConversations: typeof ownConversations = [];
    if (effectiveTeamIds.length > 0 && !args.mine_only) {
      const visibleTeamMembers = teamUsers.filter(
        (u) =>
          u._id.toString() !== authUserId.toString() &&
          (u.activity_visibility || "detailed") !== "hidden",
      );

      const visibleMemberIds = new Set(
        visibleTeamMembers.map((u) => u._id.toString()),
      );
      const isVisibleTeamConv = (c: (typeof ownConversations)[number]) =>
        scope.isVisible(c);

      if (labelConvIds) {
        teamConversations = labeledConvs.filter(
          (c) =>
            visibleMemberIds.has(c.user_id.toString()) && isVisibleTeamConv(c),
        );
      } else {
        const teamMemberConvos = await Promise.all(
          visibleTeamMembers.map(async (member) => {
            const convos = await ctx.db
              .query("conversations")
              .withIndex("by_user_updated", (q) =>
                boundByWindow(q.eq("user_id", member._id)),
              )
              .order("desc")
              // Recency justifies 10 per member on the hot path; a dated window
              // is a deliberate archaeology query, so give it real coverage.
              .take(hasTimeWindow ? 50 : 10);
            return convos.filter(isVisibleTeamConv);
          }),
        );
        teamConversations = teamMemberConvos.flat();
      }

      // Merge in query-matched team conversations that might be older than top-20
      if (queryMatchedTeamConversations.length > 0) {
        const existingTeamIds = new Set(
          teamConversations.map((c) => c._id.toString()),
        );
        const additionalTeam = queryMatchedTeamConversations.filter(
          (c) => !existingTeamIds.has(c._id.toString()),
        );
        teamConversations = [...teamConversations, ...additionalTeam];
      }
    }

    const isOwnConversation = (c: (typeof ownConversations)[number]) =>
      c.user_id.toString() === authUserId.toString();

    // Sessions this user OWNS belong in their feed even in --mine scope (they're
    // run by another account, so the scans above miss them when mine_only skips
    // team conversations entirely). Explicit assignment outranks default team
    // visibility — mirror computeInboxSessions. Reads the canonical owner SET
    // (session_owners), so a SECONDARY owner is included, not just the primary
    // held in the owner_user_id cache.
    const myOwnerRows = args.member_name
      ? []
      : await ctx.db
          .query("session_owners")
          .withIndex("by_user", (q: any) => q.eq("user_id", authUserId))
          .order("desc")
          .take(50);
    const myOwnedIds = new Set<string>(
      myOwnerRows.map((r: any) => r.conversation_id.toString()),
    );
    const isOwnedByMe = (c: { _id: { toString(): string } }) =>
      myOwnedIds.has(c._id.toString());

    const ownedConversations: typeof ownConversations = [];
    for (const r of myOwnerRows) {
      let conv: any = null;
      try {
        conv = await ctx.db.get((r as any).conversation_id);
      } catch {
        conv = null;
      }
      if (!conv || isOwnConversation(conv)) continue;
      ownedConversations.push(conv);
    }

    const candidateById = new Map<string, (typeof ownConversations)[number]>();
    for (const c of [
      ...ownConversations,
      ...teamConversations,
      ...ownedConversations,
    ]) {
      candidateById.set(c._id.toString(), c);
    }

    let filteredConversations = [...candidateById.values()]
      .filter((c): c is (typeof ownConversations)[number] => {
        if (
          filterUserId &&
          c.user_id.toString() !== filterUserId &&
          !(args.mine_only && isOwnedByMe(c))
        )
          return false;
        if (labelConvIds && !labelConvIds.has(c._id.toString())) return false;

        // Team filter: when team is resolved from directory, filter own sessions by team
        if (resolvedTeamId && isOwnConversation(c)) {
          const convTeamId = (
            (c as any).team_id ?? (c as any).active_team_id
          )?.toString();
          if (!convTeamId || !effectiveTeamIdSet.has(convTeamId)) return false;
        }
        if (startTime && c.updated_at < startTime) return false;
        if (endTime && c.updated_at > endTime) return false;
        if (matchingConvIds && !matchingConvIds.has(c._id.toString())) {
          // Also match on conversation title/subtitle
          const titleText = [c.title, c.subtitle]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          const queryLower = query?.toLowerCase() || "";
          const queryTerms = queryLower
            .split(/\s+/)
            .filter((w) => w.length > 1);
          const titleMatch =
            queryTerms.length > 0 &&
            queryTerms.every((w) => titleText.includes(w));
          if (!titleMatch) return false;
        }
        return true;
      })
      .sort((a, b) => b.updated_at - a.updated_at);

    const now = Date.now();
    const classifier = cliSessionClassifier(ctx, now);
    const liveStatusMap = new Map<string, string | undefined>();
    const managedMap = new Map<string, any>();
    for (const conv of filteredConversations) {
      const facts = await classifier.managedFor(conv);
      if (facts.session) managedMap.set(conv._id.toString(), facts.session);
      if (classifier.isLiveManaged(facts)) {
        liveStatusMap.set(conv._id.toString(), facts.session.agent_status);
      }
    }
    if (args.live_only) {
      filteredConversations = filteredConversations.filter((c) =>
        liveStatusMap.has(c._id.toString()),
      );
    }

    const stateFilter = normalizeWorkStateFilter(args.state);
    if (stateFilter === "pinned") {
      filteredConversations = filteredConversations.filter(
        (c) => !!c.inbox_pinned_at,
      );
    } else if (stateFilter === "hibernated") {
      filteredConversations = filteredConversations.filter(
        (c) => managedMap.get(c._id.toString())?.agent_status === "hibernated",
      );
    } else if (stateFilter === "live") {
      filteredConversations = filteredConversations.filter((c) =>
        liveStatusMap.has(c._id.toString()),
      );
    } else if (stateFilter) {
      // A work_state filter needs every candidate classified before paginating.
      const matching: typeof filteredConversations = [];
      for (const c of filteredConversations) {
        if ((await classifier.classify(c)).work_state === stateFilter)
          matching.push(c);
      }
      filteredConversations = matching;
    }

    const allConversations = filteredConversations.slice(
      offset,
      offset + Math.min(limit, 100),
    );

    // Rows are classified as they are built below (cached if a state filter
    // above already classified the full set). Keeps the no-filter feed —
    // including the daemon's stable-context build — bounded to ~limit
    // awaiting_input reads.

    const results: Array<{
      id: string;
      session_id: string;
      title: string;
      subtitle: string | null;
      project_path: string | null;
      updated_at: string;
      message_count: number;
      agent_type?: string;
      is_live?: boolean;
      agent_status?: string;
      work_state?: WorkState;
      is_killed?: boolean;
      is_completed?: boolean;
      recency_rank?: RecencyRank;
      is_pinned?: boolean;
      user?: { name: string | null; email: string | null };
      // Second-party owner (the member responsible for steering), when set.
      owner?: { name: string | null; email: string | null };
      owned_by_me?: boolean;
      preview: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }>;
      // Last few real prose messages — what the session is doing NOW. The head
      // preview alone misrepresents long sessions by their founding prompt.
      tail?: Array<{ line: number; role: string; content: string }>;
      idle_summary?: string;
      recent_files?: string[];
      worktree?: string;
      git_branch?: string;
      machine?: string;
      last_activity_at?: string;
      workspace?: string;
      team?: string;
    }> = [];

    // Machine label per unique (runner, device) pair, so a card names the
    // machine a session runs on. A session on another machine cannot be the
    // author of local working-tree edits — without this line agents guess.
    const deviceLabels = new Map<string, string>();
    for (const conv of allConversations) {
      const devId = (conv as any).owner_device_id as string | undefined;
      if (!devId) continue;
      const key = `${conv.user_id.toString()}:${devId}`;
      if (deviceLabels.has(key)) continue;
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) =>
          q.eq("user_id", conv.user_id).eq("device_id", devId),
        )
        .first();
      if (device?.label) deviceLabels.set(key, device.label);
    }

    // Only load messages for conversations in the final result set, and only
    // for sessions whose content the caller may read: a teammate's session
    // shared as a summary shows its title and summary, never its messages.
    for (const conv of allConversations) {
      const readsContent = scope.contentVisible(conv);
      const messages = readsContent
        ? await ctx.db
            .query("messages")
            .withIndex("by_conversation_id", (q) =>
              q.eq("conversation_id", conv._id),
            )
            .order("asc")
            .take(6)
        : [];

      let firstUserMessage = "";
      for (const msg of messages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            break;
          }
        }
      }

      const title =
        conv.title ||
        firstUserMessage ||
        (conv.slug ? formatSlugAsTitle(conv.slug) : null) ||
        "New Session";

      const preview: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }> = [];

      let lineNum = 0;
      for (const msg of messages) {
        lineNum++;
        if (msg.role === "user") {
          const hasToolResults =
            msg.tool_results && msg.tool_results.length > 0;
          if (!hasToolResults && msg.content?.trim()) {
            let content = msg.content.trim();
            if (content.length > 200) content = content.slice(0, 200) + "...";
            preview.push({
              line: lineNum,
              role: "user",
              content,
            });
          }
        } else if (msg.role === "assistant" && preview.length > 0) {
          let content = msg.content?.trim() || "";
          if (!content) continue;
          if (content.length > 60) content = content.slice(0, 60) + "...";
          preview.push({
            line: lineNum,
            role: "assistant",
            content,
            tool_calls_count: msg.tool_calls?.length,
            tool_results_count: msg.tool_results?.length,
          });
          if (preview.length >= 6) break;
        }
      }

      // Activity tail: newest real prose (user text or assistant text), with
      // ordinals that line up with `cast read <id> <line>`. Skipped for rows
      // short enough that the head preview already covers them.
      const headPreview = preview.slice(0, 2);
      const headMaxLine =
        headPreview.length > 0 ? headPreview[headPreview.length - 1].line : 0;
      const totalMessages = conv.message_count || 0;
      const recentMsgs = readsContent
        ? await ctx.db
            .query("messages")
            .withIndex("by_conversation_id", (q) =>
              q.eq("conversation_id", conv._id),
            )
            .order("desc")
            .take(12)
        : [];
      const lastActivityAt = recentMsgs[0]?.timestamp;
      const tail: Array<{ line: number; role: string; content: string }> = [];
      for (let i = 0; i < recentMsgs.length && tail.length < 2; i++) {
        const msg = recentMsgs[i];
        const line = Math.max(1, totalMessages - i);
        if (line <= headMaxLine) break;
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        if (msg.tool_results && msg.tool_results.length > 0) continue;
        const text = msg.content?.trim();
        if (!text) continue;
        // Collapse whitespace: the tail is a one-line snippet on a card, and
        // raw newlines from long assistant turns would break the card layout.
        const flat = text.replace(/\s+/g, " ");
        tail.unshift({
          line,
          role: msg.role,
          content: flat.length > 200 ? flat.slice(0, 200) + "..." : flat,
        });
      }

      const owner =
        teamUserMap.get(conv.user_id.toString()) ||
        (conv.user_id.toString() === authUserId.toString() ? user : null);
      const isOwnConv = conv.user_id.toString() === authUserId.toString();

      // Second-party owner display (distinct from `owner` above, which is the
      // RUNNER — historical local name). Owner docs are usually teammates and
      // already loaded; fall back to a direct get for cross-team edge cases.
      const sessionOwnerId = (conv as any).owner_user_id?.toString();
      let sessionOwner:
        | { name: string | null; email: string | null }
        | undefined;
      if (sessionOwnerId) {
        const ownerDoc =
          teamUserMap.get(sessionOwnerId) ||
          (sessionOwnerId === authUserId.toString()
            ? user
            : await ctx.db.get((conv as any).owner_user_id as Id<"users">));
        if (ownerDoc)
          sessionOwner = {
            name: ownerDoc.name || null,
            email: ownerDoc.email || null,
          };
      }

      results.push({
        id: conv._id,
        session_id: conv.session_id,
        title,
        subtitle: conv.subtitle || null,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || 0,
        agent_type: conv.agent_type,
        ...(await classifier.rowFields(conv)),
        is_pinned: !!conv.inbox_pinned_at,
        user:
          !isOwnConv && owner
            ? { name: owner.name || null, email: owner.email || null }
            : undefined,
        ...(sessionOwner ? { owner: sessionOwner } : {}),
        ...(sessionOwnerId === authUserId.toString()
          ? { owned_by_me: true }
          : {}),
        // With a tail present the head shrinks to the goal + first reply; a
        // short row (no tail beyond the head) keeps the old 4-message preview.
        preview: tail.length > 0 ? headPreview : preview.slice(0, 4),
        ...(tail.length > 0 ? { tail } : {}),
        ...(conv.idle_summary ? { idle_summary: conv.idle_summary } : {}),
        ...(readsContent && conv.recent_files && conv.recent_files.length > 0
          ? { recent_files: conv.recent_files }
          : {}),
        ...((conv as any).worktree_name &&
        (conv as any).worktree_status !== "merged" &&
        (conv as any).worktree_status !== "archived"
          ? { worktree: (conv as any).worktree_name }
          : {}),
        ...(conv.git_branch ? { git_branch: conv.git_branch } : {}),
        ...((conv as any).owner_device_id &&
        deviceLabels.get(
          `${conv.user_id.toString()}:${(conv as any).owner_device_id}`,
        )
          ? {
              machine: deviceLabels.get(
                `${conv.user_id.toString()}:${(conv as any).owner_device_id}`,
              ),
            }
          : {}),
        ...(lastActivityAt
          ? { last_activity_at: new Date(lastActivityAt).toISOString() }
          : {}),
        ...scopeLabels(scope, conv),
      });
    }

    return {
      conversations: results,
      scope: projectPath || "global",
    };
  },
});
