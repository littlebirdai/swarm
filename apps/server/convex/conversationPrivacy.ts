import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { patchConversationLifecycle } from "./lib/sessionStatusWriter";
import { Id } from "./_generated/dataModel";
import { isConversationOwner, buildShareUpdate } from "./privacy";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { isStaff } from "./lib/staff";
import { advanceCommentsAccessRevision } from "./commentViewWrites";
import { touchDaemonLastSeen } from "./lib/daemonLiveness";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";

export const setPrivacy = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    is_private: v.boolean(),
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
      throw new Error(
        "Unauthorized: can only change privacy of your own conversations",
      );
    }

    // Sharing must guarantee a team_id (buildShareUpdate); locking forces the
    // private visibility marker. Never let is_private:false and team_id diverge.
    const updates = args.is_private
      ? { is_private: true as const, team_visibility: "private" as const }
      : await buildShareUpdate(ctx, conversation, authUserId);

    // Patches the conversation AND rewrites linked work items' stored access
    // key (tasks/plans/docs follow the session's visibility).
    await patchConversationVisibility(ctx, conversation, updates);
    // Access inputs changed without a comment write: move the comment view
    // head so viewers who regain access can re-materialize (matrix SRV-02).
    await advanceCommentsAccessRevision(ctx, conversation);
  },
});

export const setTeamVisibility = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    team_visibility: v.union(v.literal("summary"), v.literal("full"), v.null()),
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
      throw new Error(
        "Unauthorized: can only change visibility of your own conversations",
      );
    }

    // Setting any team visibility shares the conversation, so guarantee a
    // team_id alongside it (else it's shared-with-nobody).
    const updates = await buildShareUpdate(ctx, conversation, authUserId);
    await patchConversationVisibility(ctx, conversation, {
      ...updates,
      team_visibility: args.team_visibility ?? undefined,
    });
    await advanceCommentsAccessRevision(ctx, conversation);
  },
});

export const setPrivacyBySessionId = mutation({
  args: {
    session_id: v.string(),
    is_private: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      throw new Error(
        `Conversation not found with session_id: ${args.session_id}`,
      );
    }

    // Same contract as setPrivacy: sharing must guarantee a team_id
    // (buildShareUpdate), locking forces the private visibility marker. A raw
    // is_private flip here was the one share path that skipped buildShareUpdate
    // and could mint a "shared with nobody" row (non-private, teamless).
    const updates = args.is_private
      ? { is_private: true as const, team_visibility: "private" as const }
      : await buildShareUpdate(ctx, conversation, authUserId);
    await patchConversationVisibility(ctx, conversation, updates);
    await advanceCommentsAccessRevision(ctx, conversation);

    if (args.api_token) await touchDaemonLastSeen(ctx, authUserId);
  },
});

export const makeAllPrivate = mutation({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.neq(q.field("is_private"), true))
      .collect();

    let updated = 0;
    for (const conv of conversations) {
      await patchConversationVisibility(ctx, conv, { is_private: true });
      updated++;
    }

    return { updated, total: conversations.length };
  },
});

export const backfillShortIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;
    // Use cursor-based pagination to avoid full table scan
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (!conv.short_id) {
        await ctx.db.patch(conv._id, {
          short_id: conv._id.toString().slice(0, 7),
        });
        updated++;
      }
    }

    return {
      updated,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

// A conversation's team_id is also the input to the stored workspace ACCESS key
// of every task, doc and plan linked to it, so both backfills below stamp it
// through patchConversationVisibility. That propagation reads the owner's work
// items once per conversation, so a batch that rewrites many conversations can
// exceed a transaction's read limit — each call stops after this many rewrites
// and asks to be re-run. A re-run is free: a stamped row now carries team_id
// and is skipped (ct-49655).
const RESCOPE_BATCH = 10;

export const backfillTeamIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;

    // Get all users with team_id or active_team_id to build a lookup map
    const allUsers = await ctx.db.query("users").collect();

    const userTeamMap = new Map<string, Id<"teams">>();
    for (const user of allUsers) {
      const teamId = (user as any).active_team_id || user.team_id;
      if (teamId) {
        userTeamMap.set(user._id.toString(), teamId);
      }
    }

    // Paginate through conversations missing team_id
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    let rescoped = 0;
    for (const conv of result.page) {
      if (conv.team_id) continue;
      const userTeamId = userTeamMap.get(conv.user_id.toString());
      if (userTeamId) {
        // Why: stamping team_id also decides the stored workspace ACCESS key of
        // every task, doc and plan linked to this conversation. A raw
        // ctx.db.patch leaves them on the old key, so a now team-visible session
        // keeps work items nobody on the team can read (ct-49655).
        rescoped += await patchConversationVisibility(ctx, conv, {
          team_id: userTeamId,
        });
        updated++;
        if (updated >= RESCOPE_BATCH) break;
      }
    }

    // Capped mid-page: hand back the SAME cursor so the re-run finishes the page.
    const capped = updated >= RESCOPE_BATCH;
    return {
      updated,
      rescoped,
      cursor: capped ? (args.cursor ?? null) : result.continueCursor,
      isDone: capped ? false : result.isDone,
    };
  },
});

export const backfillUserTeamIds = internalMutation({
  args: { userId: v.string(), teamId: v.string() },
  handler: async (ctx, args) => {
    const userId = args.userId as any;
    const teamId = args.teamId as any;
    let updated = 0;
    let alreadyHad = 0;
    let rescoped = 0;
    let cursor: string | null = null;
    do {
      const result = await ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) => q.eq("user_id", userId))
        .paginate({ cursor: cursor ?? null, numItems: 100 });
      for (const conv of result.page) {
        if (conv.team_id) {
          alreadyHad++;
          continue;
        }
        // Why: same as backfillTeamIds — the chokepoint patches the row and
        // rewrites the workspace key of every linked work item (ct-49655).
        rescoped += await patchConversationVisibility(
          ctx,
          conv,
          { team_id: teamId },
          userId,
        );
        updated++;
        if (updated >= RESCOPE_BATCH) break;
      }
      cursor = result.continueCursor;
      if (result.isDone || updated >= RESCOPE_BATCH) break;
    } while (true);
    return { updated, alreadyHad, rescoped, isDone: updated < RESCOPE_BATCH };
  },
});

// Debug function to investigate why a conversation isn't showing in team feed
export const debugConversationVisibility = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not authenticated" };

    const user = await ctx.db.get(userId);
    if (!user) return { error: "User not found" };

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return { error: "Conversation not found" };
    // A debugging read of someone's sharing setup (owner email, paths,
    // mappings): the conversation's own owner, or staff. Anyone else gets the
    // same answer as for an id that does not exist.
    if (
      !isStaff(user) &&
      !(await isConversationOwner(ctx, userId, conversation))
    ) {
      return { error: "Conversation not found" };
    }

    const convOwner = await ctx.db.get(conversation.user_id);

    // Get the team this conversation belongs to
    const convTeam = conversation.team_id
      ? await ctx.db.get(conversation.team_id)
      : null;

    // Get the user's active team
    const userTeamId = user.team_id;
    const userTeam = userTeamId ? await ctx.db.get(userTeamId) : null;

    // Check team membership for conversation owner
    const ownerTeamMembership =
      convOwner && userTeamId
        ? await ctx.db
            .query("team_memberships")
            .withIndex("by_user_team", (q) =>
              q.eq("user_id", conversation.user_id).eq("team_id", userTeamId),
            )
            .first()
        : null;

    // Check directory mappings for the owner
    const ownerMappings = userTeamId
      ? await ctx.db
          .query("directory_team_mappings")
          .withIndex("by_user_team", (q) =>
            q.eq("user_id", conversation.user_id).eq("team_id", userTeamId),
          )
          .collect()
      : [];

    const projectPath = conversation.git_root || conversation.project_path;
    const isProjectMapped = ownerMappings.some(
      (m) =>
        projectPath &&
        (projectPath === m.path_prefix ||
          projectPath.startsWith(m.path_prefix + "/")),
    );

    return {
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        team_id: conversation.team_id,
        user_id: conversation.user_id,
        is_private: conversation.is_private,
        project_path: conversation.project_path,
        git_root: conversation.git_root,
      },
      convOwner: convOwner
        ? {
            _id: convOwner._id,
            name: convOwner.name,
            email: convOwner.email,
            team_id: convOwner.team_id,
          }
        : null,
      convTeam: convTeam ? { _id: convTeam._id, name: convTeam.name } : null,
      currentUser: {
        _id: user._id,
        team_id: user.team_id,
      },
      userTeam: userTeam ? { _id: userTeam._id, name: userTeam.name } : null,
      checks: {
        teamsMatch:
          conversation.team_id?.toString() === user.team_id?.toString(),
        ownerInTeam: !!ownerTeamMembership,
        ownerVisibility: ownerTeamMembership?.visibility || "no membership",
        ownerHasMappings: ownerMappings.length > 0,
        projectPath,
        isProjectMapped,
        wouldShowWithPermissiveDefault:
          ownerMappings.length === 0 || isProjectMapped,
      },
    };
  },
});

// Repairs conversations whose updated_at was wrongly bumped to Date.now() by
// addMessages during a sync_mode=all historical backfill (months-old JSONLs
// re-uploaded with current timestamps, polluting the inbox active panel).
//
// For each conversation owned by the caller, looks up the actual latest
// message timestamp. If updated_at is more than 1 hour ahead of that real
// timestamp, rewinds it to the real timestamp. Additionally, if the real
// last message is older than 7 days and the session isn't already dismissed,
// sets inbox_dismissed_at=now so historical sessions stop appearing in the
// active panel.
//
// Paginated by user — caller passes cursor until isDone=true.
export const healHistoricalUpdatedAt = mutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    dismiss_older_than_days: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Authentication required");

    const batchSize = args.limit ?? 100;
    const dismissCutoffMs =
      (args.dismiss_older_than_days ?? 7) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let rewound = 0;
    let dismissed = 0;
    for (const conv of result.page) {
      const lastMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", conv._id),
        )
        .order("desc")
        .first();

      const realLastTs = lastMsg?.timestamp ?? conv.started_at;
      const patch: Record<string, unknown> = {};

      if (conv.updated_at > realLastTs + 60 * 60 * 1000) {
        patch.updated_at = realLastTs;
        rewound++;
      }

      if (!conv.inbox_dismissed_at && now - realLastTs > dismissCutoffMs) {
        patch.inbox_dismissed_at = now;
        dismissed++;
      }

      if (Object.keys(patch).length > 0) {
        await patchConversationLifecycle(ctx, conv._id, patch);
      }
    }

    return {
      rewound,
      dismissed,
      scanned: result.page.length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
