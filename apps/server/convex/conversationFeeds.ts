import { mutation, query, type QueryCtx } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { inboxVisibilityFields } from "./inboxProjection";
import { createTeamFeedFilter } from "./privacy";
import { currentMembershipVisibility } from "./teamVisibility";
import { mergeUserMessageFeed, type FeedCandidate } from "./messageFeed";
import { formatSlugAsTitle } from "./lib/conversationBasics";
import {
  getAuthenticatedUserId,
  resolveInboxTeamScope,
} from "./lib/conversationHelpers";

// The command palette's row set. Split from the query wrapper (like
// performListActiveSessions) so the projection is testable without auth.
export async function performListRecentSessions(
  ctx: { db: QueryCtx["db"] },
  userId: Id<"users">,
) {
  const user = await ctx.db.get(userId);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const own = await ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q) =>
      q.eq("user_id", userId).gte("updated_at", thirtyDaysAgo),
    )
    .order("desc")
    .filter((q) =>
      q.and(
        q.neq(q.field("is_subagent"), true),
        q.or(
          q.eq(q.field("status"), "active"),
          q.eq(q.field("status"), "completed"),
        ),
      ),
    )
    .take(100);

  type ConvRow = (typeof own)[number];
  const isSessionRow = (c: ConvRow) =>
    c.is_subagent !== true &&
    (c.status === "active" || c.status === "completed");

  const byId = new Map<string, { conv: ConvRow; isOwn: boolean }>();
  for (const c of own) byId.set(c._id.toString(), { conv: c, isOwn: true });

  // Merge in team-visible sessions so teammates' work shows in the palette too.
  const effectiveTeamId = user?.active_team_id;
  const authorById = new Map<string, { name: string; avatar: string | null }>();
  if (effectiveTeamId) {
    const { visibleMembers, rows } = await collectTeammateConversationsSince(
      ctx,
      effectiveTeamId,
      userId,
      thirtyDaysAgo,
      () => 10,
    );
    const memberUsers = await Promise.all(
      visibleMembers.map((m) => ctx.db.get(m.user_id)),
    );
    for (const u of memberUsers) {
      if (u)
        authorById.set(u._id.toString(), {
          name: (u as any).name || (u as any).email?.split("@")[0] || "Unknown",
          avatar: (u as any).image || (u as any).github_avatar_url || null,
        });
    }
    for (const c of rows.filter(isSessionRow)) {
      const id = c._id.toString();
      if (!byId.has(id)) byId.set(id, { conv: c, isOwn: false });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.conv.updated_at - a.conv.updated_at)
    .slice(0, 100)
    .map(({ conv: c, isOwn }) => {
      const author = isOwn ? null : authorById.get(c.user_id.toString());
      return {
        _id: c._id,
        session_id: c.session_id,
        title: c.title,
        subtitle: c.subtitle,
        idle_summary: c.idle_summary,
        updated_at: c.updated_at,
        project_path: c.project_path,
        git_root: c.git_root,
        agent_type: c.agent_type,
        message_count: c.message_count,
        // The command palette builds its list from two sources: favorites
        // carry whole store rows (so the marker arrives), while recents come
        // from THIS projection. Omitting it left inbox_killed_at permanently
        // undefined on half the rows, so killed-awareness silently could not
        // work there. The conversation doc is already in hand — no extra read.
        // Stash/dismiss/pin ride along for the same reason: a palette-opened
        // session is injected into the client's sessions cache, and a row
        // seeded without its triage state renders as an active needs-input
        // card at boot (ct-42666).
        ...inboxVisibilityFields(c),
        isOwn,
        authorName: author?.name ?? null,
        authorAvatar: author?.avatar ?? null,
      };
    });
}

export const listRecentSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return performListRecentSessions(ctx, userId);
  },
});

export const listPrivateConversations = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid API token required");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", authUserId).eq("is_private", true),
      )
      .collect();

    const result = await Promise.all(
      conversations.map(async (c) => {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id),
          )
          .order("asc")
          .take(20);

        let firstUserMessage = "";
        for (const msg of messages) {
          const hasToolResults =
            msg.tool_results && msg.tool_results.length > 0;
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
          c.title ||
          firstUserMessage ||
          (c.slug ? formatSlugAsTitle(c.slug) : null) ||
          "New Session";

        return {
          conversation_id: c._id,
          session_id: c.session_id,
          title,
          agent_type: c.agent_type,
          started_at: c.started_at,
          updated_at: c.updated_at,
          message_count: c.message_count,
          project_path: c.project_path,
        };
      }),
    );

    return result.sort((a, b) => b.updated_at - a.updated_at);
  },
});

// Teammates' conversations updated after `since`: one bounded, newest-first
// range per visible member on by_team_user_updated (the viewer and hidden
// members are skipped, and the index bound means rows older than `since` are
// never read). Fanning out per member instead of scanning the whole team keeps
// the viewer's OWN rows out of the read set, so a live subscriber never re-runs
// on the viewer's own heartbeats, and it reuses the index the team feed pages
// on. `perMember(memberCount)` caps reads per member so total work is bounded
// regardless of team size.
export async function collectTeammateConversationsSince(
  ctx: Pick<QueryCtx, "db">,
  teamId: Id<"teams">,
  viewerId: Id<"users">,
  since: number,
  perMember: (memberCount: number) => number,
) {
  const feedFilter = await createTeamFeedFilter(ctx, teamId);
  const visibleMembers = feedFilter.memberships.filter(
    (m) =>
      m.user_id.toString() !== viewerId.toString() &&
      currentMembershipVisibility(m) !== "hidden",
  );
  const take = Math.max(1, perMember(visibleMembers.length));
  const perMemberRows = await Promise.all(
    visibleMembers.map((m) =>
      ctx.db
        .query("conversations")
        .withIndex("by_team_user_updated", (q) =>
          q
            .eq("team_id", teamId)
            .eq("user_id", m.user_id)
            .gt("updated_at", since),
        )
        .order("desc")
        .take(take)
        .then((rows) => rows.filter((c) => feedFilter.isVisible(c))),
    ),
  );
  return { feedFilter, visibleMembers, rows: perMemberRows.flat() };
}

// Total doc reads one unread recount may spend across all teammates. The badge
// is a count, not a list: when a member has more than their share of unread
// rows the number saturates rather than the query scanning further.
export const TEAM_UNREAD_MAX_READS = 100;

// Sidebar "Feed" badge: teammates' feed-visible conversations updated since the
// viewer last opened the feed (markTeamConversationsSeen). A live subscription
// on every connected client, so the read set must stay small: only rows past
// the viewer's read mark are read, and never the viewer's own.
export const getTeamUnreadCount = query({
  args: {
    teamId: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return 0;
    }

    const requestedTeamId = args.teamId || user.active_team_id;
    const effectiveTeamId = requestedTeamId
      ? await resolveInboxTeamScope(ctx, userId, requestedTeamId)
      : null;
    if (!effectiveTeamId) {
      return 0;
    }

    const lastSeen = user.team_conversations_last_seen || 0;
    const { rows } = await collectTeammateConversationsSince(
      ctx,
      effectiveTeamId,
      userId,
      lastSeen,
      (members) =>
        Math.max(3, Math.floor(TEAM_UNREAD_MAX_READS / Math.max(members, 1))),
    );
    return rows.length;
  },
});

export const markTeamConversationsSeen = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    await ctx.db.patch(userId, {
      team_conversations_last_seen: Date.now(),
    });

    return { success: true };
  },
});

export const getMessageFeed = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
    // The workspace the viewer is looking at; unset reads the active-team
    // pointer. "team" shows that one team, never every team the viewer is in.
    activeTeamId: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { messages: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { messages: [], nextCursor: null };
    }

    const limit = args.limit ?? 30;
    const cursor = args.cursor; // exclusive upper bound on message timestamp

    // --- 1. Candidate conversations ---------------------------------------
    // The feed is driven by the conversations the viewer can see, NOT by a
    // global scan of every message in the system. "my" = the viewer's own
    // conversations; "team" = those plus teammates' team-visible ones. This
    // keeps cost proportional to the viewer's own data. The old query walked
    // the global by_timestamp index in batches of 200 full docs and discarded
    // everything the viewer couldn't see — catastrophic for "my" (where the
    // viewer's messages are sparse among everyone's) and it blew the 100MB
    // read-byte cap, because each message doc carries its tool_results blobs
    // and a 1024-float embedding.
    const CONV_CAP = 500; // viewer's own conversations considered
    const TEAM_MEMBER_CONV_CAP = 50; // recent conversations per teammate

    type ConvDoc = NonNullable<
      Awaited<ReturnType<typeof ctx.db.get<"conversations">>>
    >;
    const candidates = new Map<
      string,
      { conv: ConvDoc; isOwn: boolean; authorName: string }
    >();

    // "team" reads ONE workspace: the active team (membership-proven), else
    // the viewer's personal workspace. The viewer's own sessions follow their
    // routing (team_id) into the team view, the same split the activity feed
    // makes; a teammate's must pass that team's visibility filter. Every row
    // carries the workspace its conversation belongs to, so a client holding
    // rows from a workspace it viewed earlier cannot show them in this one.
    const scopeTeamId =
      args.filter === "team"
        ? await resolveInboxTeamScope(ctx, userId, args.activeTeamId)
        : null;
    const inScope = (conv: ConvDoc) =>
      args.filter !== "team" ||
      (scopeTeamId
        ? String(conv.team_id ?? "") === String(scopeTeamId)
        : !conv.team_id);

    const ownAuthor = user.name || user.email?.split("@")[0] || "Unknown";
    const ownConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(CONV_CAP);
    for (const conv of ownConvs) {
      if (!inScope(conv)) continue;
      candidates.set(conv._id.toString(), {
        conv,
        isOwn: true,
        authorName: ownAuthor,
      });
    }

    if (scopeTeamId) {
      const ff = await createTeamFeedFilter(ctx, scopeTeamId);
      for (const member of ff.memberships) {
        if (String(member.user_id) === String(userId)) continue;
        if (currentMembershipVisibility(member) === "hidden") continue;
        const memberUser = await ctx.db.get(member.user_id);
        const memberAuthor =
          memberUser?.name || memberUser?.email?.split("@")[0] || "Unknown";
        const memberConvs = await ctx.db
          .query("conversations")
          .withIndex("by_team_user_updated", (q) =>
            q.eq("team_id", scopeTeamId).eq("user_id", member.user_id),
          )
          .order("desc")
          .take(TEAM_MEMBER_CONV_CAP);
        for (const conv of memberConvs) {
          if (candidates.has(conv._id.toString())) continue;
          if (!ff.contentVisible(conv as any)) continue; // the feed is prompt text: content, not summary
          candidates.set(conv._id.toString(), {
            conv,
            isOwn: false,
            authorName: memberAuthor,
          });
        }
      }
    }

    // --- 2. Merge user-role messages across conversations -----------------
    // Only user-role messages are ever rendered in the feed (the client drops
    // every other role), so we read just those via by_conversation_role_timestamp
    // — never touching the large assistant/tool docs the old query paid to read
    // and throw away. The merge + early-exit lives in messageFeed.ts so it can be
    // unit-tested; here we just supply the candidates and an index-backed fetcher.
    // Provenance travels with the candidate so the merge can mark prompts an
    // agent wrote. A subagent row is agent-written end to end; a row another
    // session started with `cast spawn`, or a scheduled run, is agent-written
    // only in its seed. Short ids are the first 7 chars of the conversation id.
    const feedCandidates: FeedCandidate[] = [...candidates.values()].map(
      ({ conv, isOwn, authorName }) => {
        const agentSource =
          conv.parent_conversation_id ?? conv.spawned_by_conversation_id;
        return {
          conversation_id: conv._id,
          updated_at: conv.updated_at,
          title:
            conv.title ||
            (conv.slug ? formatSlugAsTitle(conv.slug) : "New Session"),
          session_id: conv.session_id,
          isOwn,
          authorName,
          isSubagent: conv.is_subagent === true,
          machineSeeded: !!(
            conv.spawned_by_conversation_id || conv.agent_task_id
          ),
          agentSource: agentSource
            ? agentSource.toString().slice(0, 7)
            : undefined,
        };
      },
    );

    const page = await mergeUserMessageFeed({
      candidates: feedCandidates,
      cursor,
      limit,
      fetchUserMessages: (conversationId, cur, take) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) => {
            const base = q
              .eq("conversation_id", conversationId as Id<"conversations">)
              .eq("role", "user");
            return cur !== undefined ? base.lt("timestamp", cur) : base;
          })
          .order("desc")
          .take(take),
      fetchSeedMessageId: async (conversationId) => {
        const first = await ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q
              .eq("conversation_id", conversationId as Id<"conversations">)
              .eq("role", "user"),
          )
          .order("asc")
          .take(1);
        return first[0]?._id ?? null;
      },
    });
    return {
      ...page,
      messages: page.messages.map((m) => {
        const conv = candidates.get(String(m.conversation_id))?.conv;
        return {
          ...m,
          workspace: conv?.team_id ? `team:${conv.team_id}` : `user:${userId}`,
        };
      }),
    };
  },
});
