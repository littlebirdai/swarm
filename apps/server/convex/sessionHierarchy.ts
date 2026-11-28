import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { patchConversationLifecycle } from "./lib/sessionStatusWriter";
import { isConversationOwner } from "./privacy";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";

export const clearParentMessageUuid = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only modify your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      parent_message_uuid: undefined,
    });
    return true;
  },
});

export const setParentConversation = mutation({
  args: {
    conversation_id: v.id("conversations"),
    parent_conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    if (conv.parent_conversation_id) return;
    // The parent must be the caller's too (linkSessions' rule): a link to
    // someone else's conversation surfaces its title in the caller's lists.
    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || !(await isConversationOwner(ctx, userId, parent)))
      throw new Error("Not found");
    const isSubagent = !conv.parent_message_uuid;
    await ctx.db.patch(args.conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: isSubagent || undefined,
    });
  },
});

export const backfillIsSubagent = mutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const batchSize = args.limit ?? 200;
    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null });

    let patched = 0;
    for (const conv of result.page) {
      if (conv.is_subagent !== undefined) continue;
      if (conv.parent_conversation_id && !conv.parent_message_uuid) {
        await ctx.db.patch(conv._id, { is_subagent: true });
        patched++;
      }
    }
    const nextCursor = !result.isDone ? result.continueCursor : null;
    return { scanned: result.page.length, patched, nextCursor };
  },
});

export const linkSessions = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    subagent_description: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // A row parented to itself is a subagent of nothing: every list that
    // skips children (inbox, team feed, Now) hides it for good.
    if (args.parent_conversation_id === args.child_conversation_id) return;

    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || parent.user_id !== userId)
      throw new Error("Parent not found");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (child.parent_conversation_id) return;

    await patchConversationLifecycle(ctx, args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: true,
      inbox_dismissed_at: Date.now(),
      ...(args.subagent_description && !child.subagent_description
        ? { subagent_description: args.subagent_description }
        : {}),
    });
  },
});

// Link a VISIBLE child to the session that spawned it (agent-team teammate →
// its lead). Unlike linkSessions this neither marks the child a subagent nor
// dismisses it — the child stays a first-class inbox card; the pointer only
// powers the "Parent" click-through and teammate-name resolution. Also stamps
// both sides with the agent-team identity: the child's teamName/agentName come
// from its JSONL stamps, and the lead (whose transcript is never stamped) gets
// agent_name "team-lead" so siblings can resolve it by name.
export const linkSpawnedBy = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    agent_team_name: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || parent.user_id !== userId)
      throw new Error("Parent not found");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (!child.spawned_by_conversation_id) {
      await ctx.db.patch(args.child_conversation_id, {
        spawned_by_conversation_id: args.parent_conversation_id,
        ...(args.agent_team_name && !child.agent_team_name
          ? { agent_team_name: args.agent_team_name }
          : {}),
        ...(args.agent_name && !child.agent_name
          ? { agent_name: args.agent_name }
          : {}),
      });
    }

    if (args.agent_team_name && !parent.agent_team_name) {
      await ctx.db.patch(args.parent_conversation_id, {
        agent_team_name: args.agent_team_name,
        ...(parent.agent_name ? {} : { agent_name: "team-lead" }),
      });
    }
  },
});

export const linkPlanHandoff = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (child.parent_message_uuid === "plan-handoff") return;
    if (args.parent_conversation_id === args.child_conversation_id) return;
    // The parent must be the caller's too (linkSessions' rule).
    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || !(await isConversationOwner(ctx, userId, parent)))
      throw new Error("Parent not found");

    await ctx.db.patch(args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      parent_message_uuid: "plan-handoff",
    });
  },
});

export const adminLookupConversation = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    session_id: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    let conv;
    if (args.conversation_id) {
      conv = await ctx.db.get(args.conversation_id);
      if (conv && conv.user_id.toString() !== userId.toString()) conv = null;
    } else if (args.session_id) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q: any) =>
          q.eq("session_id", args.session_id),
        )
        .filter((q: any) => q.eq(q.field("user_id"), userId))
        .first();
    }
    if (!conv) return null;
    return {
      _id: conv._id,
      session_id: conv.session_id,
      title: conv.title,
      parent_conversation_id: conv.parent_conversation_id,
      parent_message_uuid: conv.parent_message_uuid,
      is_subagent: conv.is_subagent,
      inbox_dismissed_at: conv.inbox_dismissed_at,
      project_path: conv.project_path,
      created_at: conv._creationTime,
    };
  },
});

export const adminFindChildren = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q) =>
        q.eq("parent_conversation_id", args.parent_conversation_id),
      )
      .collect();
    // Scope to the caller's own children, matching adminLookupConversation. The
    // sibling was correctly user-scoped; this one dropped it and listed any
    // parent's children.
    return children
      .filter((c) => c.user_id.toString() === userId.toString())
      .map((c) => ({
        _id: c._id,
        session_id: c.session_id,
        title: c.title,
        is_subagent: c.is_subagent,
        parent_conversation_id: c.parent_conversation_id,
      }));
  },
});

export const adminLinkChildrenBySessionId = mutation({
  args: {
    parent_session_id: v.string(),
    child_session_ids: v.array(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) =>
        q.eq("session_id", args.parent_session_id),
      )
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!parent) throw new Error("Parent not found");

    const results: Array<{
      session_id: string;
      status: string;
      conversation_id?: string;
    }> = [];
    for (const childSessionId of args.child_session_ids) {
      const child = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", childSessionId))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (!child) {
        results.push({ session_id: childSessionId, status: "not_found" });
        continue;
      }
      if (child.parent_conversation_id === parent._id) {
        results.push({
          session_id: childSessionId,
          status: "already_linked",
          conversation_id: child._id,
        });
        continue;
      }
      await patchConversationLifecycle(ctx, child._id, {
        parent_conversation_id: parent._id,
        is_subagent: true,
        inbox_dismissed_at: Date.now(),
      });
      results.push({
        session_id: childSessionId,
        status: "linked",
        conversation_id: child._id,
      });
    }
    return {
      parent_id: parent._id,
      parent_session_id: parent.session_id,
      results,
    };
  },
});

export const adminUnlinkSession = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv) throw new Error("Not found");
    await patchConversationLifecycle(ctx, conv._id, {
      parent_conversation_id: undefined,
      is_subagent: undefined,
      inbox_dismissed_at: undefined,
    });
    return { unlinked: conv._id };
  },
});
