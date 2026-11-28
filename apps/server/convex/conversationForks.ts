import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { resolveOwnerDevice } from "./devices";
import { cloudSeedArg } from "./cloudPlacement";
import { getAuthUserId } from "@convex-dev/auth/server";
import { insertConversationWithStatus } from "./lib/sessionStatusWriter";
import { forkSeedClientId } from "@codecast/sessions/forkSeed";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { enqueuePendingMessage } from "./pendingMessages";
import { advanceForkCopy, type ForkCopyCtx } from "./forkCopy";
import {
  AGENT_CLIENTS,
  localAgentTypeOf,
  canSessionBecomeAgent,
  agentForksFromAnyMessage,
  isHostedAgentType,
} from "@codecast/agent-clients/agentClients";
import { canOwnerOrTeamAccess, resolveCreationPrivacy } from "./privacy";
import { previewText } from "./lib/conversationChildHelpers";
import {
  getAuthenticatedUserId,
  getConvGitDiff,
  resolveConversationRef,
  setConvGitDiff,
} from "./lib/conversationHelpers";
import {
  UUID_SESSION_ID_RE,
  nativeForkEligible,
  opencodeApiForkEligible,
  recordFork,
} from "./lib/forkHelpers";

// Wraps the Convex MutationCtx in the minimal interface advanceForkCopy needs.
// Keeping this adapter local means forkCopy.ts has no Convex imports and can
// run in plain `bun:test`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeForkCtx(ctx: any): ForkCopyCtx {
  return {
    db: {
      get: (id) => ctx.db.get(id),
      queryMessages: async ({ conversationId, cursorGt, cutoffLte, limit }) => {
        const builder = ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (qq: any) =>
            qq.eq("conversation_id", conversationId as Id<"conversations">),
          )
          .filter((qq: any) =>
            cutoffLte !== undefined
              ? qq.and(
                  qq.gt(qq.field("timestamp"), cursorGt),
                  qq.lte(qq.field("timestamp"), cutoffLte),
                )
              : qq.gt(qq.field("timestamp"), cursorGt),
          );
        return builder.order("asc").take(limit);
      },
      insertMessage: (row) => ctx.db.insert("messages", row),
      insertDaemonCommand: (row) => ctx.db.insert("daemon_commands", row),
      patchConv: (id, patch) => ctx.db.patch(id as Id<"conversations">, patch),
    },
    scheduleContinue: async (forkId) => {
      await ctx.scheduler.runAfter(
        0,
        internal.conversationForks._continueFork,
        {
          forkId: forkId as Id<"conversations">,
        },
      );
    },
  };
}

export const _continueFork = internalMutation({
  args: { forkId: v.id("conversations") },
  handler: async (ctx, args) => {
    await advanceForkCopy(makeForkCtx(ctx), args.forkId);
  },
});

export const forkConversation = mutation({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in to fork conversations");
    }

    const originalConversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (originalConversations.length === 0) {
      throw new Error("Conversation not found");
    }

    const original = originalConversations[0];
    // A hosted conversation is not forkable: its transcript holds untrusted tool
    // results (mail, web pages) and its turns spend its owner's wallet, so a
    // copy in another account would be a hosted row nobody's engine serves.
    if (isHostedAgentType(original.agent_type)) {
      throw new Error("A hosted assistant conversation cannot be forked");
    }

    // The fork is owned by authUserId, a DIFFERENT user than the original's
    // owner. team_id must be resolved under the FORKER's own directory mappings,
    // not copied from the original — otherwise the fork silently carries the
    // original owner's team, and a later share (buildShareUpdate keeps an
    // existing team_id) publishes it to a team the forker may not belong to.
    const { team_id: forkTeamId } = await resolveCreationPrivacy(
      ctx,
      authUserId,
      original.git_root || original.project_path,
      undefined,
      undefined,
      original.git_remote_url,
    );

    // Trust the denormalized message_count for display; the actual copy is
    // driven by advanceForkCopy walking the source by timestamp cursor and
    // does not need an exact precomputed total.
    const now = Date.now();
    const newConversationId = await insertConversationWithStatus(ctx, {
      user_id: authUserId,
      team_id: forkTeamId,
      agent_type: original.agent_type,
      session_id: `forked-${original.session_id}-${crypto.randomUUID()}`,
      slug: original.slug,
      title: original.title,
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: original.project_path,
      model: original.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: true,
      status: "completed",
      forked_from: original._id,
      fork_status: "copying",
      fork_copy_total: original.message_count ?? 0,
      fork_copied: 0,
      fork_copy_cursor: 0,
      // Snapshot the source at fork time — new messages added to the source
      // after this point are NOT pulled into the fork. Without this, batches
      // run across separate transactions could accidentally track the
      // source's ongoing activity.
      fork_cutoff_timestamp: now,
    });
    await ctx.db.patch(newConversationId, {
      short_id: newConversationId.toString().slice(0, 7),
    });

    await recordFork(ctx, authUserId, original, newConversationId);

    // Copy the first batch synchronously so small forks finish in one RTT.
    // If more remains, advanceForkCopy schedules _continueFork to chain
    // subsequent batches as separate transactions.
    await advanceForkCopy(makeForkCtx(ctx), newConversationId);

    return newConversationId;
  },
});

export const forkFromMessage = mutation({
  args: {
    conversation_id: v.string(),
    message_uuid: v.optional(v.string()),
    api_token: v.optional(v.string()),
    session_id: v.optional(v.string()),
    // The branch's seed prompt (cast fork "<direction>"). It titles the new
    // row (sibling branches otherwise all read "Fork: <parent title>") and is
    // queued to the branch as the human's own next turn: raw text, no sender,
    // stamped with a fork-seed client_id so the web can mark it (see
    // @codecast/sessions/forkSeed). Enqueued in this same transaction
    // so a retried fork can never seed twice or create a branch nobody seeds.
    direction: v.optional(v.string()),
    target_agent_type: v.optional(
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
    // `cast fork --cloud`: the branch runs on the cloud host, in a worktree the
    // CLI already acquired there. Routing goes to that device, the row and the
    // daemon args carry the worktree as project path, and the JSONL-copy fast
    // path is off (the parent's transcript is not on that machine — the
    // deferred resume rebuilds the branch from the server copy).
    cloud_device_id: v.optional(v.string()),
    cloud_project_path: v.optional(v.string()),
    cloud_worktree: v.optional(
      v.object({
        name: v.string(),
        branch: v.optional(v.string()),
        path: v.optional(v.string()),
      }),
    ),
    // What that worktree started from (the parent checkout's branch/HEAD/
    // dirty state, or origin/main); stamped as cloud_seed with the fork time.
    cloud_seed: v.optional(cloudSeedArg),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const original = await resolveConversationRef(
      ctx,
      args.conversation_id,
      userId,
    );
    if (!original) {
      throw new Error("Conversation not found");
    }

    if (!(await canOwnerOrTeamAccess(ctx, userId, original))) {
      throw new Error("Access denied");
    }
    // Every fork ends in a daemon resume or fork command, so a hosted original
    // is refused before any row is written: hosted stays hosted.
    if (isHostedAgentType(original.agent_type)) {
      throw new Error("A hosted assistant conversation cannot be forked");
    }

    // Idempotency on the client-supplied session_id. The fork command rides the
    // dispatch outbox, which is at-least-once: dispatchWithRetry resends the
    // SAME args (session_id included) on any client-side error, and the outbox
    // re-drives on reconnect. Without this guard a delivery that succeeded
    // server-side but lost its response spawns a SECOND full-copy fork under the
    // same session_id — the user works in one and the other is left as an empty
    // "Fork: …" branch. Returning the existing row collapses every redelivery
    // onto one conversation; the indexed read makes Convex's OCC serialize a
    // truly-concurrent pair (the loser retries and finds the winner's insert).
    if (args.session_id) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (existing) {
        return {
          conversation_id: existing._id,
          short_id: existing.short_id ?? existing._id.toString().slice(0, 7),
        };
      }
    }

    // Resolve cutoff (for partial forks) without scanning the source. The
    // denormalized message_count on the conversation gives us an upper-bound
    // estimate for display; we don't need an exact total to drive the copy
    // chain (advanceForkCopy walks until the source runs dry). Avoiding a
    // full-source scan here is what keeps the kickoff mutation under
    // Convex's per-transaction read limit for huge conversations.
    const now = Date.now();

    // The fork is a snapshot at this moment in time. Partial forks cap at the
    // fork-point message's timestamp; full / agent-switch forks cap at "now"
    // so messages added to the source after fork-time aren't pulled in by
    // subsequent batches.
    let cutoffTimestamp: number;
    let isPartial = false;
    let atTip = true; // no fork point = snapshot at "now" = the tip
    // opencode's serve fork truncates to the state STRICTLY BEFORE a messageID
    // (verified live), while our copy is INCLUSIVE of the fork point
    // (timestamp <= cutoff). So to make the live opencode session hold exactly the
    // copied messages, it must fork at the message immediately AFTER the fork point.
    // Resolved only for opencode partial forks; undefined at tip (a full fork, no
    // messageID, already matches).
    let opencodeForkMessageId: string | undefined;
    if (args.message_uuid) {
      // Scope the lookup to THIS conversation. Forks copy messages verbatim,
      // preserving message_uuid (forkCopy.ts), so a given uuid exists in the
      // original AND every fork of it — the global by_message_uuid index is
      // non-unique and .first() can return another fork's copy, spuriously
      // failing the conversation match. by_conversation_uuid resolves the
      // message within `original` directly.
      const forkPointMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q
            .eq("conversation_id", original._id)
            .eq("message_uuid", args.message_uuid!),
        )
        .first();
      if (!forkPointMsg) {
        throw new Error("Fork point message not found");
      }
      cutoffTimestamp = forkPointMsg.timestamp;
      isPartial = true;
      // Fork-at-tip: the fork point is the source's newest message, so the
      // fork's history is the source's transcript verbatim — the daemon can
      // copy the local JSONL byte-for-byte (keeping Claude's prompt cache
      // warm) instead of rebuilding from an export.
      const newestMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", original._id),
        )
        .order("desc")
        .first();
      atTip =
        !!newestMsg &&
        (newestMsg._id === forkPointMsg._id ||
          forkPointMsg.timestamp >= newestMsg.timestamp);
      // The messageID opencode forks at = the first message strictly after the fork
      // point (same timestamp boundary the copy uses, so ties are handled the same
      // way on both sides). For an opencode source only; other agents don't use it.
      if (!atTip && original.agent_type === "opencode") {
        const nextMsg = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q
              .eq("conversation_id", original._id)
              .gt("timestamp", forkPointMsg.timestamp),
          )
          .order("asc")
          .first();
        opencodeForkMessageId = nextMsg?.message_uuid;
      }
    } else {
      cutoffTimestamp = now;
    }
    // Partial forks: exact total is unknown without a scan, so leave it
    // undefined; the UI shows progress without a denominator in that case.
    // Full forks: trust the denormalized message_count for display.
    const totalToCopy = isPartial ? undefined : (original.message_count ?? 0);

    const isAgentSwitch = !!args.target_agent_type && !args.message_uuid;
    const agentType = args.target_agent_type || original.agent_type;
    const agentLabels: Record<string, string> = {
      claude_code: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      gemini: "Gemini",
    };
    const isCrossAgentSwitch =
      !!args.target_agent_type &&
      args.target_agent_type !== original.agent_type;
    const titlePrefix = isCrossAgentSwitch
      ? `${agentLabels[args.target_agent_type!] || args.target_agent_type}: `
      : "Fork: ";
    // The daemon_command is deferred so it can't race a half-copied fork. It
    // gets inserted by advanceForkCopy when fork_status flips to "complete".
    const daemonAgentType = localAgentTypeOf(agentType);
    // Refuse up front what the daemon could not honor, so no row is written for
    // a branch that would never carry its history: a fork into a client whose
    // transcript codecast cannot rebuild, or a mid-history fork on a client that
    // can only copy its whole context (native fork). The UI hides these
    // affordances from the same registry facts; this is the API's guard.
    const targetLabel = AGENT_CLIENTS[daemonAgentType].displayName;
    if (
      isCrossAgentSwitch &&
      !canSessionBecomeAgent(agentType, original.message_count)
    ) {
      throw new Error(
        `${targetLabel} cannot take over an existing session's history; start a new ${targetLabel} session instead`,
      );
    }
    if (!atTip && !agentForksFromAnyMessage(agentType)) {
      throw new Error(`${targetLabel} can only fork from the latest message`);
    }
    const isPlainFork =
      !args.target_agent_type || args.target_agent_type === original.agent_type;
    const isNativeFork = nativeForkEligible({
      isPlainFork,
      daemonAgentType,
      sourceSessionId: original.session_id,
      atTip,
      cloud: !!args.cloud_device_id,
    });
    const forkSessionId = isNativeFork
      ? args.session_id && UUID_SESSION_ID_RE.test(args.session_id)
        ? args.session_id
        : crypto.randomUUID()
      : args.session_id ||
        `forked-${original.session_id}-${crypto.randomUUID()}`;

    // A fork defaults to the same visibility a fresh session in this directory
    // would get: re-resolve from the forker's directory mappings rather than
    // hardcoding private. This keeps a fork consistent with its project's
    // sharing policy (same git_root → same policy), so forking a team-shared
    // session stays team-visible — and forking someone else's session follows
    // YOUR mappings, never inadvertently broadcasting under their settings.
    // Agent-switch forks are pure continuations and inherit the source's exact
    // visibility instead. The repository matters as much as the path: forking a
    // teammate's session hands over THEIR checkout path, which none of the
    // forker's path mappings name, while the forker's repo mapping does.
    const {
      team_id: forkTeamId,
      is_private: forkIsPrivate,
      auto_shared: forkAutoShared,
    } = await resolveCreationPrivacy(
      ctx,
      userId,
      original.git_root || original.project_path,
      original.team_id,
      undefined,
      original.git_remote_url,
    );

    // The fork lives where the parent's transcript lives: route daemon commands
    // to the parent's owner device (it has the JSONL and the checkout). Falls
    // back to project-root routing when the parent has no live owner.
    const ownerTarget =
      args.cloud_device_id ??
      (await resolveOwnerDevice(ctx, userId, {
        projectPath: original.project_path,
        gitRoot: original.git_root,
        ownerDeviceId: original.owner_device_id ?? null,
      }));
    const forkProjectPath = args.cloud_project_path ?? original.project_path;
    // Fast path applies when the fork's history is the parent's transcript
    // verbatim AND the same claude binary will resume it — the daemon copies
    // the parent's JSONL instead of waiting for the server copy + rebuild.
    const fastPathEligible =
      atTip &&
      isPlainFork &&
      daemonAgentType === "claude" &&
      (original.agent_type === "claude_code" || !original.agent_type) &&
      !args.cloud_device_id;
    // opencode forks through its serve sidecar: POST /session/:id/fork mints a
    // REAL, resumable ses_ id from the parent session (a synthetic forked-<id>
    // never resolves in opencode.db — that's the bug this fixes). The daemon needs
    // the parent's real opencode session id to call fork(), so pass it through.
    const isOpencodeApiFork = opencodeApiForkEligible({
      isPlainFork,
      daemonAgentType,
      sourceAgentType: original.agent_type,
      sourceSessionId: original.session_id,
      atTip,
      forkMessageId: opencodeForkMessageId,
    });

    const newConversationId = await insertConversationWithStatus(ctx, {
      user_id: userId,
      team_id: isAgentSwitch ? original.team_id : forkTeamId,
      agent_type: agentType,
      session_id: forkSessionId,
      slug: original.slug,
      // A direction-seeded branch is titled by what IT will do, not by its
      // parent — otherwise N sibling branches all render as identical
      // "Fork: <parent>" cards. previewText compresses the prompt to one line.
      title: (() => {
        const directionSnippet = previewText(args.direction);
        if (directionSnippet) return `${titlePrefix}${directionSnippet}`;
        return original.title ? `${titlePrefix}${original.title}` : undefined;
      })(),
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: forkProjectPath,
      model: isAgentSwitch ? undefined : original.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isAgentSwitch ? original.is_private : forkIsPrivate,
      auto_shared: isAgentSwitch ? original.auto_shared : forkAutoShared,
      status: "active",
      forked_from: isAgentSwitch ? undefined : original._id,
      parent_message_uuid: isAgentSwitch ? "agent-switch" : args.message_uuid,
      parent_conversation_id: isAgentSwitch ? original._id : undefined,
      git_commit_hash: original.git_commit_hash,
      git_branch: original.git_branch,
      git_remote_url: original.git_remote_url,
      git_root: original.git_root,
      cli_flags: original.cli_flags,
      worktree_name: args.cloud_worktree?.name ?? original.worktree_name,
      worktree_branch: args.cloud_worktree
        ? args.cloud_worktree.branch
        : original.worktree_branch,
      worktree_path: args.cloud_worktree
        ? args.cloud_worktree.path
        : original.worktree_path,
      worktree_status: args.cloud_worktree
        ? ("active" as const)
        : original.worktree_status,
      ...(args.cloud_worktree ? { cloud_workspace: "isolated" as const } : {}),
      ...(args.cloud_seed
        ? { cloud_seed: { ...args.cloud_seed, at: now } }
        : {}),
      fork_status: "copying",
      fork_copy_total: totalToCopy,
      fork_copied: 0,
      fork_copy_cursor: 0,
      fork_cutoff_timestamp: cutoffTimestamp,
      owner_device_id: ownerTarget ?? undefined,
    });

    const forkDaemonArgs = {
      fork: true,
      session_id: forkSessionId,
      agent_type: daemonAgentType,
      conversation_id: newConversationId,
      project_path: forkProjectPath || original.git_root,
      // Copy-the-JSONL hints. The deferred (post-copy) command may also use
      // them: copy-first is cache-stable even when the rebuild would be safe.
      ...(fastPathEligible
        ? { fork_fast_path: true, parent_session_id: original.session_id }
        : {}),
      // Native fork (registry forkCmd): the daemon launches the client's own
      // fork of the parent; it needs the parent's session id.
      ...(isNativeFork ? { parent_session_id: original.session_id } : {}),
      // opencode API fork: carry the parent's real ses_ id so the daemon can call
      // OpencodeServer.fork(parent) and resume the minted id (see daemon resume_session).
      // fork_message_id (partial forks only) truncates the fork to match the copy.
      ...(isOpencodeApiFork
        ? {
            fork_api: true,
            parent_session_id: original.session_id,
            ...(opencodeForkMessageId
              ? { fork_message_id: opencodeForkMessageId }
              : {}),
          }
        : {}),
      _target_device_id: ownerTarget ?? undefined,
    };
    await ctx.db.patch(newConversationId, {
      short_id: newConversationId.toString().slice(0, 7),
      // A native fork gets no deferred resume at copy completion: the immediate
      // fork_session below is the only command that can launch it (the daemon
      // cannot rebuild the client's transcript), and a second resume while the
      // branch's seed is mid-delivery re-clears delivery state and injects the
      // seed twice.
      ...(isNativeFork
        ? {}
        : { fork_daemon_args: JSON.stringify(forkDaemonArgs) }),
    });

    // At-tip forks don't need the server-side message copy to start the
    // session — the daemon copies the parent's local JSONL. Emit immediately
    // (strict: no export fallback while the copy is mid-flight) so the tmux
    // session spins up in parallel with the copy. A dedicated command name:
    // pre-fast-path daemons report "Unknown command" and stay inert instead of
    // reconstituting a truncated fork from the half-copied export. The
    // deferred resume_session emitted at copy completion is the safety net
    // (resuming an already-attached session reuses the live tmux pane).
    // A native fork needs no server copy either — the client copies its own
    // state — so it launches immediately the same way, and it is the fork's
    // only daemon command (see fork_daemon_args above).
    if (fastPathEligible || isNativeFork) {
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "fork_session",
        args: JSON.stringify({
          ...forkDaemonArgs,
          _target_device_id: undefined,
          fork_fast_path_strict: true,
        }),
        created_at: now,
        target_device_id: ownerTarget ?? undefined,
      });
    }

    // Agent-switch continuations inherit the label too (they're the same
    // thread of work under a different agent, exactly like the visibility
    // inheritance above) but are not counted as forks.
    await recordFork(ctx, userId, original, newConversationId, {
      counted: !isAgentSwitch,
    });

    // Carry the original's git side row (diff + status) over to the fork's.
    const originalGitDiff = await getConvGitDiff(ctx, original._id);
    await setConvGitDiff(
      ctx,
      newConversationId,
      originalGitDiff.git_diff ?? undefined,
      originalGitDiff.git_diff_staged ?? undefined,
      originalGitDiff.git_status ?? original.git_status ?? undefined,
    );

    // Copy first batch synchronously so small forks finish in one round-trip;
    // larger ones chain via _continueFork.
    await advanceForkCopy(makeForkCtx(ctx), newConversationId);

    // Seed the branch. The direction lands as the person's next instruction —
    // the same rail the web composer uses, marked human so the wake rules for
    // a person writing into a thread apply — never as a session-to-session
    // message from the parent: that wrapper tells the branch who forked it
    // and invites it to report back, which is the one thing a branch must
    // not do. Delivery waits for the branch's session to come up.
    let seedMessageId: Id<"pending_messages"> | undefined;
    const seed = args.direction?.trim();
    if (seed) {
      const branch = await ctx.db.get(newConversationId);
      if (branch) {
        seedMessageId = await enqueuePendingMessage(ctx, branch, userId, {
          content: seed,
          client_id: forkSeedClientId(forkSessionId),
          human: true,
        });
      }
    }

    return {
      conversation_id: newConversationId,
      short_id: newConversationId.toString().slice(0, 7),
      seed_message_id: seedMessageId,
    };
  },
});
