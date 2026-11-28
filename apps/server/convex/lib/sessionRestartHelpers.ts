import { heartbeatsFor } from "./sessionHeartbeat";
import { refuseSeatKill } from "./seatKill";
import { noteWriteCause } from "../lifecycleEvents";
import { query, type MutationCtx } from "../functions";
import { v } from "convex/values";
import { subagentEnded } from "../subagentFleet";
import { findConversationByAnyRefWhere } from "../conversationSessionLookup";
import { cascadeHideToNestedChildren } from "../cleanup";
import {
  insertConversationWithStatus,
  patchConversationLifecycle,
} from "./sessionStatusWriter";
import { Doc, Id } from "../_generated/dataModel";
import {
  resetConversationPendingMessages,
  cancelQueuedMessagesOnKill,
} from "../pendingMessages";
import {
  cancelTasksBoundToConversation,
  reactivateTasksCanceledOnKill,
} from "./agentTaskRows";
import {
  hasRecentPendingDaemonCommand,
  extractDaemonCommandConversationId,
  findSessionCommandByRequest,
} from "../daemonCommandUtils";
import {
  fromConvexAgentType,
  localAgentTypeOf,
  toConvexAgentType,
} from "@codecast/agent-clients/agentClients";
import { scheduleLiveActivityRefresh } from "./liveActivityRefresh";
import { resolveTeamForPath } from "../privacy";
import { killSession } from "../sessionRestart";

/**
 * Resolve a session the caller may command, for the CLI's session-scoped verbs
 * (`cast resume`, `cast restart`). Accepts any ref the user can type — short
 * id, conversation id, agent session id. Access is the runner or the
 * second-party owner, the same rule as cliSetSessionVisibility and killSession.
 * `verb` only shapes the error, which quotes back what the user actually typed.
 */
export async function resolveCommandableSession(
  ctx: MutationCtx,
  userId: Id<"users">,
  session: string,
  verb: string,
): Promise<Doc<"conversations">> {
  const conv = await findConversationByAnyRefWhere(
    ctx,
    session,
    (c) =>
      c.user_id?.toString() === userId.toString() ||
      c.owner_user_id?.toString() === userId.toString(),
  );
  if (!conv) {
    throw new Error(
      `No session found for "${session}" (you can only ${verb} sessions you run or own)`,
    );
  }
  if (!conv.session_id) {
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    throw new Error(
      `Session ${shortId} has no agent transcript yet — nothing to ${verb}`,
    );
  }
  return conv;
}

/**
 * What the CLI needs to follow a resume/restart to its pane: the agent's
 * session_id (which the daemon stamps on the pane as @codecast_session_id) and
 * the device that will host it, so `--tmux` can tell "coming up here" apart
 * from "coming up on another machine, don't wait for it".
 */
export function sessionCommandResult(conv: Doc<"conversations">) {
  return {
    ok: true as const,
    short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
    title: conv.title ?? null,
    session_id: conv.session_id!,
    conversation_id: conv._id,
    agent_type: fromConvexAgentType(conv.agent_type),
    project_path: conv.project_path ?? conv.git_root ?? null,
    device_id: (conv as any).owner_device_id ?? null,
  };
}

export const RESTART_GHOST_ARGS = {
  session_id: v.optional(v.string()),
  project_path: v.optional(v.string()),
  agent_type: v.optional(v.string()),
  title: v.optional(v.string()),
};

type RestartGhostContext = {
  session_id?: string;
  project_path?: string;
  agent_type?: string;
  title?: string;
};

export async function resolveRestartTarget(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  ghost: RestartGhostContext,
) {
  const conv = await ctx.db.get(conversationId);
  if (conv) {
    // The runner, or the session's second-party owner — same rule as dispatch
    // sendMessage/resumeSession. An owned session (Mr-Bot-run, assigned to this
    // user) restarts from the owner's inbox exactly like their own; the daemon
    // commands are routed to the runner by the callers.
    if (conv.user_id !== userId && conv.owner_user_id !== userId)
      throw new Error("Not authorized");
    // An explicit Restart IS the sanctioned revival — the same gesture class as
    // a human send, so it gets the send path's wake-up rules
    // (enqueuePendingMessage): clear the kill/hide stamps and re-activate, in
    // the SAME transaction that enqueues the resume. Without this the daemon
    // received "restart me" for a row still reading as killed and its hide gate
    // refused to bring it back. The ghost-recovery path below already did this
    // for the twin it restores; the existing row was the gap. Patch only what's
    // actually set, so an ordinary restart of a live session writes nothing.
    // Read the pre-patch state first: the re-arm below is decided on what the
    // row looked like when the user hit Restart, not on what the patch left.
    const wasRetired = !!(conv.inbox_dismissed_at || conv.inbox_killed_at);
    const revive: Record<string, any> = {};
    if (conv.status === "completed") revive.status = "active" as const;
    if (conv.inbox_killed_at) revive.inbox_killed_at = undefined;
    if (conv.inbox_dismissed_at) revive.inbox_dismissed_at = undefined;
    if (conv.inbox_stashed_at) revive.inbox_stashed_at = undefined;
    if (Object.keys(revive).length > 0) {
      await patchConversationLifecycle(ctx, conv._id, revive);
      // A revival is a revival: undismiss re-arms the schedules the kill
      // canceled (reactivateTasksCanceledOnKill), so Restart must too — without
      // this, `cast undismiss X` brings a session's standing loops back but
      // Restart leaves them dead forever, which is the more common gesture.
      // Same two scans as the kill that canceled them: the RUNNER's schedules,
      // plus the caller's when a second-party owner is restarting.
      if (wasRetired) {
        await reactivateTasksCanceledOnKill(ctx, conv.user_id, conv._id);
        if (conv.user_id.toString() !== userId.toString()) {
          await reactivateTasksCanceledOnKill(ctx, userId, conv._id);
        }
      }
      return { conv: (await ctx.db.get(conv._id))!, restored: false };
    }
    return { conv, restored: false };
  }
  let sessionId = ghost.session_id;
  if (!sessionId) {
    // A prior restore already tombstoned this dead id onto its replacement —
    // recover the session binding from there (covers old clients that send no
    // ghost context, for any ghost that has been restored once before).
    const prior = await ctx.db
      .query("conversations")
      .withIndex("by_restored_from", (q) =>
        q.eq("restored_from_conversation_id", conversationId.toString()),
      )
      .collect();
    const priorTarget = prior
      .filter((t) => t.user_id === userId)
      .reduce(
        (a: any, b: any) =>
          (b.updated_at ?? 0) > (a?.updated_at ?? 0) ? b : a,
        null,
      );
    sessionId = priorTarget?.session_id;
  }
  if (!sessionId) {
    // Old clients send no ghost context. The daemon's heartbeat rows can
    // outlive the conversation row — recover the session from there.
    const managed = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversationId),
      )
      .collect();
    const own = managed.filter((m) => m.user_id === userId);
    const beats = await heartbeatsFor(ctx, own);
    let newest = 0;
    for (const [i, beat] of beats.entries()) {
      if (beat <= newest) continue;
      newest = beat;
      sessionId = own[i].session_id;
    }
  }
  if (!sessionId) {
    // Deleted row and no recoverable session — nothing to bind a daemon
    // command to. Distinct error so the UI can say what actually happened.
    throw new Error("conversation_deleted");
  }
  // Live twin: pick the NEWEST row for this session. Never .first() — that's
  // creation order, which resolves to the oldest twin (the foot-gun that made
  // cleanup delete a live original instead of its doppelgänger; ct-36973).
  const twins = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q) => q.eq("session_id", sessionId!))
    .collect();
  const owned = twins.filter((t) => t.user_id === userId);
  if (owned.length > 0) {
    const twin = owned.reduce((a, b) =>
      (b.updated_at ?? 0) > (a.updated_at ?? 0) ? b : a,
    );
    // Restarting is an explicit "bring this back" — resurface it in the inbox,
    // and tombstone the dead id so stale links resolve here from now on.
    await patchConversationLifecycle(ctx, twin._id, {
      status: "active",
      inbox_dismissed_at: undefined,
      inbox_killed_at: undefined,
      restored_from_conversation_id: conversationId.toString(),
      updated_at: Date.now(),
    });
    return { conv: (await ctx.db.get(twin._id))!, restored: true };
  }
  // No surviving row anywhere: recreate a minimal one (same in-file creation
  // idiom as createQuickSession — team/privacy resolution + short_id).
  const now = Date.now();
  const mappings = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const { teamId, isPrivate, autoShared } = resolveTeamForPath(
    mappings,
    ghost.project_path,
    undefined,
  );
  const agentType = toConvexAgentType(fromConvexAgentType(ghost.agent_type));
  const newId = await insertConversationWithStatus(ctx, {
    user_id: userId,
    team_id: teamId,
    agent_type: agentType,
    session_id: sessionId,
    title: ghost.title,
    project_path: ghost.project_path,
    started_at: now,
    updated_at: now,
    message_count: 0,
    is_private: isPrivate,
    auto_shared: autoShared || undefined,
    status: "active",
    restored_from_conversation_id: conversationId.toString(),
  });
  await ctx.db.patch(newId, { short_id: newId.toString().slice(0, 7) });
  return { conv: (await ctx.db.get(newId))!, restored: true };
}

// Enqueue the kill→resume daemon command pair for a conversation, deduped
// against an already-pending resume. Shared by restartSession (gentle resume
// ladder on the daemon) and repairSession (force reconstitution from DB).
export async function enqueueKillAndResume(
  ctx: MutationCtx,
  userId: Id<"users">,
  conv: {
    _id: Id<"conversations">;
    session_id?: string;
    project_path?: string;
    git_root?: string;
    agent_type?: string;
    fork_status?: string;
    fork_daemon_args?: string;
  },
  // requestId: the client's id for this restart (store restartSession).
  // It lands on the resume row, the one whose outcome IS the restart's, so the
  // row the click painted settles from it. A replayed request queues nothing.
  opts: {
    forceReconstitute?: boolean;
    switchAgent?: boolean;
    model?: string;
    effort?: string;
    requestId?: string;
    cause?: string;
  } = {},
) {
  if (opts.cause) noteWriteCause(ctx, opts.cause);
  const now = Date.now();
  // Throws for a hosted conversation: no daemon kills or resumes it.
  const agentType = localAgentTypeOf(conv.agent_type);
  if (
    opts.requestId !== undefined &&
    (await findSessionCommandByRequest(ctx, userId, opts.requestId))
  ) {
    return { deduplicated: true };
  }
  const resumeArgs = {
    session_id: conv.session_id,
    conversation_id: conv._id,
    project_path: conv.project_path ?? conv.git_root,
    agent_type: agentType,
    ...(opts.forceReconstitute ? { force_reconstitute: true } : {}),
    ...(opts.switchAgent
      ? { switch_agent: true, force_reconstitute: true }
      : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  };
  if (opts.switchAgent && conv.fork_status === "copying") {
    const deferred = JSON.parse(conv.fork_daemon_args || "{}");
    await ctx.db.patch(conv._id, {
      fork_daemon_args: JSON.stringify({
        ...resumeArgs,
        fork: true,
        _target_device_id: deferred._target_device_id,
      }),
    });
    return { deduplicated: false, deferred: true };
  }
  const pendingCommands = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q) =>
      q.eq("user_id", userId).eq("executed_at", undefined),
    )
    .collect();

  const changesModel = opts.model !== undefined || opts.effort !== undefined;
  const candidates = pendingCommands.filter((command) => {
    if ((changesModel || opts.switchAgent) && command.claimed_by) return false;
    if (!opts.switchAgent) return true;
    if (
      extractDaemonCommandConversationId(command.args) !== conv._id.toString()
    )
      return false;
    const args = JSON.parse(command.args || "{}");
    return (
      args.switch_agent === true && args.agent_type === resumeArgs.agent_type
    );
  });
  if (
    hasRecentPendingDaemonCommand(candidates as any, {
      conversationId: conv._id.toString(),
      command: "resume_session",
      now,
    })
  ) {
    if (changesModel) {
      const queued = candidates.find((command) =>
        hasRecentPendingDaemonCommand([command], {
          conversationId: conv._id.toString(),
          command: "resume_session",
          now,
        }),
      );
      if (queued) {
        await ctx.db.patch(queued._id, {
          args: JSON.stringify({
            ...JSON.parse(queued.args || "{}"),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          }),
        });
      }
    }
    // The click joins the resume already queued: it carries the request id
    // when no earlier click bound one, so the painted row still settles.
    if (opts.requestId !== undefined) {
      const queued = candidates.find(
        (command) =>
          !command.request_id &&
          hasRecentPendingDaemonCommand([command], {
            conversationId: conv._id.toString(),
            command: "resume_session",
            now,
          }),
      );
      if (queued)
        await ctx.db.patch(queued._id, { request_id: opts.requestId });
    }
    await resetConversationPendingMessages(ctx, conv._id);
    return { deduplicated: true };
  }

  await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "kill_session",
    args: JSON.stringify({
      conversation_id: conv._id,
      session_id: conv.session_id,
      // Survives a split kill/resume batch: the daemon otherwise treats this
      // as a user kill, marks the conversation completed, and Codex keeps
      // answering under the old thread (ct-51691).
      ...(opts.switchAgent ? { switch_agent: true } : {}),
      cause:
        opts.cause ?? (opts.switchAgent ? "switch_agent" : "kill_and_resume"),
    }),
    created_at: now,
  });

  await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "resume_session",
    request_id: opts.requestId,
    args: JSON.stringify(resumeArgs),
    created_at: now + 1,
  });

  await resetConversationPendingMessages(ctx, conv._id);
  return { deduplicated: false };
}

/** The kill itself, for every caller that has already authenticated: the
 *  daemon teardown, the completed stamp, and the sweeps that keep it dead. */
export async function killConversation(
  ctx: any,
  userId: Id<"users">,
  args: {
    conversation_id: Id<"conversations">;
    mark_completed?: boolean;
    session_id?: string;
  },
  opts?: { retiring?: boolean; cause?: string; keepWorkspace?: boolean },
) {
  noteWriteCause(ctx, opts?.cause ?? "killSession");
  const conv = await ctx.db.get(args.conversation_id);
  // The runner, or the session's second-party owner — same rule as
  // restartSession/dispatch.sendMessage. An owned session kills from the
  // owner's inbox exactly like their own.
  if (conv && conv.user_id !== userId && conv.owner_user_id !== userId)
    throw new Error("Not authorized");
  if (!opts?.retiring) await refuseSeatKill(ctx, conv);

  // Enqueue even when the row is gone: the daemon tears backends down from the
  // conversation id alone (derived tmux names, local caches) plus the cached
  // session_id the client passes along. Address the command to the RUNNER's
  // daemon (conv.user_id) — an owner's kill must reach the machine actually
  // running the session; ghost rows fall back to the caller.
  await ctx.db.insert("daemon_commands", {
    user_id: conv?.user_id ?? userId,
    command: "kill_session",
    args: JSON.stringify({
      conversation_id: args.conversation_id,
      session_id: args.session_id ?? conv?.session_id,
      cause: opts?.cause ?? "killSession",
      // The worktree is someone else's to release (a run's, shared by its stations).
      ...(opts?.keepWorkspace ? { keep_workspace: true } : {}),
    }),
    created_at: Date.now(),
  });

  let canceledSchedules = 0;
  let canceledMessages = 0;
  if (conv) {
    // First-kill time, preserved across re-kills (same rule as
    // applyHideTransition): a repeat kill re-runs teardown, it doesn't
    // rewrite when the session was retired.
    const patch: Record<string, any> = conv.inbox_killed_at
      ? {}
      : { inbox_killed_at: Date.now() };
    // A persistent anchor session never auto-completes — a dismiss/kill gesture
    // on its pinned card puts it to sleep, it isn't retired. Only an explicit
    // decommissionAnchor (which clears `persistent` first) may complete it.
    if (args.mark_completed && !conv.persistent) {
      patch.status = "completed";
    }
    await patchConversationLifecycle(ctx, args.conversation_id, patch);
    // A retired row leaves the Lock Screen strip with the next push. The org
    // cores that retire a seat run without a scheduler in their pure form.
    if (ctx.scheduler)
      await scheduleLiveActivityRefresh(ctx, conv.user_id, { urgent: true });
    // Kill must stick: cancel any armed schedule that injects into this
    // conversation, or its next fire would resurrect the session the user
    // just killed (see cancelTasksBoundToConversation). Scan the RUNNER's
    // schedules (theirs are the ones bound to their session), plus the
    // caller's when a second-party owner is killing.
    // Both sweeps are RETIREMENT effects, so a persistent anchor is exempt
    // from both — killing an anchor is dormancy, not death. Same guard as
    // applyHideTransition: the two kill surfaces must agree about anchors, or
    // the web button and `cast kill` leave the same session in different
    // states (its queue survives one and not the other).
    if (!conv.persistent) {
      canceledSchedules = await cancelTasksBoundToConversation(
        ctx,
        conv.user_id,
        args.conversation_id,
      );
      if (conv.user_id !== userId) {
        canceledSchedules += await cancelTasksBoundToConversation(
          ctx,
          userId,
          args.conversation_id,
        );
      }
      // Kill is terminal for messages already queued too — same reason the
      // schedules die: a retained message that lands later revives the session
      // the user just killed. Only the pre-kill queue; a later send re-enqueues.
      canceledMessages = await cancelQueuedMessagesOnKill(
        ctx,
        args.conversation_id,
      );
    }
    // Take the nested group (Task subagents + agent-team teammates) down
    // with the card. The web store also sweeps optimistically for its own
    // gesture; this server twin covers every other caller. Forced, like the
    // unconditional enqueue above: this mutation IS an explicit kill gesture,
    // so an already-hidden child whose worker came back gets torn down again
    // rather than skipped — the group comes down as one unit.
    await cascadeHideToNestedChildren(
      ctx,
      conv,
      { inbox_dismissed_at: Date.now() },
      { forceKill: true, cause: opts?.cause ?? "killSession" },
    );
    if (!conv.persistent) await subagentEnded(ctx, conv, "killed");
  }
  return {
    existed: !!conv,
    canceled_schedules: canceledSchedules,
    canceled_messages: canceledMessages,
  };
}
