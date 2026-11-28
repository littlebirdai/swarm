import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { shouldShowInInbox } from "./inboxFilters";
import { sessionOwnerRow } from "./sessionOwners";
import { requireUser } from "./lib/auth";
import { readLocalViewRevision, runLocalCommand } from "./localFirstCommands";
import {
  FAVORITES_GRANT_KEY,
  FAVORITES_VIEW_CONTRACT_ID,
  FAVORITES_VIEW_KEY,
  grantedView,
  projectFavoriteMembership,
  unauthenticatedView,
} from "./smallViewContracts";
import {
  favoriteCoverageForConversation,
  setFavoriteWithRevision,
  toggleFavoriteWithRevision,
} from "./favoriteViewWrites";
import { enrichInboxSessionRow, sortInboxRows } from "./lib/inboxEnrich";
import {
  EMPTY_INBOX_MAPS,
  buildUserSessionMaps,
  makeMemoGet,
  stampInboxViewerFields,
  stripInboxLiveness,
} from "./lib/inboxMaps";

export const toggleFavorite = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only favorite your own conversations");
    }

    return await toggleFavoriteWithRevision(ctx, conversation);
  },
});

/** Retry-safe desired-state favorite command; never model this as a toggle. */
export const setFavoriteV2 = mutation({
  args: {
    command_id: v.string(),
    conversation_id: v.id("conversations"),
    is_favorite: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(
      ctx,
      {
        principalId: userId,
        commandId: args.command_id,
        commandName: "favorites.set/v2",
        arguments: {
          conversationId: args.conversation_id,
          isFavorite: args.is_favorite,
        },
      },
      async () => {
        const conversation = await ctx.db.get(args.conversation_id);
        if (!conversation) {
          return {
            status: "rejected" as const,
            code: "MISSING",
            message: "Conversation not found",
          };
        }
        if (String(conversation.user_id) !== String(userId)) {
          return {
            status: "rejected" as const,
            code: "FORBIDDEN",
            message: "Can only favorite your own conversations",
          };
        }
        await setFavoriteWithRevision(
          ctx,
          conversation,
          args.is_favorite,
          "receipt",
        );
        return {
          status: "acknowledged" as const,
          result: {
            conversationId: conversation._id,
            isFavorite: args.is_favorite,
          },
          // A no-op still advances once for this new command receipt: its
          // optimistic overlay needs positive authoritative coverage to settle.
          coverageViews: [favoriteCoverageForConversation(conversation)],
        };
      },
    );
  },
});

export const listFavorites = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const favorites = await ctx.db
      .query("conversations")
      .withIndex("by_user_favorite", (q) =>
        q.eq("user_id", authUserId).eq("is_favorite", true),
      )
      .collect();

    return favorites
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((conv) => ({
        _id: conv._id,
        title: conv.title,
        session_id: conv.session_id,
        updated_at: conv.updated_at,
        message_count: conv.message_count,
        agent_type: conv.agent_type,
        is_favorite: conv.is_favorite,
      }));
  },
});

/** Complete principal favorite relation; conversation fields live elsewhere. */
export const listFavoritesV2 = query({
  args: {},
  handler: async (ctx) => {
    const identity = {
      contractId: FAVORITES_VIEW_CONTRACT_ID,
      viewKey: FAVORITES_VIEW_KEY,
    };
    const userId = await getAuthUserId(ctx);
    if (!userId) return unauthenticatedView(identity);

    const [favorites, viewRevision] = await Promise.all([
      ctx.db
        .query("conversations")
        .withIndex("by_user_favorite", (q) =>
          q.eq("user_id", userId).eq("is_favorite", true),
        )
        .collect(),
      readLocalViewRevision(ctx, userId, identity.contractId, identity.viewKey),
    ]);
    const projected = favorites
      .map(projectFavoriteMembership)
      .sort((left, right) =>
        String(left.conversation_id).localeCompare(
          String(right.conversation_id),
        ),
      );
    return grantedView(
      identity,
      { grantKeys: [FAVORITES_GRANT_KEY], viewRevision },
      {
        favorites: projected,
      },
    );
  },
});

// Favorites as FULL inbox session rows — the data source for the Favorites
// top-level view. Deliberately a separate channel from listInboxSessions:
//   • It enriches via enrichInboxSessionRow, so a favorite is byte-identical to
//     an inbox row (same SessionCard, keyboard nav, project chips — no second
//     shape to maintain, no schema drift clobbering rich rows with thin ones).
//   • It is NOT windowed to the last 30 days. A favorite is a kept reference;
//     the one you starred three months ago must still resolve. The index scan
//     walks only this user's favorites, so the unbounded set is naturally small.
//   • The client merges these into the same `sessions` cache but does NOT fold
//     them into liveInboxIds — so an old favorite reaches the shelf without
//     re-entering the active desk as if it were live work. A favorite that is
//     also recently active rides listInboxSessions too and shows in both.
// Mirrors listInboxSessions' include_liveness handling: the live web client
// opts out and gets agent_status/is_idle/... from the sessionsLiveness overlay
// (keyed by id, covers these rows for free) so this query doesn't re-run on
// every heartbeat.
export const listFavoriteSessions = query({
  args: {
    include_liveness: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { sessions: [] };
    const includeLiveness = args.include_liveness !== false;
    const now = Date.now();

    const favorites = await ctx.db
      .query("conversations")
      .withIndex("by_user_favorite", (q) =>
        q.eq("user_id", userId).eq("is_favorite", true),
      )
      .take(500);

    const maps = includeLiveness
      ? await buildUserSessionMaps(ctx, userId, now)
      : EMPTY_INBOX_MAPS;

    const getDoc = makeMemoGet(ctx);
    const results: any[] = [];
    for (const conv of favorites) {
      if (!shouldShowInInbox(conv)) continue;
      // clusterCutoff 0: favorites are deliberately kept — never gap-hide them.
      const { row } = await enrichInboxSessionRow(
        ctx,
        conv,
        maps,
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
      results.push(row);
    }

    sortInboxRows(results);
    if (!includeLiveness) for (const row of results) stripInboxLiveness(row);
    return { sessions: results };
  },
});
