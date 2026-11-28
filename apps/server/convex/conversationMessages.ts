import { sanitizeConvexObjectKeys } from "./lib/convexFieldNames";
import { query } from "./functions";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { canOwnerOrTeamAccess, checkConversationAccess } from "./privacy";
import { isNonEmptyMessage } from "./lib/conversationBasics";
import { findChildConversations } from "./lib/conversationChildHelpers";
import {
  attachSenderIdentities,
  getConversationByRawId,
} from "./lib/conversationHelpers";

// One page of a conversation's messages, bounded on the timestamp index.
// Callers that post-filter `.lt(timestamp)` after `eq(conversation_id)` scan
// every newer row on a long session — the up-arrow / load-older path on a
// 5000-message thread. The index is (conversation_id, timestamp), so the
// bound belongs in withIndex. Same shape as getNewMessages / listMessagesTail.
export const MESSAGE_PAGE_MAX = 200;

export async function pageConversationMessages(
  db: { query: (table: "messages") => any },
  conversationId: Id<"conversations">,
  opts: {
    before?: number;
    after?: number;
    from?: number;
    order: "asc" | "desc";
    limit: number;
  },
): Promise<{ messages: any[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit, 0), MESSAGE_PAGE_MAX);
  const rows: any[] = await db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) => {
      let b = q.eq("conversation_id", conversationId);
      if (opts.before !== undefined) b = b.lt("timestamp", opts.before);
      if (opts.after !== undefined) b = b.gt("timestamp", opts.after);
      if (opts.from !== undefined) b = b.gte("timestamp", opts.from);
      return b;
    })
    .order(opts.order)
    .take(limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  return { messages: rows, hasMore };
}

export const getAllMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
    before_timestamp: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const accessLevel = await checkConversationAccess(
      ctx,
      authUserId,
      conversation,
      args.share_token,
    );
    if (accessLevel === "denied") {
      return null;
    }

    // Pagination-only payload. fetchOlderPage / target-mode loadOlder read
    // messages + has_more_above. Child/fork graphs belong on
    // getConversationWithMeta — recomputing them here on every older page is
    // what made up-arrow crawls on long sessions.
    const { messages: newestFirst, hasMore } = await pageConversationMessages(
      ctx.db,
      args.conversation_id,
      { before: args.before_timestamp, order: "desc", limit: args.limit ?? 50 },
    );
    newestFirst.reverse();
    const messages = await attachSenderIdentities(
      ctx,
      conversation.user_id,
      newestFirst,
    );

    // No conversation row in the result: the client already has meta from
    // getConversationWithMeta, and a live subscription (target-mode loadOlder)
    // would re-push the whole page on every heartbeat if updated_at rode along.
    return sanitizeConvexObjectKeys({
      messages,
      last_timestamp:
        messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more_above: hasMore,
      oldest_timestamp: messages.length > 0 ? messages[0].timestamp : null,
    });
  },
});

export const getMessagesAroundTimestamp = query({
  args: {
    conversation_id: v.string(),
    center_timestamp: v.number(),
    limit_before: v.optional(v.number()),
    limit_after: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await getConversationByRawId(
      ctx,
      args.conversation_id,
    );
    if (!conversation) {
      return null;
    }

    const accessLevel = await checkConversationAccess(
      ctx,
      authUserId,
      conversation,
      args.share_token,
    );
    if (accessLevel === "denied") {
      return null;
    }

    const before = await pageConversationMessages(ctx.db, conversation._id, {
      before: args.center_timestamp,
      order: "desc",
      limit: args.limit_before ?? 50,
    });
    before.messages.reverse();

    const after = await pageConversationMessages(ctx.db, conversation._id, {
      from: args.center_timestamp,
      order: "asc",
      limit: args.limit_after ?? 50,
    });

    const messages = await attachSenderIdentities(ctx, conversation.user_id, [
      ...before.messages,
      ...after.messages,
    ]);

    // Messages + cursors only. Spreading the conversation row made this live
    // jump query re-ship the window on every heartbeat (listMessagesTail
    // already keeps volatile fields out for the same reason).
    return sanitizeConvexObjectKeys({
      messages,
      last_timestamp:
        messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      oldest_timestamp: messages.length > 0 ? messages[0].timestamp : null,
      has_more_above: before.hasMore,
      has_more_below: after.hasMore,
    });
  },
});

export const getNewMessages = query({
  args: {
    conversation_id: v.string(),
    after_timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await getConversationByRawId(
      ctx,
      args.conversation_id,
    );
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    const PAGE_LIMIT = 2000;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q
          .eq("conversation_id", conversation._id)
          .gt("timestamp", args.after_timestamp),
      )
      .order("asc")
      .take(PAGE_LIMIT + 1);
    const hasMore = messages.length > PAGE_LIMIT;
    if (hasMore) messages.length = PAGE_LIMIT;

    // Deliberately NO findChildConversations here: this is the 1s recovery-poll /
    // background delta-sync query, and its consumers read only messages +
    // has_more + last_timestamp. Child data comes from the full-load queries;
    // computing it here cost O(children) queries per poll and timed out on
    // sessions with many subagent children.
    return sanitizeConvexObjectKeys({
      messages: await attachSenderIdentities(
        ctx,
        conversation.user_id,
        messages,
      ),
      last_timestamp:
        messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more: hasMore,
      updated_at: conversation.updated_at,
      title: conversation.title,
    });
  },
});

export const copyAllMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    paginationOpts: v.optional(paginationOptsValidator),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    if (
      (await checkConversationAccess(
        ctx,
        authUserId,
        conversation,
        args.share_token,
      )) === "denied"
    ) {
      return null;
    }

    const mapMsg = (m: any) => ({
      role: m.role,
      content: m.content || "",
      thinking: m.thinking || undefined,
      timestamp: m.timestamp,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
      subtype: m.subtype || undefined,
    });

    if (args.paginationOpts) {
      const result = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id),
        )
        .order("asc")
        .paginate(args.paginationOpts);
      const page = sanitizeConvexObjectKeys(
        result.page.filter(isNonEmptyMessage).map(mapMsg),
      );
      return {
        page,
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      };
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .order("asc")
      .collect();
    return sanitizeConvexObjectKeys(
      allMessages.filter(isNonEmptyMessage).map(mapMsg),
    );
  },
});

export const listMessages = query({
  args: {
    conversation_id: v.string(),
    paginationOpts: paginationOptsValidator,
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await getConversationByRawId(
      ctx,
      args.conversation_id,
    );
    // Missing conversation must return the empty-page shape, not throw — a
    // client can hold a stale conversation_id (deleted row, lost access) in
    // local state, and throwing crashes the React tree via usePaginatedQuery.
    // Sibling queries (getConversationWithMeta, copyAllMessages) already
    // degrade gracefully on this; align with them.
    if (!conversation) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    if (
      (await checkConversationAccess(
        ctx,
        authUserId,
        conversation,
        args.share_token,
      )) === "denied"
    ) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversation._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = await attachSenderIdentities(
      ctx,
      conversation.user_id,
      result.page,
    );
    return { ...result, page: sanitizeConvexObjectKeys(page) };
  },
});

export const getConversationMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    let messages;
    if (args.after_timestamp) {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q
            .eq("conversation_id", args.conversation_id)
            .gt("timestamp", args.after_timestamp!),
        )
        .order("asc")
        .collect();
    } else {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id),
        )
        .order("asc")
        .collect();
    }

    const {
      children: childConversations,
      map: childConversationMap,
      agentNameEntries,
    } = messages.length > 0
      ? await findChildConversations(ctx, args.conversation_id, messages)
      : { children: [], map: {}, agentNameEntries: [] };

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_entries: agentNameEntries,
      last_timestamp:
        messages.length > 0 ? messages[messages.length - 1].timestamp : null,
    };
  },
});

export const getMoreMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    cursor: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    const { messages, hasMore } = await pageConversationMessages(
      ctx.db,
      args.conversation_id,
      { after: args.cursor, order: "asc", limit: args.limit ?? 100 },
    );
    const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  },
});

export const getOlderMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    before_timestamp: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
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

    return {
      messages: newestFirst,
      has_more: hasMore,
      oldest_timestamp:
        newestFirst.length > 0 ? newestFirst[0].timestamp : null,
    };
  },
});

// The scan loop + the team-merge cursor protocol live in feedPagination.ts
// (pure TS) so their no-skip / always-progress invariants are unit-testable.
