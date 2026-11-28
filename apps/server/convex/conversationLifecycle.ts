import { enqueueFreshLocalSession } from "./lib/fenced-session-launch.state";
import { fencedMoveRefusal } from "./lib/fenced-device-move.rules";
import { isClaudeSubagentSessionId } from "./lib/claudeSubagentSession";
import { mutation, query, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { parkOnCloudHost, resolveCloudDevice } from "./cloudPlacement";
import {
  cloudStartFromArg,
  effectiveStartFrom,
  cloudWorkspaceValidator,
  findSharedCheckoutOccupant,
} from "./cloudPlacement";
import {
  checkoutInUseMessage,
  posixRepoBasename,
} from "@codecast/cloud-hosts/cloudWorkspace";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  insertConversationWithStatus,
  patchConversationLifecycle,
} from "./lib/sessionStatusWriter";
import { HISTORY_IMPORT_INBOX_MS } from "@codecast/inbox/inboxProjection";
import { Doc, Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { internal } from "./_generated/api";
import { stampRunConversation } from "./lib/agentTaskRows";
import { fromConvexAgentType } from "@codecast/agent-clients/agentClients";
import { isSessionOwner } from "./sessionOwners";
import {
  isConversationTeamVisible,
  resolveCreationPrivacy,
  inheritedChildPrivacy,
  isConversationOwner,
  matchDirectoryMapping,
} from "./privacy";
import { canAccessConversation } from "./lib/access";
import { isDeletedSession } from "./lib/deletedSessions";
import { conversationMovedAwayFrom } from "./lib/movedSessions";
import { touchDaemonLastSeen } from "./lib/daemonLiveness";
import { formatSlugAsTitle } from "./lib/conversationBasics";
import { daemonForkFields } from "./lib/conversationChildHelpers";
import {
  consumeStableContextSpool,
  getAuthenticatedUserId,
  ownedParentConversationId,
  setConvGitDiff,
  storedTitle,
} from "./lib/conversationHelpers";
import { recordFork } from "./lib/forkHelpers";

export const resolveTeamFromDirectory = query({
  args: {
    api_token: v.string(),
    project_path: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return null;
    }

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();

    // The same rule creation uses: longest path rule wins, and a lock is a
    // rule with no team.
    return matchDirectoryMapping(mappings, args.project_path)?.team_id ?? null;
  },
});

export const createConversation = mutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok"),
      v.literal("muse"),
      v.literal("antigravity"),
    ),
    session_id: v.string(),
    project_hash: v.optional(v.string()),
    project_path: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    // The title is the agent's own name for the session (a cloud agent's task
    // title), not a guess from its first message: the auto-titlers keep it.
    title_is_custom: v.optional(v.boolean()),
    started_at: v.optional(v.number()),
    parent_message_uuid: v.optional(v.string()),
    parent_conversation_id: v.optional(v.string()),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    git_status: v.optional(v.string()),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    git_root: v.optional(v.string()),
    cli_flags: v.optional(v.string()),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    worktree_path: v.optional(v.string()),
    worktree_status: v.optional(
      v.union(v.literal("active"), v.literal("merged"), v.literal("archived")),
    ),
    subagent_description: v.optional(v.string()),
    // Daemon-asserted subagent flag (transcript lives under a subagents/ dir).
    // The parent LINK may resolve much later (parent not yet in the daemon's
    // cache), so without this the row is born looking like a normal session
    // and teammates get a "started coding" push for it.
    is_subagent: v.optional(v.boolean()),
    // The trigger this transcript is a spawned run of (the daemon's scheduler
    // started it), so the row is born nested (stampRunConversation) instead
    // of being a loose inbox card until the run is linked.
    agent_task_id: v.optional(v.id("agent_tasks")),
    agent_team_name: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    // Device id of the daemon syncing this transcript. The transcript (and any
    // tmux session) lives on that machine, so it is the only daemon that can
    // deliver messages here. Without this stamp, ownership was only set lazily
    // when a daemon claimed the conversation's FIRST pending message — a
    // broadcast race every one of the user's daemons entered, and a remote
    // daemon (no transcript, no pane) sometimes won, silently black-holing
    // delivery. Optional for older CLIs; claim-time stamping remains the
    // fallback for conversations created without it.
    owner_device_id: v.optional(v.string()),
    // A fork whose shared history the daemon syncs itself, from the
    // transcript it creates the row for (a cloud agent's branch: a Codex
    // Cloud task's other attempt). `from` is the conversation it forks,
    // `at_uuid` the message it forks at (the branch chips sit there),
    // `copied` how many of its messages are that shared history and `cutoff`
    // the fork point's time, so the chips count and label its own part.
    fork: v.optional(
      v.object({
        from: v.id("conversations"),
        at_uuid: v.string(),
        copied: v.number(),
        cutoff: v.optional(v.number()),
      }),
    ),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Stored as a person reads it: an older CLI titled a session from the raw
    // opening message, paste markers (`<pasted_content id=…>`) and all.
    const title = storedTitle(args.title);
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (authUserId.toString() !== args.user_id.toString()) {
      throw new Error(
        "Unauthorized: can only create conversations for yourself",
      );
    }

    await checkRateLimit(ctx, args.user_id, "createConversation");
    if (await isDeletedSession(ctx, args.user_id, args.session_id)) {
      throw new Error("Session deleted by its owner");
    }
    const forkOrigin = args.fork ? await ctx.db.get(args.fork.from) : null;
    if (args.fork && forkOrigin?.user_id !== args.user_id) {
      throw new Error("Unauthorized: can only fork your own conversations");
    }
    // A named parent is honoured only when the caller owns it. The id is a
    // caller-typed string: unchecked, it nested this row under anyone's
    // conversation, inherited that conversation's sharing, and (as a plan
    // handoff) dismissed and completed it. A parent that is not the caller's
    // is dropped and the transcript still syncs, unlinked.
    const explicitParentId = await ownedParentConversationId(
      ctx,
      args.user_id,
      args.parent_conversation_id,
    );

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), args.user_id))
      .first();

    if (!existing) {
      const movedTo = await conversationMovedAwayFrom(
        ctx,
        args.user_id.toString(),
        args.session_id,
        (c) => isSessionOwner(ctx, c._id, args.user_id),
      );
      if (movedTo) {
        const shortId = movedTo.short_id ?? movedTo._id.toString().slice(0, 7);
        throw new Error(
          `Session moved to another account as ${shortId}; run \`cast pull ${shortId}\` to bring it back here`,
        );
      }
    }

    if (existing) {
      const patch: Record<string, any> = {};
      if (explicitParentId) {
        if (!existing.parent_conversation_id) {
          patch.parent_conversation_id = explicitParentId;
        }
        if (args.parent_message_uuid && !existing.parent_message_uuid) {
          patch.parent_message_uuid = args.parent_message_uuid;
          patch.is_subagent = undefined;
        } else if (
          !existing.parent_conversation_id &&
          !args.parent_message_uuid
        ) {
          patch.is_subagent = true;
        }
        if (args.subagent_description && !existing.subagent_description) {
          patch.subagent_description = args.subagent_description;
        }
      }
      if (
        args.is_subagent &&
        !("is_subagent" in patch) &&
        !existing.is_subagent &&
        !existing.parent_message_uuid &&
        !args.parent_message_uuid
      ) {
        patch.is_subagent = true;
      }
      if (args.agent_team_name && !existing.agent_team_name) {
        patch.agent_team_name = args.agent_team_name;
        if (args.agent_name && !existing.agent_name)
          patch.agent_name = args.agent_name;
      }
      // Adopt an unowned conversation; never steal one another device owns
      // (explicit ownership transfers go through sessionOwnership).
      if (
        args.owner_device_id &&
        !existing.owner_device_id &&
        !fencedMoveRefusal(existing)
      ) {
        patch.owner_device_id = args.owner_device_id;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
      // A run whose row a hook registered before its transcript synced is
      // still a trigger run: stamp it so it nests like one born here.
      if (args.agent_task_id && !existing.agent_task_id) {
        const task = await ctx.db.get(args.agent_task_id);
        if (task && task.user_id === args.user_id)
          await stampRunConversation(ctx, args.user_id, task, args.session_id);
      }
      return existing._id;
    }

    const now = Date.now();
    const startedAt = args.started_at ?? now;

    const conversationPath = args.git_root || args.project_path;
    // The daemon syncs old transcripts with their real start time: a session
    // that predates a repo's share start stays private (privacy.ts
    // mappingCoversStart), so a share made today never exposes yesterday.
    let parentConversationId: Id<"conversations"> | undefined;
    if (explicitParentId) {
      parentConversationId = explicitParentId;
    } else if (args.parent_message_uuid && !args.parent_conversation_id) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) =>
          q.eq("message_uuid", args.parent_message_uuid!),
        )
        .first();
      // A message uuid is the caller's claim too: link only to a conversation
      // the caller can open.
      const uuidParent = parentMsg
        ? await ctx.db.get(parentMsg.conversation_id)
        : null;
      if (
        uuidParent &&
        (await canAccessConversation(ctx, args.user_id, uuidParent))
      ) {
        parentConversationId = uuidParent._id;
      }
    }

    // A subagent shares as its parent does; a fork (parent_message_uuid) and a
    // top-level session resolve from their own path.
    const subagentParent =
      parentConversationId && !args.parent_message_uuid
        ? await ctx.db.get(parentConversationId)
        : null;
    const {
      team_id: resolvedTeamId,
      is_private: isPrivate,
      auto_shared: autoShared,
      team_visibility: inheritedTeamVisibility,
    } = inheritedChildPrivacy(subagentParent, args.user_id) ??
    (await resolveCreationPrivacy(
      ctx,
      args.user_id,
      conversationPath,
      args.team_id as Id<"teams"> | undefined,
      startedAt,
      args.git_remote_url,
    ));

    const conversationId = await insertConversationWithStatus(ctx, {
      user_id: args.user_id,
      team_id: resolvedTeamId,
      agent_type: args.agent_type,
      session_id: args.session_id,
      slug: args.slug,
      title,
      ...(title && args.title_is_custom ? { title_is_custom: true } : {}),
      project_hash: args.project_hash,
      project_path: args.project_path,
      owner_device_id: args.owner_device_id,
      started_at: startedAt,
      updated_at: startedAt,
      ...(startedAt < now - HISTORY_IMPORT_INBOX_MS
        ? { history_import: true }
        : {}),
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      ...(inheritedTeamVisibility
        ? { team_visibility: inheritedTeamVisibility }
        : {}),
      status: "active",
      parent_message_uuid: args.parent_message_uuid ?? args.fork?.at_uuid,
      parent_conversation_id: parentConversationId,
      ...(args.fork && forkOrigin
        ? daemonForkFields(forkOrigin, args.fork, now)
        : {}),
      is_subagent:
        (args.is_subagent === true && !args.parent_message_uuid) ||
        (!!parentConversationId && !args.parent_message_uuid) ||
        (args.agent_type === "claude_code" &&
          !args.parent_message_uuid &&
          isClaudeSubagentSessionId(args.session_id)) ||
        undefined,
      agent_team_name: args.agent_team_name,
      agent_name: args.agent_name,
      git_commit_hash: args.git_commit_hash,
      git_branch: args.git_branch,
      git_remote_url: args.git_remote_url,
      git_root: args.git_root,
      cli_flags: args.cli_flags,
      worktree_name: args.worktree_name,
      worktree_branch: args.worktree_branch,
      worktree_path: args.worktree_path,
      worktree_status: args.worktree_status,
      subagent_description: args.subagent_description,
    });
    // Set short_id for O(1) lookup by truncated ID
    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });
    if (forkOrigin)
      await recordFork(ctx, args.user_id, forkOrigin, conversationId);
    // Funnel: the user's first synced session ever. Stamped on the users doc so
    // this stays an O(1) check instead of a conversations scan per create.
    const creator = await ctx.db.get(args.user_id);
    if (creator && !(creator as any).first_session_synced_at) {
      await ctx.db.patch(args.user_id, { first_session_synced_at: now } as any);
      await ctx.scheduler.runAfter(0, internal.analytics.capture, {
        event: "first_session_synced",
        distinctId: args.user_id.toString(),
        properties: { agent_type: args.agent_type },
      });
    }
    // git_diff blobs and git_status live off the hot doc in conversation_git_diffs.
    await setConvGitDiff(
      ctx,
      conversationId,
      args.git_diff,
      args.git_diff_staged,
      args.git_status,
    );
    // Terminal-started sessions: the SessionStart hook usually reports the
    // injected stable context before this registration — attach the parked record.
    await consumeStableContextSpool(
      ctx,
      args.user_id,
      args.session_id,
      conversationId,
    );
    if (args.agent_task_id) {
      const task = await ctx.db.get(args.agent_task_id);
      if (task && task.user_id === args.user_id)
        await stampRunConversation(ctx, args.user_id, task, args.session_id);
    }

    // Auto-dismiss parent only for plan handoffs (clear context -> implementation session)
    if (parentConversationId && args.parent_message_uuid === "plan-handoff") {
      const parent = await ctx.db.get(parentConversationId);
      // Only the caller's own session is dismissed by their handoff.
      if (
        parent &&
        !parent.inbox_dismissed_at &&
        (await isConversationOwner(ctx, args.user_id, parent))
      ) {
        await patchConversationLifecycle(ctx, parentConversationId, {
          inbox_dismissed_at: Date.now(),
          status: "completed",
        });

        if (parent.team_id && (await isConversationTeamVisible(ctx, parent))) {
          await ctx.scheduler.runAfter(
            0,
            internal.teamActivity.recordTeamActivity,
            {
              team_id: parent.team_id,
              actor_user_id: parent.user_id,
              event_type: "session_completed" as const,
              title:
                parent.title ||
                (parent.slug
                  ? formatSlugAsTitle(parent.slug)
                  : "Session completed"),
              description: parent.project_path,
              related_conversation_id: parentConversationId,
              metadata: {
                duration_ms: parent.updated_at - parent.started_at,
                message_count: parent.message_count,
                git_branch: parent.git_branch,
              },
            },
          );
        }

        await ctx.scheduler.runAfter(
          0,
          internal.sessionInsights.generateSessionInsight,
          {
            conversation_id: parentConversationId,
            reason: "periodic",
          },
        );
      }
    }

    if (args.api_token) await touchDaemonLastSeen(ctx, args.user_id, creator);

    if (resolvedTeamId && !existing) {
      const bornSubagent =
        args.is_subagent === true ||
        (!!parentConversationId && !args.parent_message_uuid);
      // A fork is another line of a session already announced, never a new start.
      if (!bornSubagent && !args.fork) {
        // Grace delay: subagent/spawned-by links are often stamped seconds
        // after registration (linkSessions/linkSpawnedBy). notifyTeamSessionStart
        // re-reads the conversation at fire time, so the delay lets a late
        // link suppress the push instead of racing it.
        const NOTIFY_GRACE_MS = 60 * 1000;
        await ctx.scheduler.runAfter(
          NOTIFY_GRACE_MS,
          internal.notifications.notifyTeamSessionStart,
          {
            conversation_id: conversationId,
            user_id: args.user_id,
          },
        );
      }

      await ctx.scheduler.runAfter(
        0,
        internal.teamActivity.recordTeamActivity,
        {
          team_id: resolvedTeamId,
          actor_user_id: args.user_id,
          event_type: "session_started" as const,
          title:
            title || (args.slug ? formatSlugAsTitle(args.slug) : "New session"),
          description: args.project_path,
          related_conversation_id: conversationId,
          metadata: {
            git_branch: args.git_branch,
          },
        },
      );
    }

    return conversationId;
  },
});

/** The row a person's new conversation starts as: the owner's team and
 *  privacy for its path (resolveCreationPrivacy), active, empty, with its
 *  short id. createQuickSession hands the row to a daemon; the hosted
 *  assistant (assistant/entry.ts) runs it in this backend. `extra` carries
 *  what only one caller sets (a cloud parking, a title). */
export async function insertStartedConversation(
  ctx: MutationCtx,
  userId: Id<"users">,
  fields: {
    agent_type: Doc<"conversations">["agent_type"];
    session_id: string;
    started_at: number;
    project_path?: string;
    git_root?: string;
    extra?: Partial<Omit<Doc<"conversations">, "_id" | "_creationTime">>;
  },
): Promise<Id<"conversations">> {
  const privacy = await resolveCreationPrivacy(
    ctx,
    userId,
    fields.git_root || fields.project_path,
  );
  const conversationId = await insertConversationWithStatus(ctx, {
    user_id: userId,
    agent_type: fields.agent_type,
    session_id: fields.session_id,
    project_path: fields.project_path,
    git_root: fields.git_root,
    started_at: fields.started_at,
    updated_at: fields.started_at,
    message_count: 0,
    ...privacy,
    status: "active",
    ...fields.extra,
  });
  await ctx.db.patch(conversationId, {
    short_id: conversationId.toString().slice(0, 7),
  });
  return conversationId;
}

export const createQuickSession = mutation({
  args: {
    agent_type: v.optional(
      v.union(
        v.literal("claude_code"),
        v.literal("codex"),
        v.literal("cursor"),
        v.literal("gemini"),
        v.literal("opencode"),
        v.literal("pi"),
        v.literal("grok"),
        v.literal("muse"),
        v.literal("antigravity"),
      ),
    ),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    session_id: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
    // "Run in the cloud": the row is parked on this remote device until a local
    // daemon prepares the host and places it (cloud_spawn → cast cloud start).
    cloud_device_id: v.optional(v.string()),
    // With cloud_device_id: its own worktree on the host (absent = isolated)
    // or the host's main checkout (shared; refused up front when another
    // alive session holds that repo's checkout there).
    cloud_workspace: v.optional(cloudWorkspaceValidator),
    // With cloud_device_id: what the worktree starts from — the preparing
    // laptop's checkout (absent) or origin/main. Shared forces origin_main.
    cloud_start_from: v.optional(cloudStartFromArg),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    await checkRateLimit(ctx, userId, "createConversation");

    const now = Date.now();
    const sessionId = args.session_id || crypto.randomUUID();
    const agentType = args.agent_type || "claude_code";

    if (args.cloud_device_id)
      await resolveCloudDevice(ctx, userId, args.cloud_device_id);
    const cloudWorkspace = args.cloud_device_id
      ? (args.cloud_workspace ?? "isolated")
      : undefined;
    const cloudStartFrom = args.cloud_device_id
      ? effectiveStartFrom(cloudWorkspace, args.cloud_start_from, undefined)
      : undefined;
    if (args.cloud_device_id && cloudWorkspace === "shared") {
      // A direct mutation: the caller sees the refusal, so throw before any row exists.
      const repo = args.git_root || args.project_path;
      const occupant = repo
        ? await findSharedCheckoutOccupant(ctx, userId, args.cloud_device_id, {
            repoBasename: posixRepoBasename(repo),
          })
        : null;
      if (occupant)
        throw new Error(
          checkoutInUseMessage(
            occupant.cloud_checkout_path ?? occupant.project_path ?? repo!,
            occupant,
          ),
        );
    }

    const conversationId = await insertStartedConversation(ctx, userId, {
      agent_type: agentType,
      session_id: sessionId,
      started_at: now,
      project_path: args.project_path,
      git_root: args.git_root,
      extra: args.cloud_device_id
        ? {
            owner_device_id: args.cloud_device_id,
            cloud_placement: "pending" as const,
            cloud_workspace: cloudWorkspace,
            cloud_start_from: cloudStartFrom,
          }
        : undefined,
    });

    if (args.cloud_device_id) {
      const inserted = await ctx.db.get(conversationId);
      await parkOnCloudHost(ctx, userId, inserted, args.cloud_device_id, {
        projectPath: args.project_path,
        gitRoot: args.git_root,
        workspace: cloudWorkspace,
        startFrom: cloudStartFrom,
      });
      return conversationId;
    }

    await enqueueFreshLocalSession(ctx, userId, {
      conversationId,
      agentType: fromConvexAgentType(agentType),
      projectPath: args.project_path || args.git_root,
      sessionId,
      isolated: args.isolated,
      worktreeName: args.worktree_name,
      createdAt: now,
      callerUserId: userId,
    });

    return conversationId;
  },
});
