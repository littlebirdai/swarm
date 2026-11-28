import { sanitizeConvexObjectKeys } from "./lib/convexFieldNames";
import { query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { inboxVisibilityFields } from "./inboxProjection";
import {
  computeConversationTaskStats,
  isTodoStatTool,
} from "@codecast/sessions/taskStats";
import { checkConversationAccess } from "./privacy";
import { effectiveMembershipVisibility } from "./teamVisibility";
import { formatSlugAsTitle } from "./lib/conversationBasics";
import {
  computeOriginDivergentPreviews,
  findChildConversations,
  getAccessibleForkChildren,
  handedOffToId,
  handoffLinkDetails,
  resolveSpawnParentId,
} from "./lib/conversationChildHelpers";
import {
  attachSenderIdentities,
  conversationAuthorForAccess,
  conversationForAccess,
  getConvGitDiff,
  getConvStableContext,
  getConversationByRawId,
  summaryOnlyConversation,
} from "./lib/conversationHelpers";

export const getConversation = query({
  args: {
    conversation_id: v.string(),
    limit: v.optional(v.number()),
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
    const conversationId = conversation._id;
    const accessLevel = await checkConversationAccess(
      ctx,
      authUserId,
      conversation,
      args.share_token,
    );
    if (accessLevel === "denied") {
      const summary = await summaryOnlyConversation(
        ctx,
        authUserId,
        conversation,
      );
      return (
        summary && {
          ...summary,
          messages: [],
          has_more_above: false,
          oldest_timestamp: null,
          active_plan: null,
          active_task: null,
        }
      );
    }

    const limit = args.limit ?? 100;
    // Fetch most recent messages (descending), then reverse for display
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversationId),
      )
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;
    const sortedMessages = resultMessages.sort(
      (a, b) => a.timestamp - b.timestamp,
    );
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

    // active_plan / active_task are team-scoped work items. A share-token guest
    // (accessLevel "shared") must never receive them — only an owner or a
    // team-visible viewer.
    const hasFullAccess = accessLevel === "owner" || accessLevel === "team";
    let active_plan = null;
    if (hasFullAccess && conversation.active_plan_id) {
      const plan = await ctx.db.get(conversation.active_plan_id);
      if (plan)
        active_plan = {
          _id: plan._id,
          short_id: plan.short_id,
          title: plan.title,
          status: plan.status,
        };
    }

    let active_task = null;
    if (hasFullAccess && conversation.active_task_id) {
      const task = await ctx.db.get(conversation.active_task_id);
      if (task)
        active_task = {
          _id: task._id,
          short_id: task.short_id,
          title: task.title,
          status: task.status,
        };
    }

    return sanitizeConvexObjectKeys({
      ...conversationForAccess(conversation, accessLevel),
      title,
      messages: sortedMessages,
      user: conversationAuthorForAccess(user, accessLevel),
      has_more_above: hasMore,
      oldest_timestamp: oldestTimestamp,
      active_plan,
      active_task,
    });
  },
});

export const getConversationWithMeta = query({
  args: {
    conversation_id: v.string(),
    share_token: v.optional(v.string()),
    // Opt-in: omit the churny per-flush fields from the returned doc. The
    // client merge (syncRecord) keeps its prior values for omitted keys, and
    // reads the live values from getTranscriptWatermark / the liveness overlay
    // instead. Without this, every message flush re-pushed the whole fork
    // graph + child map because updated_at/message_count changed.
    strip_volatile: v.optional(v.boolean()),
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

    const access = await checkConversationAccess(
      ctx,
      authUserId,
      conversation,
      args.share_token,
    );
    if (access === "denied") {
      return await summaryOnlyConversation(ctx, authUserId, conversation);
    }
    const isOwner = access === "owner";

    const user = await ctx.db.get(conversation.user_id);

    const title =
      conversation.title ||
      (conversation.slug ? formatSlugAsTitle(conversation.slug) : null) ||
      "New Session";

    const {
      children: childConversations,
      map: childByParentUuid,
      agentNameEntries,
    } = await findChildConversations(ctx, conversation._id, []);

    let forkedFromDetails = null;
    if (conversation.forked_from) {
      const originalConv = await ctx.db.get(conversation.forked_from);
      if (originalConv) {
        const originalUser = await ctx.db.get(originalConv.user_id);
        // The parent's share link is the parent owner's grant: hand it only to
        // a viewer who can already open the parent, so a fork never spreads it
        // further and rotating it still revokes past holders.
        const parentAccess = originalConv.share_token
          ? await checkConversationAccess(ctx, authUserId, originalConv)
          : "denied";
        forkedFromDetails = {
          conversation_id: originalConv._id,
          title: originalConv.title,
          share_token:
            parentAccess === "denied" ? undefined : originalConv.share_token,
          username:
            originalUser?.name ||
            originalUser?.email?.split("@")[0] ||
            "Unknown",
          // Triage state for the client-side parent preload (same contract as
          // mapForkDetails): a stashed/dismissed parent must seed as such, not
          // as an active row that flashes into the inbox at boot.
          ...inboxVisibilityFields(originalConv),
        };
      }
    }

    const parentConversationId = await resolveSpawnParentId(ctx, conversation);

    const getDocOnce = (id: any) => ctx.db.get(id);
    const handedOffFromDetails = await handoffLinkDetails(
      getDocOnce,
      conversation.handed_off_from_conversation_id,
    );
    const handedOffToDetails = await handoffLinkDetails(
      getDocOnce,
      await handedOffToId(ctx, conversation),
    );

    const forkChildrenDetails = await getAccessibleForkChildren(
      ctx,
      authUserId,
      conversation._id,
    );

    let forkSiblings: typeof forkChildrenDetails = [];
    if (conversation.forked_from) {
      forkSiblings = await getAccessibleForkChildren(
        ctx,
        authUserId,
        conversation.forked_from,
      );
    }

    const mainDivergentPreviewsByFork = await computeOriginDivergentPreviews(
      ctx,
      conversation,
      forkChildrenDetails,
      forkSiblings,
    );

    let effective_team_visibility = conversation.team_visibility;
    if (!effective_team_visibility && conversation.team_id && isOwner) {
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) =>
          q
            .eq("user_id", conversation.user_id)
            .eq("team_id", conversation.team_id!),
        )
        .first();
      effective_team_visibility = effectiveMembershipVisibility(
        membership,
        conversation.started_at,
      ) as any;
    }

    let active_plan = null;
    if (conversation.active_plan_id) {
      const plan = await ctx.db.get(conversation.active_plan_id);
      if (plan)
        active_plan = {
          _id: plan._id,
          short_id: plan.short_id,
          title: plan.title,
          status: plan.status,
        };
    }

    let active_task = null;
    if (conversation.active_task_id) {
      const task = await ctx.db.get(conversation.active_task_id);
      if (task)
        active_task = {
          _id: task._id,
          short_id: task.short_id,
          title: task.title,
          status: task.status,
        };
    }

    // Strip the large on-demand field (available_skills). git_diff /
    // git_diff_staged now live in conversation_git_diffs, not on the doc.
    const { available_skills: _convSkills, ...conversationLight } =
      conversationForAccess(conversation, access);
    if (args.strip_volatile) {
      // oxfmt-ignore
      for (const k of ["updated_at", "message_count", "last_message_at", "last_metrics_at", "last_active_at", "last_heartbeat"]) {
        delete (conversationLight as any)[k];
      }
    }

    // stable_context lives in the conversation_context side row (legacy rows
    // still carry it on the doc until swept). Owner/team only — the same rule
    // conversationForAccess applies to the legacy field.
    const sideStableContext =
      access === "owner" || access === "team"
        ? await getConvStableContext(ctx, conversation._id)
        : null;

    return sanitizeConvexObjectKeys({
      ...conversationLight,
      stable_context:
        (conversationLight as any).stable_context ??
        sideStableContext ??
        undefined,
      // Explicit null, never an absent key: the client merges rows, so a link
      // turned off on another device would otherwise stay "on" in an open tab.
      share_token: (conversationLight as any).share_token ?? null,
      guest_suggestions: (conversationLight as any).guest_suggestions ?? null,
      // The same for the header's git line: a field can be unset (a cloud
      // agent's branch its provider no longer names, a local stamp cleared).
      git_branch: (conversationLight as any).git_branch ?? null,
      git_commit_hash: (conversationLight as any).git_commit_hash ?? null,
      git_ahead: (conversationLight as any).git_ahead ?? null,
      git_behind: (conversationLight as any).git_behind ?? null,
      git_dirty: (conversationLight as any).git_dirty ?? null,
      peer_transfer: isOwner
        ? ((conversationLight as any).peer_transfer ?? null)
        : null,
      is_own: !!isOwner,
      // A share-link viewer reads but may not fork or steer: forkFromMessage
      // admits owners and team members only, so the web hides those actions.
      access_level: access,
      title,
      effective_team_visibility,
      user: conversationAuthorForAccess(user, access),
      child_conversations: childConversations,
      child_by_parent_uuid_entries: Object.entries(childByParentUuid),
      agent_name_entries: agentNameEntries,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
      forked_from_details: forkedFromDetails,
      fork_children: forkChildrenDetails,
      fork_siblings: forkSiblings.length > 0 ? forkSiblings : undefined,
      parent_conversation_id: parentConversationId,
      handed_off_from_details: handedOffFromDetails,
      handed_off_to_details: handedOffToDetails,
      main_divergent_previews_by_fork: mainDivergentPreviewsByFork,
      active_plan,
      active_task,
    });
  },
});

export const getConversationGitDiff = query({
  args: {
    conversation_id: v.id("conversations"),
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
    )
      return null;

    return await getConvGitDiff(ctx, args.conversation_id);
  },
});

// Hard cap on assistant rows this query may read. Assistant documents carry
// full tool_calls (Write/Edit payloads), so a 1000-row newest-first walk
// blows Convex's system-operation budget ("too many system operations") on
// long live sessions — and this query used to stay subscribed for the whole
// visit, re-running on every stream tick. Newest TodoWrite is almost always
// in the first few rows; TaskCreate past this window drops off. Removing the
// cap or raising it back toward four digits re-introduces the timeout.
export const TOOL_STATS_SCAN_LIMIT = 32;

export async function collectConversationToolStats(
  db: { query: (table: "messages") => any },
  conversationId: Id<"conversations">,
) {
  const rows: Array<{
    role?: string;
    timestamp?: number;
    tool_calls?: Array<{ name: string; input: string }> | null;
  }> = [];
  let scanned = 0;
  for await (const msg of db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).eq("role", "assistant"),
    )
    .order("desc")) {
    if (++scanned > TOOL_STATS_SCAN_LIMIT) break;
    rows.push(msg);
    // Newest-first: the first TodoWrite is the panel. Stop so a session of
    // huge Write rows behind it is never read.
    if (msg.tool_calls?.some((tc: { name: string }) => isTodoStatTool(tc.name)))
      break;
  }
  return { taskStats: computeConversationTaskStats(rows) };
}

export const getConversationToolStats = query({
  args: {
    conversation_id: v.id("conversations"),
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
    )
      return null;

    return collectConversationToolStats(ctx.db, args.conversation_id);
  },
});

// The live transcript subscription. The paginated listMessages page is anchored
// at the NEWEST end of the index, so subscribing to it re-ships the whole grown
// first page (200+ full bodies) on every streaming patch. This query covers only
// the range that actually changes — rows strictly after a fixed anchor — so a
// streaming tick re-ships the tail (typically 1-30 rows), not the page. The
// client one-shots listMessages for history and subscribes to this for updates.
//
// Two deliberate choices:
// - Access goes through checkConversationAccess WITH share_token (unlike
//   getNewMessages), so share-link viewers keep live updates.
// - The result carries NO volatile conversation fields (no updated_at/title).
//   The conversation row is unavoidably in the read set (access check), so the
//   query re-RUNS on churny conversation patches — a cheap bounded index walk —
//   but the result stays byte-identical and Convex skips the push.
export const listMessagesTail = query({
  args: {
    conversation_id: v.string(),
    after_timestamp: v.number(),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await getConversationByRawId(
      ctx,
      args.conversation_id,
    );
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

    const TAIL_LIMIT = 500;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q
          .eq("conversation_id", conversation._id)
          .gt("timestamp", args.after_timestamp),
      )
      .order("asc")
      .take(TAIL_LIMIT + 1);
    const hasMore = messages.length > TAIL_LIMIT;
    if (hasMore) messages.length = TAIL_LIMIT;

    return sanitizeConvexObjectKeys({
      messages: await attachSenderIdentities(
        ctx,
        conversation.user_id,
        messages,
      ),
      last_timestamp:
        messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more: hasMore,
    });
  },
});

// The transcript's tiny change watermark. The client pairs this with
// listMessagesTail: message_count moves on insert/delete (the recovery poll
// compares it against local length), transcript_revision moves when a row
// OUTSIDE the live tail is edited (resync backfill after resume/fork) — the
// client answers a jump with a snapshot refetch. Result is a few integers, so
// churny conversation patches re-run it cheaply and re-push only when one of
// these actually moves.
export const getTranscriptWatermark = query({
  args: {
    conversation_id: v.string(),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await getConversationByRawId(
      ctx,
      args.conversation_id,
    );
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
    return {
      message_count: conversation.message_count ?? 0,
      transcript_revision: conversation.transcript_revision ?? 0,
    };
  },
});
