import { sanitizeConvexObjectKeys } from "./lib/convexFieldNames";
import { mutation, query, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkConversationAccess } from "./privacy";
import { claimShareToken } from "./lib/shareToken";
import { recordAuthorityEvent } from "./lib/authorityEvents";
import {
  formatSlugAsTitle,
  generateShareToken,
  isNonEmptyMessage,
} from "./lib/conversationBasics";
import { pageConversationMessages } from "./conversationMessages";
import {
  previewText,
  resolveSpawnParentId,
} from "./lib/conversationChildHelpers";
import {
  conversationAuthorForAccess,
  conversationForAccess,
  getAuthenticatedUserId,
} from "./lib/conversationHelpers";

export {
  generateShareToken,
  isNonEmptyMessage,
} from "./lib/conversationBasics";

export const generateShareLink = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only share your own conversations");
    }
    if (conversation.share_token) {
      return conversation.share_token;
    }
    const shareToken = generateShareToken();
    await claimShareToken(
      ctx,
      "conversations",
      conversation,
      shareToken,
      authUserId,
      args.api_token,
    );
    return shareToken;
  },
});

// "Anyone with the link" for one conversation, owner only: a token turns it on,
// null turns it off. The web mints the token (a v4 UUID, as generateShareToken
// does) so its draft and the stored value are the same string, and the store
// write lands at once (dispatch setShareLink). Clearing the token kills every
// copy of the link, guests and past signed-in redeemers alike (a redemption
// counts only while its token matches), and turning it back on takes a new
// token, so an old link never comes back to life. A profile pin is served by
// that same token, so turning the link off also takes it off the profile.
export async function writeShareLink(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  conversationId: string,
  token: string | null,
) {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const conversation = id ? await ctx.db.get(id) : null;
  if (!conversation) throw new Error("Conversation not found");
  if (conversation.user_id.toString() !== userId.toString())
    throw new Error(
      "Unauthorized: can only change sharing on your own conversations",
    );
  if (token === null && conversation.profile_pinned_at)
    await ctx.db.patch(conversation._id, { profile_pinned_at: undefined });
  await claimShareToken(ctx, "conversations", conversation, token, userId);
}

// Pin a session to the owner's PUBLIC profile. This is the consent act that
// makes a session world-visible, so it also guarantees a share_token — the
// profile card and the /share guest viewer both key off that token. Pinning a
// session that was private/team-only does NOT change is_private; it grants
// anonymous read of *this one session* via its share link, nothing more.
export const pinToProfile = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Unauthorized: must be logged in");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString())
      throw new Error("Unauthorized: can only pin your own conversations");

    const patch: { profile_pinned_at: number; share_token?: string } = {
      profile_pinned_at: Date.now(),
    };
    if (!conversation.share_token) patch.share_token = generateShareToken();
    await ctx.db.patch(args.conversation_id, {
      profile_pinned_at: patch.profile_pinned_at,
    });
    if (patch.share_token)
      await claimShareToken(
        ctx,
        "conversations",
        conversation,
        patch.share_token,
        authUserId,
        args.api_token,
      );
    return {
      pinned: true,
      share_token: conversation.share_token ?? patch.share_token,
    };
  },
});

// Remove a session from the public profile. Leaves the share_token intact — the
// owner may have circulated that link elsewhere; un-pinning only delists it from
// the profile (profilePublicSessionVisible then drops it).
export const unpinFromProfile = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Unauthorized: must be logged in");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString())
      throw new Error("Unauthorized: can only unpin your own conversations");
    await ctx.db.patch(args.conversation_id, { profile_pinned_at: undefined });
    return { pinned: false };
  },
});

// A signed-in viewer presenting a share link trades the token for a durable
// per-user redemption row. From then on every id-keyed query (the whole inbox
// surface) resolves them to "shared" through checkConversationAccess without
// carrying the token — and rotating the token invalidates the redemption,
// because access requires the stored token to still match. Anonymous guests
// don't redeem; they present the token on each query instead.
export const redeemShareToken = mutation({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();
    if (!conversation) return null;
    const existing = await ctx.db
      .query("share_redemptions")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversation_id", conversation._id).eq("user_id", userId),
      )
      .first();
    if (existing) {
      if (existing.token !== args.share_token) {
        await ctx.db.patch(existing._id, {
          token: args.share_token,
          created_at: Date.now(),
        });
      }
    } else {
      await ctx.db.insert("share_redemptions", {
        conversation_id: conversation._id,
        user_id: userId,
        token: args.share_token,
        created_at: Date.now(),
      });
    }
    await recordAuthorityEvent(ctx, {
      kind: "share_link_redeemed",
      actor_user_id: userId,
      conversation,
      share_table: "conversations",
      share_token: args.share_token,
      detail: { after: { redeemer: userId, renewed: !!existing } },
    });
    return { conversation_id: conversation._id };
  },
});

export const getSharedConversationMeta = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (conversations.length === 0) return null;

    const conversation = conversations[0];
    const user = await ctx.db.get(conversation.user_id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversation._id),
      )
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 200);
          if (text.length > 200) firstUserMessage += "...";
          break;
        }
      }
    }

    const title =
      conversation.title ||
      firstUserMessage ||
      (conversation.slug ? formatSlugAsTitle(conversation.slug) : null) ||
      "Coding Session";

    // idle_summary is the purpose-built one-liner (same preference as the
    // session card's sessionCardSummary); subtitle is a multi-bullet block, so
    // only its first bullet fits a link preview.
    const description =
      conversation.idle_summary?.trim() ||
      conversation.subtitle
        ?.split("\n")
        .find((l) => l.trim())
        ?.trim()
        .replace(/^[-*]\s+/, "") ||
      (conversation.title ? firstUserMessage : null) ||
      `${conversation.message_count || 0} messages${user?.name ? ` by ${user.name}` : ""}${conversation.project_path ? ` in ${conversation.project_path.split("/").pop()}` : ""}`;

    return {
      title,
      description,
      author: user?.name || null,
      message_count: conversation.message_count || 0,
      // The web server 302s /share/<token> straight to /conversation/<id>
      // (skipping a full app boot whose only job was this same lookup).
      conversation_id: conversation._id,
    };
  },
});

export const getConversationPublic = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
    before_timestamp: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return { access_level: "not_found" as const, conversation: null };
    }

    const authUserId = await getAuthUserId(ctx);
    const accessLevel = await checkConversationAccess(
      ctx,
      authUserId,
      conversation,
      args.share_token,
    );

    if (accessLevel === "denied") {
      return { access_level: "denied" as const, conversation: null };
    }

    const { messages: newestFirst, hasMore } = await pageConversationMessages(
      ctx.db,
      args.conversation_id,
      {
        before: args.before_timestamp,
        order: "desc",
        limit: args.limit ?? 100,
      },
    );
    newestFirst.reverse();
    const sortedMessages = newestFirst;
    const oldestTimestamp =
      sortedMessages.length > 0 ? sortedMessages[0].timestamp : null;

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
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
      conversation.title ||
      firstUserMessage ||
      (conversation.slug ? formatSlugAsTitle(conversation.slug) : null) ||
      "New Session";

    const parentConversationId = await resolveSpawnParentId(ctx, conversation);

    return sanitizeConvexObjectKeys({
      access_level: accessLevel,
      conversation: {
        ...conversationForAccess(conversation, accessLevel),
        title,
        messages: sortedMessages,
        user: conversationAuthorForAccess(user, accessLevel),
        has_more_above: hasMore,
        oldest_timestamp: oldestTimestamp,
        fork_count: conversation.fork_count,
        forked_from: conversation.forked_from,
        parent_conversation_id: parentConversationId,
      },
    });
  },
});

export const publishToDirectory = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only publish your own conversations");
    }

    if (!conversation.share_token) {
      throw new Error(
        "Conversation must be shared before publishing to directory",
      );
    }

    const existingPublic = await ctx.db
      .query("public_conversations")
      .filter((q) => q.eq(q.field("conversation_id"), args.conversation_id))
      .first();

    if (existingPublic) {
      await ctx.db.patch(existingPublic._id, {
        title: args.title,
        description: args.description,
        tags: args.tags,
      });
      return existingPublic._id;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .order("asc")
      .take(10);

    let previewText = "";
    for (const msg of messages) {
      if (msg.role === "user" && msg.content) {
        const text = msg.content.trim();
        if (text) {
          previewText = text.slice(0, 200);
          break;
        }
      }
    }

    if (!previewText) {
      previewText = "No preview available";
    }

    const publicConversationId = await ctx.db.insert("public_conversations", {
      conversation_id: args.conversation_id,
      user_id: conversation.user_id,
      title: args.title,
      description: args.description,
      tags: args.tags,
      preview_text: previewText,
      agent_type: conversation.agent_type,
      message_count: conversation.message_count,
      created_at: Date.now(),
      view_count: 0,
    });

    return publicConversationId;
  },
});

export const listPublicConversations = query({
  args: {
    search: v.optional(v.string()),
    sort: v.optional(v.union(v.literal("recent"), v.literal("popular"))),
    agent_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const sort = args.sort ?? "recent";

    let publicConversations = await ctx.db
      .query("public_conversations")
      .collect();

    if (args.agent_type) {
      publicConversations = publicConversations.filter(
        (pc) => pc.agent_type === args.agent_type,
      );
    }

    if (args.search && args.search.trim().length > 0) {
      const searchLower = args.search.toLowerCase();
      publicConversations = publicConversations.filter((pc) => {
        const titleMatch = pc.title.toLowerCase().includes(searchLower);
        const descMatch = pc.description?.toLowerCase().includes(searchLower);
        const previewMatch = pc.preview_text
          .toLowerCase()
          .includes(searchLower);
        return titleMatch || descMatch || previewMatch;
      });
    }

    if (sort === "popular") {
      publicConversations.sort((a, b) => b.view_count - a.view_count);
    } else {
      publicConversations.sort((a, b) => b.created_at - a.created_at);
    }

    const results = await Promise.all(
      publicConversations.slice(0, limit).map(async (pc) => {
        const user = await ctx.db.get(pc.user_id);
        const conversation = await ctx.db.get(pc.conversation_id);

        return {
          _id: pc._id,
          title: pc.title,
          description: pc.description,
          tags: pc.tags,
          preview_text: pc.preview_text,
          agent_type: pc.agent_type,
          message_count: pc.message_count,
          created_at: pc.created_at,
          view_count: pc.view_count,
          author_name: user?.name || user?.email?.split("@")[0] || "Unknown",
          author_avatar: user?.image || user?.github_avatar_url,
          share_token: conversation?.share_token || null,
        };
      }),
    );

    return results;
  },
});

// === Chained fork copy ===
//
// A single Convex mutation can write at most ~8192 documents / 16 MB. Large
// conversations would blow past that, so the fork mutations split message
// copying across multiple transactions linked by `scheduler.runAfter(0, ...)`.
//
// The fork target conversation carries the cursor + total + cutoff (see
// schema.ts). The kickoff mutation copies the first batch synchronously
// (so small forks finish in one round-trip), then if more remains schedules
// `_continueFork`, which advances the cursor batch by batch until done.
//
// The per-batch logic lives in forkCopy.ts so it can be unit-tested without
// dragging in Convex's module graph.
