import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { latestImagePreviewUrl } from "./lib/messageReads";
import { canOwnerOrTeamAccess, buildPathRestampUpdate } from "./privacy";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { touchDaemonLastSeen } from "./lib/daemonLiveness";
import {
  consumeStableContextSpool,
  getAuthenticatedUserId,
  setConvStableContext,
  storedTitle,
} from "./lib/conversationHelpers";

export const updateSlug = mutation({
  args: {
    conversation_id: v.id("conversations"),
    slug: v.string(),
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
      throw new Error("Unauthorized: can only update your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      slug: args.slug,
    });
  },
});

/** The daemon's word on whether a cloud agent session's agent is archived on the provider's site. */
export const setCloudAgentArchived = mutation({
  args: {
    conversation_id: v.id("conversations"),
    archived: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId)
      throw new Error("Authentication failed: invalid token or session");
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      throw new Error("Unauthorized: can only update your own conversations");
    }
    if ((conversation.cloud_agent_archived ?? false) === args.archived) return;
    // Explicit false, never a removed field: the web merges a row per key and
    // keeps a field the payload omits, so a cleared flag would read archived.
    await ctx.db.patch(args.conversation_id, {
      cloud_agent_archived: args.archived,
    });
  },
});

export const updateTitle = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    api_token: v.optional(v.string()),
    // A provider's own name for the session (a cloud agent's task title):
    // stored as custom so the auto-titlers leave it, and allowed to replace a
    // custom title only while that title is one of the provider's earlier
    // names (`replaces`), never one a person gave it.
    title_is_custom: v.optional(v.boolean()),
    replaces: v.optional(v.array(v.string())),
    // The local agent's own guess (Claude Code's ai-title): fills the title
    // only while no title pass has run (a pass always writes a subtitle), so it
    // replaces the opening-prompt placeholder and yields to a generated title.
    agent_guess: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    // Team WRITE access follows real visibility, not the routing team — a
    // member of a private session's routing team must not rename it.
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    const title = storedTitle(args.title) ?? args.title;
    const replaceable = args.agent_guess
      ? !conversation.title_is_custom && conversation.subtitle === undefined
      : !conversation.title_is_custom ||
        (!!conversation.title && !!args.replaces?.includes(conversation.title));
    const changed =
      replaceable &&
      (conversation.title !== title ||
        (!!args.title_is_custom && !conversation.title_is_custom));
    if (changed) {
      await ctx.db.patch(args.conversation_id, {
        title,
        ...(args.title_is_custom ? { title_is_custom: true } : {}),
      });
    }

    // A daemon re-announces every cloud agent's title after a restart, all at
    // once: a no-op among them must not write the account row, or they
    // contend on it and fail (OCC on users, 2026-09-30).
    if (args.api_token && (changed || args.replaces === undefined)) {
      await touchDaemonLastSeen(ctx, conversation.user_id);
    }
  },
});

export const setAvailableSkills = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    skills: v.string(),
    project_path: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) return;
    const user = await ctx.db.get(authUserId);
    if (!user) return;
    const key = args.project_path || "global";
    const skillsJson = JSON.stringify(JSON.parse(args.skills));
    const skillsRow = await ctx.db
      .query("user_skills")
      .withIndex("by_user_project", (q) =>
        q.eq("user_id", authUserId).eq("project_path", key),
      )
      .first();
    if (skillsRow) {
      if (skillsRow.skills_json !== skillsJson) {
        await ctx.db.patch(skillsRow._id, {
          skills_json: skillsJson,
          updated_at: Date.now(),
        });
      }
    } else {
      await ctx.db.insert("user_skills", {
        user_id: authUserId,
        project_path: key,
        skills_json: skillsJson,
        updated_at: Date.now(),
      });
    }
    if (user.available_skills !== undefined) {
      const legacy = await ctx.db
        .query("user_skills")
        .withIndex("by_user_project", (q) =>
          q.eq("user_id", authUserId).eq("project_path", undefined),
        )
        .first();
      if (!legacy)
        await ctx.db.insert("user_skills", {
          user_id: authUserId,
          skills_json: user.available_skills,
          updated_at: Date.now(),
        });
      await ctx.db.patch(authUserId, { available_skills: undefined });
    }
    // Deliberately NOT stamped on the conversation doc: nothing reads
    // conversations.available_skills (getConversationWithMeta strips it, the
    // web reads currentUser.available_skills), and at ~10KB per session it was
    // 60% of every inbox scan's bytes. conversation_id stays accepted so older
    // daemons keep working; the legacy field is shed by the doc diet sweep.
  },
});

export const updateProjectPath = mutation({
  args: {
    session_id: v.string(),
    project_path: v.string(),
    git_root: v.optional(v.string()),
    // The checkout's origin, stamped with the root so a session created
    // without git info (codex rollouts before 2026-09) gains its repository
    // identity in the same sweep. Older daemons omit it.
    git_remote_url: v.optional(v.string()),
    // The reporting machine. A session another machine runs (moved to a cloud
    // host, say) keeps that machine's path: the copy of its transcript left
    // behind here must not pull it back to this folder.
    device_id: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { updated: false };
    }
    if (
      args.device_id &&
      conversation.owner_device_id &&
      conversation.owner_device_id !== args.device_id
    ) {
      return { updated: false };
    }

    if (
      conversation.project_path === args.project_path &&
      (!args.git_root || conversation.git_root === args.git_root) &&
      (!args.git_remote_url ||
        conversation.git_remote_url === args.git_remote_url)
    ) {
      return { updated: false };
    }

    const patch: Record<string, any> = { project_path: args.project_path };
    if (args.git_root) {
      patch.git_root = args.git_root;
    }
    if (args.git_remote_url) {
      patch.git_remote_url = args.git_remote_url;
    }

    // The path is being stamped after creation (pre-warmed/stub conversations
    // are born pathless → private+teamless), so re-resolve team/privacy the
    // way creation would have. Explicit user choices win inside the helper.
    // Only a changed PATH re-resolves. Learning the checkout root of a path
    // the row already had (the boot sweep backfilling codex worktrees that
    // were created without git info) stamps identity and nothing else: a
    // mapping on that checkout then reaches these rows when the owner sets
    // or re-saves it, never as a side effect of a daemon upgrade.
    const restamp =
      conversation.project_path === args.project_path
        ? null
        : buildPathRestampUpdate(
            {
              ...conversation,
              git_remote_url:
                args.git_remote_url ?? conversation.git_remote_url,
            },
            await ctx.db
              .query("directory_team_mappings")
              .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
              .collect(),
            args.git_root || args.project_path,
          );
    if (restamp) Object.assign(patch, restamp);

    // A restamp can flip visibility (born-blank → team-shared), so linked
    // work items must follow; a plain path patch has nothing to propagate.
    if (restamp) await patchConversationVisibility(ctx, conversation, patch);
    else await ctx.db.patch(conversation._id, patch);

    return { updated: true, id: conversation._id };
  },
});

export const setSkipTitleGeneration = mutation({
  args: {
    conversation_id: v.id("conversations"),
    skip: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    // Team WRITE access follows real visibility, not the routing team — a
    // member of a private session's routing team must not rename it.
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    await ctx.db.patch(args.conversation_id, {
      skip_title_generation: args.skip,
    });

    if (args.api_token) await touchDaemonLastSeen(ctx, conversation.user_id);
  },
});

// Lazy backfill for conversations older than the image_preview_url
// denormalization: the web client calls this when it renders a conversation
// whose loaded messages contain images but whose row lacks the preview. The
// URL is recomputed SERVER-side from the conversation's own messages (bounded
// newest-first scan) — a client can trigger the backfill but never supply the
// value. Idempotent and write-once: a set preview short-circuits.
export const backfillImagePreview = mutation({
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
      throw new Error("Can only backfill your own conversations");
    }
    if (conversation.image_preview_url) return;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .order("desc")
      .take(300);
    for (const msg of recent) {
      const url = await latestImagePreviewUrl(ctx, [msg]);
      if (url) {
        await ctx.db.patch(args.conversation_id, { image_preview_url: url });
        return;
      }
    }
  },
});

export const setConversationIcon = mutation({
  args: {
    conversation_id: v.id("conversations"),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Unauthorized");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString())
      throw new Error("Can only update your own conversations");
    const patch: Record<string, any> = {};
    if (args.icon !== undefined) patch.icon = args.icon;
    if (args.icon_color !== undefined) patch.icon_color = args.icon_color;
    await ctx.db.patch(args.conversation_id, patch);
  },
});

/**
 * The daemon's heal for a session recorded before it marked interactive launches: it read the transcript head as
 * one a person runs at a terminal (cli parser detectCliFlags, codexLaunchFlags), so the session gains
 * `--interactive`, the mark lib/messageProvenance needs to read a terminal line as typed. Only on the caller's own
 * conversation, only that mark, and never on a session already marked either way: no other flag is added or removed.
 */
export const markInteractive = mutation({
  args: { api_token: v.string(), conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ marked: boolean }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || String(conversation.user_id) !== String(auth.userId))
      throw new Error("Only the session's own account marks it interactive");
    const flags = (conversation.cli_flags ?? "").split(/\s+/).filter(Boolean);
    if (flags.includes("--interactive") || flags.includes("--print"))
      return { marked: false };
    await ctx.db.patch(conversation._id, {
      cli_flags: [...flags, "--interactive"].join(" "),
    });
    return { marked: true };
  },
});

export const updateSessionId = mutation({
  args: {
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    // When the daemon links a real local session to a pre-created stub
    // (e.g. a web-started conversation), the stub's project_path/git_root were
    // a guess made before the session existed. Reconcile them to the actual
    // session cwd in the same patch so the displayed project can never diverge
    // from where the session is really running.
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    // The daemon found the session's cwd outside any git repo, so a git_root
    // the stub guessed from the chosen folder is cleared. Absent from older
    // daemons, which leave the stored value as it was.
    not_a_repo: v.optional(v.boolean()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) {
      throw new Error("Not found");
    }

    const patch: Record<string, any> = { session_id: args.session_id };
    if (args.project_path) patch.project_path = args.project_path;
    if (args.git_root) patch.git_root = args.git_root;
    if (args.git_remote_url) patch.git_remote_url = args.git_remote_url;
    if (args.not_a_repo && !args.git_root) {
      patch.git_root = undefined;
      if (!args.git_remote_url) patch.git_remote_url = undefined;
    }

    // Stubs are created before their real path exists, so their team/privacy
    // resolved against nothing (→ private, teamless). Re-resolve against the
    // reconciled path; explicit user choices win inside the helper.
    const stampedPath = args.git_root || args.project_path;
    if (stampedPath) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      const restamp = buildPathRestampUpdate(
        { ...conv, git_remote_url: args.git_remote_url ?? conv.git_remote_url },
        mappings,
        stampedPath,
      );
      if (restamp) Object.assign(patch, restamp);
    }

    // A restamp can flip visibility, so linked work items must follow.
    if (
      patch.is_private !== undefined ||
      patch.team_id !== undefined ||
      patch.auto_shared !== undefined ||
      patch.team_visibility !== undefined
    ) {
      await patchConversationVisibility(ctx, conv, patch);
    } else {
      await ctx.db.patch(args.conversation_id, patch);
    }
    // A stable-context record posted under the REAL agent session id before
    // this rebind (web-started sessions briefly carry the client stub id)
    // is waiting in the spool — attach it now.
    await consumeStableContextSpool(
      ctx,
      userId,
      args.session_id,
      args.conversation_id,
    );
    return { updated: true };
  },
});

/**
 * Record the stable-context feed injected into a session at start (called by
 * `cast stable-context` — the SessionStart hook — and the daemon's Codex
 * launch). `data` is a StableContextData JSON string, rendered by the web as
 * cards at the top of the conversation. Keyed by conversation_id when the
 * daemon exported it into the session env; else by agent session id, spooled
 * until the conversation registers (createConversation / updateSessionId).
 */
export const recordStableContext = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    session_id: v.optional(v.string()),
    data: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    // Sanity-cap: the record is a trimmed feed snapshot, never a transcript.
    if (args.data.length > 64_000) throw new Error("stable_context too large");

    if (args.conversation_id) {
      let conv = null;
      try {
        conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
      } catch {}
      if (conv && conv.user_id.toString() === userId.toString()) {
        await setConvStableContext(ctx, conv._id, args.data);
        return { recorded: "conversation" };
      }
    }

    if (args.session_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (conv) {
        await setConvStableContext(ctx, conv._id, args.data);
        return { recorded: "conversation" };
      }
      // No conversation yet (hook fired before the daemon registered the
      // transcript) — park it; the registration paths consume the spool.
      const existing = await ctx.db
        .query("stable_context_spool")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          data: args.data,
          created_at: Date.now(),
        });
      } else {
        await ctx.db.insert("stable_context_spool", {
          user_id: userId,
          session_id: args.session_id,
          data: args.data,
          created_at: Date.now(),
        });
      }
      return { recorded: "spool" };
    }

    return { recorded: "none" };
  },
});
