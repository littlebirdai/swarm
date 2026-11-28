import { mutation, query } from "./functions";
import { v } from "convex/values";
import {
  findConversationBySessionReference,
  resolveConversationRefRanked,
  findConversationByAnyRef,
} from "./conversationSessionLookup";
import { getAuthUserId } from "@convex-dev/auth/server";
import { identityFieldsOf } from "./lib/sessionIdentityFields";
import { Doc, Id } from "./_generated/dataModel";
import { inboxVisibilityFields } from "./inboxProjection";
import {
  canTeamMemberAccess,
  canOwnerOrTeamAccess,
  checkConversationAccess,
  isConversationTeamVisible,
  type AccessLevel,
} from "./privacy";
import { claimShareToken } from "./lib/shareToken";
import {
  formatSlugAsTitle,
  generateShareToken,
} from "./lib/conversationBasics";
import {
  conversationAuthorForAccess,
  getAuthenticatedUserId,
  isSharedChildOf,
  resolveActingAuthor,
} from "./lib/conversationHelpers";

export const webGet = query({
  args: {
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
    // The conversation the reference is drawn in, and the share token its
    // viewer presented: lets a share-link viewer resolve that conversation's
    // shared workers (isSharedChildOf).
    in_conversation: v.optional(v.string()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId && !args.in_conversation) return null;
    const sharedChild = (c: Doc<"conversations">) =>
      isSharedChildOf(ctx, userId, c, args.in_conversation, args.share_token);

    let conv: Doc<"conversations"> | null = null;
    if (args.short_id) {
      conv = (await resolveConversationRefRanked(
        ctx,
        args.short_id,
        userId ?? "",
        async (c) =>
          (userId
            ? await canTeamMemberAccess(ctx, userId, c as Doc<"conversations">)
            : false) || (await sharedChild(c as Doc<"conversations">)),
      )) as Doc<"conversations"> | null;
    } else if (args.id) {
      const id = ctx.db.normalizeId("conversations", args.id);
      conv = id ? await ctx.db.get(id) : null;
    }

    if (!conv) return null;
    const isOwner = !!userId && conv.user_id.toString() === userId.toString();
    const access: AccessLevel =
      userId && (await canOwnerOrTeamAccess(ctx, userId, conv))
        ? isOwner
          ? "owner"
          : "team"
        : (await sharedChild(conv))
          ? "shared"
          : "denied";
    if (access === "denied") return null;

    // Author identity, only for teammates' sessions (own sessions skip the read).
    // The reference pill/hover use this to show the author's avatar when the
    // session isn't yours — same name/avatar convention as the inbox feed rows.
    // An anchor always shows its bot identity, even on the host's own session.
    const owner = isOwner
      ? null
      : conversationAuthorForAccess(await ctx.db.get(conv.user_id), access);
    const acting = await resolveActingAuthor(ctx, conv);

    return {
      // A share-link viewer opens the worker through its own link.
      ...(access === "shared" ? { share_token: conv.share_token } : {}),
      _id: conv._id,
      short_id: conv.short_id,
      title: conv.title,
      short_title: conv.short_title,
      status: conv.status,
      message_count: conv.message_count,
      project_path: conv.project_path,
      model: conv.model,
      agent_type: conv.agent_type,
      updated_at: conv.updated_at,
      // Session-open contract (useOpenLinkedSession seeds this snapshot into the
      // client's sessions cache): the real session_id — never fabricated from the
      // document id — a liveness verdict matching taskMining's, and the triage
      // stamps so a stashed/dismissed session must not seed as an active row
      // (ct-42666).
      session_id: conv.session_id,
      is_active:
        conv.status === "active" &&
        conv.updated_at > Date.now() - 5 * 60 * 1000,
      started_at: (conv as any).started_at || conv._creationTime,
      ...inboxVisibilityFields(conv),
      is_own: isOwner,
      acting_user_id: conv.acting_user_id ?? null,
      is_anchor: !!conv.anchor_id,
      anchor_id: conv.anchor_id ?? null,
      author_name: acting
        ? acting.name
        : owner
          ? owner.name || owner.email?.split("@")[0] || "Unknown"
          : null,
      author_avatar: acting ? acting.avatar : owner ? owner.avatar_url : null,
      // Summary/context fields (already on the doc — no extra reads). The pill
      // card coalesces these into a one-line summary + last-message preview so
      // an expanded session reference shows what it's about, not just metadata.
      idle_summary: conv.idle_summary,
      subtitle: conv.subtitle,
      last_message_preview: conv.last_message_preview,
      last_message_role: conv.last_message_role,
      // Inbox-card parity for the chat object card: the row thumbnail and the
      // branch line come straight off the doc, no extra reads.
      image_preview_url: conv.image_preview_url ?? null,
      git_branch: conv.git_branch ?? null,
      git_commit_hash: conv.git_commit_hash ?? null,
      git_ahead: conv.git_ahead ?? null,
      git_behind: conv.git_behind ?? null,
      git_dirty: conv.git_dirty ?? null,
      // Who the session IS (session-characters.md S1): the same identity the
      // inbox card wears, so a reference pill in prose draws the character's
      // face and name instead of a generic session glyph.
      ...(await identityFieldsOf(conv, (id: any) => ctx.db.get(id))),
    };
  },
});

export const getConversationBySessionId = query({
  args: {
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    return conversation ? { _id: conversation._id } : null;
  },
});

// Single resolver for /conversation/[id] links.
// Accepts any string: Convex document _id, session_id, or UUID.
// Returns the access level and resolved Convex _id so the frontend
// doesn't need to guess which ID format was used.
// The lookup behind /conversation/<id>: accepts a full Convex id, a Claude
// session UUID, a tombstoned (restored) id, or a 7-char short id — the form
// entity pills fall back to before webGet resolves, and the form `cast link`
// mints. Exported for tests.
export async function resolveConversationForViewer(
  ctx: any,
  id: string,
  authUserId: Id<"users"> | null,
  presentedShareToken?: string | null,
): Promise<{
  access_level: "not_found" | "denied" | "owner" | "team" | "shared";
  conversation_id: string | null;
}> {
  let conversation = null;

  // Try as Convex document ID
  const convId = ctx.db.normalizeId("conversations", id);
  if (convId) {
    conversation = await ctx.db.get(convId);
  }

  // Try as session_id
  if (!conversation) {
    conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", id))
      .first();
  }

  // Tombstone forwarding: a kill/restart that restored a deleted
  // conversation stamped its replacement with the dead id — heal stale
  // links/cards by resolving to the replacement (newest if ever several).
  if (!conversation) {
    const restored = await ctx.db
      .query("conversations")
      .withIndex("by_restored_from", (q: any) =>
        q.eq("restored_from_conversation_id", id),
      )
      .collect();
    conversation = restored.reduce(
      (a: any, b: any) => ((b.updated_at ?? 0) > (a?.updated_at ?? 0) ? b : a),
      null,
    );
  }

  // Short id: ranked resolution (own > accessible > newest) because short ids
  // collide across users. The predicate mirrors the final access check so a
  // colliding inaccessible row can't shadow an accessible one; when nothing is
  // accessible the resolver still returns a candidate, so the caller reports
  // "denied" rather than "not_found".
  if (!conversation && !convId) {
    conversation = await resolveConversationRefRanked(
      ctx,
      id.toLowerCase(),
      authUserId ?? "",
      async (c) =>
        (await checkConversationAccess(
          ctx,
          authUserId,
          c,
          presentedShareToken,
        )) !== "denied",
    );
  }

  if (!conversation) {
    return { access_level: "not_found" as const, conversation_id: null };
  }

  const accessLevel = await checkConversationAccess(
    ctx,
    authUserId,
    conversation,
    presentedShareToken,
  );

  if (accessLevel === "denied") {
    return { access_level: "denied" as const, conversation_id: null };
  }

  return {
    access_level: accessLevel,
    conversation_id: conversation._id.toString(),
  };
}

export const resolveConversation = query({
  args: { id: v.string(), share_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    return resolveConversationForViewer(
      ctx,
      args.id,
      authUserId,
      args.share_token,
    );
  },
});

export const getSessionLinks = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { error: "Session not found" };
    }

    let shareToken = conversation.share_token;
    if (!shareToken) {
      shareToken = generateShareToken();
      await claimShareToken(
        ctx,
        "conversations",
        conversation,
        shareToken,
        authUserId,
        args.api_token,
      );
    }

    return {
      conversation_id: conversation._id,
      share_token: shareToken,
      title: conversation.title,
      slug: conversation.slug,
      started_at: conversation.started_at,
      // Can the session's team read it? The session trailer hook adds a
      // Codecast-Session link to commits only when it can (sessionTrailer.ts),
      // by the same rule commit ingest uses to trust that link.
      team_visible: await isConversationTeamVisible(ctx, conversation),
    };
  },
});

export const getConversationMeta = query({
  args: {
    conversation_id: v.id("conversations"),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    // OG-unfurl meta. The caller (bot-meta middleware) is unauthenticated, so
    // this resolves to "shared" only when the unfurled URL PRESENTED the share
    // token (?share=) — a bare conversation id reveals nothing, shared link or
    // not, because ids circulate far more freely than links (issue #27).
    // /share/<token> URLs unfurl via getSharedConversationMeta instead. An
    // authed viewer (owner/team) also passes. Mirrors that query's shape (no
    // project_path).
    const viewerId = await getAuthUserId(ctx);
    if (
      (await checkConversationAccess(
        ctx,
        viewerId,
        conversation,
        args.share_token,
      )) === "denied"
    ) {
      return null;
    }

    const user = await ctx.db.get(conversation.user_id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id),
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
    };
  },
});

export const getConversationMention = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    // Mention-pill enrichment leaks idle_summary/model/status/project_path.
    // Gate on real access — routing team_id is not a read grant.
    const viewerId = await getAuthUserId(ctx);
    if (
      (await checkConversationAccess(ctx, viewerId, conversation)) === "denied"
    ) {
      return null;
    }
    return {
      _id: conversation._id,
      title: conversation.title || "Session",
      message_count: conversation.message_count || 0,
      project_path: conversation.project_path || null,
      model: conversation.model || null,
      status: conversation.status || null,
      updated_at: conversation.updated_at || conversation._creationTime,
      idle_summary: conversation.idle_summary || null,
      agent_type: conversation.agent_type || null,
    };
  },
});

export const getConversationsBySessionIds = query({
  args: {
    api_token: v.string(),
    session_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) return { error: "Unauthorized" };

    const results: Array<{
      conversation_id: string;
      session_id: string;
      title: string;
      subtitle: string | null;
      message_count: number;
      updated_at: string;
      preview: string | null;
      agent_type: string | null;
      project_path: string | null;
    }> = [];

    for (const sessionId of args.session_ids.slice(0, 100)) {
      // An agent's session id first; a conversation id (a role's standing session, as the org template bind names it) resolves too.
      const conv =
        (await findConversationBySessionReference(
          ctx as any,
          sessionId,
          authUserId,
        )) ??
        (await findConversationByAnyRef(ctx as any, sessionId, authUserId));
      if (!conv) continue;

      let preview: string | null = null;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", conv._id),
        )
        .take(3);
      const firstUser = msgs.find((m) => m.role === "user" && m.content);
      if (firstUser) {
        preview =
          typeof firstUser.content === "string"
            ? firstUser.content.slice(0, 200)
            : null;
      }

      const title =
        conv.title || (preview ? preview.slice(0, 80) : "New Session");

      results.push({
        conversation_id: conv._id.toString(),
        session_id: sessionId,
        title,
        subtitle: conv.subtitle || null,
        message_count: conv.message_count ?? 0,
        updated_at: conv.updated_at
          ? new Date(conv.updated_at).toISOString()
          : new Date(conv._creationTime).toISOString(),
        preview,
        agent_type: conv.agent_type || null,
        project_path: conv.project_path || null,
      });
    }

    return { conversations: results };
  },
});
