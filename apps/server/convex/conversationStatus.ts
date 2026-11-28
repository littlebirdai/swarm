import { heartbeatsFor } from "./lib/sessionHeartbeat";
import { hasDeliverableMessage } from "./lib/closeAside";
import { noteWriteCause } from "./lifecycleEvents";
import { mutation, query } from "./functions";
import { v } from "convex/values";
import {
  isConversationSafetyBlocked,
  safetyBlockPatch,
} from "./conversationSafety";
import { onFreshApiErrorPark } from "./accountSwitch";
import { patchConversationLifecycle } from "./lib/sessionStatusWriter";
import { isClosedSession } from "@codecast/inbox/closedSession";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";

/**
 * The daemon reporting a session checkout's live git state: HEAD, branch,
 * distance from upstream, dirtiness. Written only when something moved, so an
 * idle session never touches its hot row; the header renders it as a prompt
 * line (branch, sha, ahead/behind, dirty marker), each part linking into the
 * repository pages.
 */
export const updateGitState = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    // The origin URL: a session that started before the daemon recorded one
    // (or whose checkout gained a remote later) learns its repository here.
    git_remote_url: v.optional(v.string()),
    git_ahead: v.optional(v.number()),
    git_behind: v.optional(v.number()),
    git_dirty: v.optional(v.boolean()),
    // Fields to unset: a cloud agent's session drops the branch its provider
    // no longer names and anything a local checkout stamped on it.
    clear: v.optional(
      v.array(
        v.union(
          v.literal("git_commit_hash"),
          v.literal("git_branch"),
          v.literal("git_ahead"),
          v.literal("git_behind"),
          v.literal("git_dirty"),
        ),
      ),
    ),
  },
  handler: async (ctx, args): Promise<{ updated: boolean }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return { updated: false };
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return { updated: false };
    const next: Record<string, unknown> = {};
    for (const key of [
      "git_commit_hash",
      "git_branch",
      "git_remote_url",
      "git_ahead",
      "git_behind",
      "git_dirty",
    ] as const) {
      const value = args[key];
      if (value !== undefined && (conv as any)[key] !== value)
        next[key] = value;
    }
    for (const key of args.clear ?? []) {
      if (args[key] === undefined && (conv as any)[key] !== undefined)
        next[key] = undefined;
    }
    if (Object.keys(next).length === 0) return { updated: false };
    await ctx.db.patch(convId, { ...next, git_state_at: Date.now() });
    return { updated: true };
  },
});

export const setSessionError = mutation({
  args: {
    conversation_id: v.string(),
    error: v.optional(v.string()),
    only_if_equals: v.optional(v.string()),
    force: v.optional(v.boolean()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "daemon:setSessionError");
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return;
    if (isConversationSafetyBlocked(conv)) return;
    if (
      args.only_if_equals !== undefined &&
      conv.session_error !== args.only_if_equals
    )
      return;
    const safetyPatch = safetyBlockPatch(
      conv,
      [{ role: "assistant", content: args.error }],
      Date.now(),
    );
    if (conv.session_error === args.error && !safetyPatch) return;
    // A "couldn't start / no local checkout" error is impossible if the session
    // is actually running. Reject stale error writes (device-agnostic, so it holds
    // even for un-upgraded daemons) when a live managed session exists — that's a
    // second machine lacking the checkout racing the one that already started it.
    // Clearing the error (error=undefined) always passes through.
    if (args.error && !args.force && !safetyPatch) {
      const managed = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
        .collect();
      const now = Date.now();
      if (
        (await heartbeatsFor(ctx, managed)).some(
          (beat) => now - beat < 2 * 60 * 1000,
        )
      )
        return;
    }
    await ctx.db.patch(convId, {
      session_error: args.error,
      ...safetyPatch,
    });
    if (safetyPatch) await onFreshApiErrorPark(ctx, conv.user_id, "safety");
  },
});

export const markSessionCompleted = mutation({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "daemon:markSessionCompleted");
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return;
    // Anchors never auto-complete. This guard covers every reaping path that
    // routes through markSessionCompleted (the daemon watchdog, the SessionEnd
    // hook, daemon kill teardown). The direct-patch kill paths carry their own
    // matching `persistent` guard (killSession + dispatch dismiss→kill). So a
    // standing member that goes dormant is never flipped to "completed"; it is
    // retired only by decommissionAnchor, which clears `persistent` first.
    if (conv.persistent) return;
    // A closed session stopped because the person closed it, not because it
    // ended: completing it would retire it (cast send refuses a completed
    // session, a role drops it, a worker's report to it is dropped).
    if (isClosedSession(conv)) return;
    // A move in flight stopped this agent itself (the runner's quiesce): the
    // session is moving, not ending. Completing it here left every session
    // whose move then failed marked ended on its own machine.
    if (conv.migration) return;
    if (conv.status === "active") {
      if (conv.has_pending_messages) {
        return;
      }
      const pendingMsg = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q: any) =>
          q.eq("conversation_id", convId).eq("status", "pending"),
        )
        .first();
      if (pendingMsg) {
        return;
      }
      await patchConversationLifecycle(ctx, convId, { status: "completed" });
    }
  },
});

export const markSessionActive = mutation({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "daemon:markSessionActive");
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return;
    if (conv.status === "completed") {
      await patchConversationLifecycle(ctx, convId, { status: "active" });
    }
  },
});

// The daemon's read of a conversation's LIFECYCLE state (api_token auth, so it
// works from the CLI/daemon where there's no session cookie). It gates its reap
// on this: a session the user killed or stashed must not be brought back by the
// daemon's own recovery paths, and no existing daemon-facing query exposes the
// hide stamps (devices.resolveConversationBySession returns status only).
// Returns null for a missing conversation or one the caller doesn't run —
// same silent-null convention as its siblings, and the daemon treats null (or
// an undeployed query) as "no lifecycle opinion" and falls back.
//
// Addressable by conversation_id OR session_id (exactly one), because the daemon
// often knows only the session it is about to reap or resurrect — and the
// session route MUST resolve the newest twin, not the oldest (see below).
export const getConversationLifecycle = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    // Exactly one selector: neither is nothing to look up, and both could
    // disagree — refusing to guess is the same discipline
    // deleteConversationBySessionId applies to twins. Null, not a throw, so a
    // malformed call reads as "no opinion" like every other miss here.
    if (!!args.conversation_id === !!args.session_id) return null;

    let conv = args.conversation_id
      ? await ctx.db.get(args.conversation_id)
      : null;
    if (!conv && args.session_id) {
      // NEWEST twin, never .first(): .first() is creation order, so it returns
      // the OLDEST row bound to a session_id — the ct-36973 foot-gun that once
      // made cleanup delete a live original instead of its doppelgänger. Here it
      // would hand the daemon a dead twin's killed/stashed stamps for a session
      // that is very much alive, and the reap gate would refuse to bring the
      // live one back. Same newest-by-updated_at reduction resolveRestartTarget
      // uses, and foreign twins are filtered out before the pick, so another
      // user's row can neither be selected nor leak.
      const twins = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .collect();
      const owned = twins.filter((t) => t.user_id === userId);
      conv =
        owned.length > 0
          ? owned.reduce((a, b) =>
              (b.updated_at ?? 0) > (a.updated_at ?? 0) ? b : a,
            )
          : null;
    }
    if (!conv || conv.user_id !== userId) return null;
    return {
      status: conv.status,
      inbox_killed_at: conv.inbox_killed_at ?? null,
      inbox_stashed_at: conv.inbox_stashed_at ?? null,
      inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
      inbox_closed_at: conv.inbox_closed_at ?? null,
      inbox_pinned_at: conv.inbox_pinned_at ?? null,
      // Undelivered work is waiting for this session. The hibernation pass
      // refuses to park such a session, because parking it would trade a live
      // pane for a resume the very next tick.
      has_pending_messages: conv.has_pending_messages ?? false,
      // The daemon's Codex app-server recovery must not revive a thread after
      // an in-place switch away from Codex (jx7dj4aq: divider landed, Codex
      // still answered). Null when the row has no stamp.
      agent_type: conv.agent_type ?? null,
      // The person closed it (shared isClosedSession): the daemon does not
      // bring it back on its own. A message still waiting for it is a wake, so
      // a close never holds back its delivery, whatever has_pending_messages says.
      closed:
        isClosedSession(conv) && !(await hasDeliverableMessage(ctx, conv._id)),
    };
  },
});
