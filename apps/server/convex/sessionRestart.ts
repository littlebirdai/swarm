import { noteWriteCause } from "./lifecycleEvents";
import { mutation, query, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import {
  extractDaemonCommandConversationId,
  requireSessionCommandTarget,
  findSessionCommandByRequest,
  recentConversationCommands,
  validateSessionCommandRequestId,
  stopAndSendForUser,
  insertEscapeCommand,
} from "./daemonCommandUtils";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import {
  RESTART_GHOST_ARGS,
  enqueueKillAndResume,
  killConversation,
  resolveRestartTarget,
} from "./lib/sessionRestartHelpers";

// Escape pressed in an empty composer. The client forwards every press and
// paints the interruption line at once; the daemon decides whether there is a
// turn to interrupt (cli/src/escapeInterrupt.ts). `pressed_at` is the client's
// clock at the press: the daemon skips a press that predates a message it
// delivered afterwards, so an Escape aimed at the previous turn cannot cancel
// the one a queued message just started.
//
// `request_id` binds the row to the web's sessionCommands row for the press, so
// a stop no daemon picks up, or one it could not deliver, shows in the header
// (lib/session-commands interruptVerdict). Routed to the owning device like a
// resume: on a broadcast row the first daemon to answer settles it, and a
// machine without the session answers "No session found" while the owner
// never sends the keys.
export const sendEscapeToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    pressed_at: v.optional(v.number()),
    request_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (args.request_id !== undefined)
      validateSessionCommandRequestId(args.request_id);

    const conv = await requireSessionCommandTarget(
      ctx,
      userId,
      args.conversation_id,
    );
    await insertEscapeCommand(ctx, conv, {
      pressed_at: args.pressed_at,
      request_id: args.request_id,
    });
  },
});

// "Stop and send" (the composer's Stop & send): stop the running turn, then
// deliver this message once the agent is at rest (stopAndSendForUser).
export const stopAndSendToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    content: v.string(),
    client_id: v.string(),
    pressed_at: v.number(),
    request_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (args.request_id !== undefined)
      validateSessionCommandRequestId(args.request_id);
    return await stopAndSendForUser(
      ctx,
      userId,
      args.conversation_id,
      args.content,
      args.client_id,
      args.pressed_at,
      args.request_id,
    );
  },
});

export const sendKeysToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    keys: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await requireSessionCommandTarget(
      ctx,
      userId,
      args.conversation_id,
    );

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "send_keys",
      args: JSON.stringify({
        conversation_id: args.conversation_id,
        keys: args.keys,
      }),
      created_at: Date.now(),
    });
  },
});

// Shift+tab through the session's permission modes. The daemon presses and
// reads the mode back off the pane (Claude Code's cycle depends on version and
// launch flags, so nothing predicts it); with `target` it presses until the
// footer names that mode. The result reaches the client as the session's
// permission_mode, published like a hook post.
export const setPermissionMode = mutation({
  args: {
    conversation_id: v.id("conversations"),
    target: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await requireSessionCommandTarget(
      ctx,
      userId,
      args.conversation_id,
    );

    // Routed to the owning device like a resume: a broadcast row is claimed by
    // whichever daemon answers first, and a daemon that predates this command
    // answers "Unknown command" and swallows the press (2 of 5 lost on
    // 2026-09-12). Unresolved owner = broadcast, and the daemon's own owner
    // guard decides.
    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "set_permission_mode",
      target_device_id: conv.owner_device_id ?? undefined,
      args: JSON.stringify({
        conversation_id: args.conversation_id,
        ...(args.target ? { target: args.target } : {}),
      }),
      created_at: Date.now(),
    });
  },
});

export const rewindSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    steps_back: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await requireSessionCommandTarget(
      ctx,
      userId,
      args.conversation_id,
    );

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "rewind",
      args: JSON.stringify({
        conversation_id: args.conversation_id,
        steps_back: args.steps_back,
      }),
      created_at: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Kill / restart recovery.
//
// The conversation id a client acts on can be a GHOST: the row was deleted
// server-side (GC sweeps, cleanup mutations) while the client's never-prune
// cache keeps rendering it. The underlying agent session is still real — its
// JSONL transcript (and sometimes tmux) lives on the daemon's machine — so
// "kill & restart" must keep working. Recovery resolves a live target row for
// the session instead of dead-ending: prefer the newest live twin bound to the
// same session_id (the daemon's local conversation cache usually already syncs
// there), else recreate a minimal row for the daemon to bind to. The context
// fields (session_id/project_path/agent_type/title) ride in from the client's
// cached copy, because for a deleted row the server knows nothing.
// ---------------------------------------------------------------------------

export const killSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    mark_completed: v.optional(v.boolean()),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    return killConversation(ctx, userId, args);
  },
});

// A restart the dispatch outbox delivers twice: answer from the command the
// first delivery queued, before a ghost restore can mint a second conversation.
async function replayedRestart(
  ctx: MutationCtx,
  userId: Id<"users">,
  requestId: string | undefined,
) {
  if (requestId === undefined) return null;
  validateSessionCommandRequestId(requestId);
  const existing = await findSessionCommandByRequest(ctx, userId, requestId);
  const convId = existing && extractDaemonCommandConversationId(existing.args);
  return convId
    ? { conversation_id: convId as Id<"conversations">, restored: false }
    : null;
}

export const restartSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    request_id: v.optional(v.string()),
    ...RESTART_GHOST_ARGS,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const replay = await replayedRestart(ctx, userId, args.request_id);
    if (replay) return replay;
    noteWriteCause(ctx, "restart");
    const { conv, restored } = await resolveRestartTarget(
      ctx,
      userId,
      args.conversation_id,
      args,
    );
    if (!conv.session_id) throw new Error("No session to restart");
    // The hosted assistant runs on the server, not on a machine: no daemon
    // polls for it, and its turn engine owns delivery.
    if (isHostedAgentType(conv.agent_type))
      throw new Error(
        "The assistant runs here, so there is nothing to restart",
      );

    // Daemon commands are polled by the RUNNER's daemon — for a second-party
    // owner restarting a session run by another account, address the commands
    // to the runner, not the caller (same routing as dispatch.resumeSession).
    await enqueueKillAndResume(ctx, conv.user_id, conv, {
      requestId: args.request_id,
      cause: "restart",
    });
    return { conversation_id: conv._id, restored };
  },
});

export const repairSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    request_id: v.optional(v.string()),
    ...RESTART_GHOST_ARGS,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const replay = await replayedRestart(ctx, userId, args.request_id);
    if (replay) return replay;
    noteWriteCause(ctx, "repair");
    const { conv, restored } = await resolveRestartTarget(
      ctx,
      userId,
      args.conversation_id,
      args,
    );
    if (!conv.session_id) throw new Error("No session to repair");

    // Runner-routed for the same reason as restartSession above.
    await enqueueKillAndResume(ctx, conv.user_id, conv, {
      forceReconstitute: true,
      requestId: args.request_id,
      cause: "repair",
    });
    return { conversation_id: conv._id, restored };
  },
});

// The pre-store shape of a conversation's restart/move commands, for web
// clients older than sessionCommands.forConversation (which feeds the same rows
// into the store). Remove once no deployed web reads it.
export const getRestartProgress = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return (
      await recentConversationCommands(ctx, userId, args.conversation_id)
    ).map((c) => ({
      command: c.command,
      created_at: c.created_at,
      executed_at: c.executed_at ?? null,
      result: c.result ?? null,
      error: c.error ?? null,
    }));
  },
});
