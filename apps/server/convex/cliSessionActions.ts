import { heartbeatsFor } from "./lib/sessionHeartbeat";
import { noteWriteCause } from "./lifecycleEvents";
import { mutation, query, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { applyHideTransition } from "./cleanup";
import { getAuthUserId } from "@convex-dev/auth/server";
import { patchConversationLifecycle } from "./lib/sessionStatusWriter";
import { Doc, Id } from "./_generated/dataModel";
import { resetConversationPendingMessages } from "./pendingMessages";
import {
  reactivateTasksCanceledOnKill,
  tasksOriginatedBy,
} from "./lib/agentTaskRows";
import {
  enqueueResumeSession,
  enqueueHibernateSession,
} from "./daemonCommandUtils";
import { HEARTBEAT_ALIVE_MS } from "./inboxFilters";
import {
  hideConversationForViewer,
  unhideConversationForViewer,
} from "./inboxHides";
import { nestParentIdOf } from "./ccAccountsShared";
import { checkConversationAccess } from "./privacy";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";
import {
  enqueueKillAndResume,
  resolveCommandableSession,
  sessionCommandResult,
} from "./lib/sessionRestartHelpers";

/**
 * Bring a hidden card back to the inbox and rearm what its kill canceled.
 * Shared by `cast undismiss` (whose whole job this is) and `cast restart`
 * (which would otherwise revive an agent nobody can see).
 *
 * inbox_killed_at clears too, or the restore can't do what it advertises: a
 * killed row is hidden by shouldShowInInbox on that flag alone, so clearing
 * only the hide stamps left it invisible and `cast kill`'s own "cast undismiss
 * <id> to resurface" hint was a false promise. (It used to work by accident —
 * the web's pin gesture wiped the flag through the patch rail, which is exactly
 * the hole the dispatch guard sealed.)
 *
 * `status` deliberately stays: this resurfaces the CARD, it does not restart
 * the agent — that's what enqueueKillAndResume is for.
 */
async function resurfaceHiddenSession(
  ctx: MutationCtx,
  conv: Doc<"conversations">,
  userId: Id<"users">,
): Promise<{ wasHidden: boolean; rearmed: number }> {
  const wasHidden = !!(
    conv.inbox_dismissed_at ||
    conv.inbox_stashed_at ||
    conv.inbox_killed_at
  );
  if (!wasHidden) return { wasHidden: false, rearmed: 0 };

  await patchConversationLifecycle(ctx, conv._id, {
    inbox_dismissed_at: undefined,
    inbox_stashed_at: undefined,
    inbox_killed_at: undefined,
  });
  // The un-kill mirror (same as the web restore path in dispatch): bring back
  // the schedules the kill canceled, stamped tasks only. Scan the runner's,
  // plus the caller's when a second-party owner is restoring.
  let rearmed = 0;
  if (conv.inbox_dismissed_at) {
    rearmed = await reactivateTasksCanceledOnKill(ctx, conv.user_id, conv._id);
    if (conv.user_id.toString() !== userId.toString()) {
      rearmed += await reactivateTasksCanceledOnKill(ctx, userId, conv._id);
    }
  }
  return { wasHidden, rearmed };
}

// Agent-facing inbox visibility (cast dismiss / undismiss / kill via
// /cli/sessions/*). Field semantics are IDENTICAL to the web inbox gestures and
// run the same hide-transition side effects (applyHideTransition):
//   dismiss   — stash: hide from the active inbox, agent keeps running
//               (Stashed bucket). An EMPTY pre-warm gets reaped instead.
//               `hidden` = "stash and hide": the stash survives trigger wakes
//               (see isStashHidden); a plain stash pops back on the next one.
//   kill      — retire: sets inbox_dismissed_at, which tears the agent down,
//               marks the session completed (unless persistent), and cancels
//               schedules bound to it (Killed bucket).
//   undismiss — restore: clears both hide flags; a killed session comes back
//               as a restartable card (mirrors the web restoreSession).
// Access: the runner or the second-party owner — the same rule as killSession
// and the dispatch triage path.
export const cliSetSessionVisibility = mutation({
  args: {
    session: v.string(),
    action: v.union(
      v.literal("dismiss"),
      v.literal("kill"),
      v.literal("undismiss"),
    ),
    hidden: v.optional(v.boolean()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, `cli:${args.action}`);
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await findConversationByAnyRefWhere(
      ctx,
      args.session,
      (c) =>
        c.user_id?.toString() === userId.toString() ||
        c.owner_user_id?.toString() === userId.toString(),
    );
    if (!conv) {
      // Not the runner or an owner: a teammate's session on the team board.
      // The row's own stamps are the owner's, so the caller's gesture is a
      // viewer hide (inbox_hides) — out of THEIR board only, the agent untouched.
      const seen = await findConversationByAnyRefWhere(
        ctx,
        args.session,
        () => true,
      );
      if (!seen) {
        throw new Error(
          `No session found for "${args.session}" (you can only manage sessions you run or own)`,
        );
      }
      const seenShortId = seen.short_id ?? seen._id.toString().slice(0, 7);
      if (args.action === "undismiss") {
        const wasHidden = await unhideConversationForViewer(
          ctx,
          userId,
          seen._id,
        );
        return {
          ok: true as const,
          short_id: seenShortId,
          action: args.action,
          was_hidden: wasHidden,
          rearmed_schedules: 0,
          outcome: "viewer_hide" as const,
        };
      }
      const hid = await hideConversationForViewer(
        ctx,
        userId,
        seen,
        args.action === "kill" ? "dismiss" : "stash",
      );
      if (!hid) {
        throw new Error(
          `No session found for "${args.session}" (you can only manage sessions you run or own, or hide a teammate's you can see)`,
        );
      }
      return {
        ok: true as const,
        short_id: seenShortId,
        action: args.action,
        outcome: "viewer_hide" as const,
        was_hidden: false,
      };
    }
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);

    if (args.action === "undismiss") {
      // A restore clears the caller's viewer hide too, in case the row was hidden
      // before they became an owner of it.
      await unhideConversationForViewer(ctx, userId, conv._id);
      const { wasHidden, rearmed } = await resurfaceHiddenSession(
        ctx,
        conv,
        userId,
      );
      return {
        ok: true as const,
        short_id: shortId,
        action: args.action,
        was_hidden: wasHidden,
        rearmed_schedules: rearmed,
      };
    }

    const wasHidden = !!conv.inbox_dismissed_at;
    // Every stash write sets inbox_stash_hidden (true or cleared): the flag is
    // only honored while the stamp is set, so a re-stash never inherits an
    // earlier gesture's mode.
    const patch =
      args.action === "kill"
        ? { inbox_dismissed_at: Date.now() }
        : {
            inbox_stashed_at: Date.now(),
            inbox_stash_hidden: args.hidden ? true : undefined,
          };
    await patchConversationLifecycle(ctx, conv._id, patch);
    // `conv` is the pre-patch row — applyHideTransition gates on the transition.
    // The nested group (Task subagents + agent-team teammates) comes down with
    // the card via its built-in cascade — see cascadeHideToNestedChildren.
    // `cast kill` is an EXPLICIT kill gesture, so it forces teardown even on an
    // already-dismissed session (whose worker a daemon bug may have revived) —
    // a re-asserted quiet dismiss still doesn't.
    const {
      action: outcome,
      canceledSchedules,
      canceledMessages,
      cascaded,
      teardownEnqueued,
    } = await applyHideTransition(ctx, conv, patch, {
      forceKill: args.action === "kill",
      cause: `cli:${args.action}`,
    });
    return {
      ok: true as const,
      short_id: shortId,
      action: args.action,
      outcome,
      was_hidden: wasHidden,
      teardown_enqueued: teardownEnqueued,
      canceled_schedules: canceledSchedules,
      canceled_messages: canceledMessages,
      cascaded_children: cascaded,
    };
  },
});

// Statuses of a live agent that is doing something or asking: retiring it would cut that off.
const RETIRE_BUSY_STATUSES = new Set([
  "working",
  "thinking",
  "compacting",
  "starting",
  "waiting",
  "permission_blocked",
]);

/**
 * Why a session must not be retired now, or null when nothing would be lost. The run read the session settled and
 * found no other work of its own, but that read is old by the time it asks, and it only sees the inbox row. A kill
 * also cancels every trigger bound to the session, drops its queued messages and tears down its nested children.
 */
export async function retireRefusal(
  ctx: { db: any },
  conv: any,
  expectedMessageCount: number,
  now: number,
): Promise<string | null> {
  if (conv.inbox_killed_at) return "it is already stopped";
  // A pin is a person keeping it in their inbox: theirs to end, not the run's.
  if (conv.inbox_pinned_at) return "a person pinned it";
  if ((conv.message_count ?? 0) !== expectedMessageCount)
    return `it has moved since the run read it (${expectedMessageCount} messages then, ${conv.message_count ?? 0} now)`;
  const liveAgent = async (id: Id<"conversations">) => {
    const rows = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", id))
      .collect();
    const beats = await heartbeatsFor(ctx, rows);
    return rows.filter(
      (_: any, i: number) => now - beats[i] < HEARTBEAT_ALIVE_MS,
    );
  };
  const held = await queuedOrArmed(ctx, conv._id);
  if (held) return `${held} for it`;
  if (
    (await liveAgent(conv._id)).some((m: any) =>
      RETIRE_BUSY_STATUSES.has(m.agent_status ?? ""),
    )
  )
    return "it is working";
  // The kill cascades to its nested sessions, live or not, and takes their queued messages and triggers with them.
  const [subs, spawned] = await Promise.all([
    ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q: any) =>
        q.eq("parent_conversation_id", conv._id),
      )
      .take(200),
    ctx.db
      .query("conversations")
      .withIndex("by_spawned_by", (q: any) =>
        q.eq("spawned_by_conversation_id", conv._id),
      )
      .take(200),
  ]);
  for (const child of [...subs, ...spawned]) {
    if (child.inbox_killed_at || nestParentIdOf(child) !== conv._id.toString())
      continue;
    const name = child.short_id ?? String(child._id).slice(0, 7);
    if ((await liveAgent(child._id)).length)
      return `its nested session ${name} is live`;
    const childHeld = await queuedOrArmed(ctx, child._id);
    if (childHeld) return `${childHeld} for its nested session ${name}`;
  }
  return null;
}

/** What a kill of this conversation would drop: a queued message, or an armed trigger. */
async function queuedOrArmed(
  ctx: { db: any },
  id: Id<"conversations">,
): Promise<string | null> {
  for (const status of ["pending", "injected", "held"]) {
    const queued = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q: any) =>
        q.eq("conversation_id", id).eq("status", status),
      )
      .first();
    if (queued) return "a message is queued";
  }
  const armed = (await tasksOriginatedBy(ctx, id)).find(
    (t: any) =>
      t.status === "scheduled" ||
      t.status === "running" ||
      t.status === "paused",
  );
  return armed ? "a trigger is armed" : null;
}

// A flow run retires the session its change came from once that change is live (flows.md FL4): the same kill as
// `cast kill`, but only when retireRefusal finds nothing it would cut off. A refusal kills nothing and says why; the
// run then tells the session it is over instead.
export const cliRetireSession = mutation({
  args: {
    session: v.string(),
    // The transcript length the run read the session settled at: any later message means it moved since.
    expected_message_count: v.number(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "cli:retire");
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await findConversationByAnyRefWhere(
      ctx,
      args.session,
      (c) =>
        c.user_id?.toString() === userId.toString() ||
        c.owner_user_id?.toString() === userId.toString(),
    );
    if (!conv)
      throw new Error(
        `No session found for "${args.session}" (you can only retire sessions you run or own)`,
      );
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    const reason = await retireRefusal(
      ctx,
      conv,
      args.expected_message_count,
      Date.now(),
    );
    if (reason) return { retired: false as const, short_id: shortId, reason };
    const patch = { inbox_dismissed_at: Date.now() };
    await patchConversationLifecycle(ctx, conv._id, patch);
    await applyHideTransition(ctx, conv, patch, {
      forceKill: true,
      cause: "cli:retire",
    });
    return { retired: true as const, short_id: shortId };
  },
});

// Agent-facing resume (cast resume <session> --tmux via /cli/sessions/resume) —
// the same backend as the web's Resume button. Asks the session's daemon to
// bring the agent up in a managed pane, WITHOUT killing anything: a session
// already alive keeps its pane and its running turn (the daemon reuses a
// healthy pane, see enqueueResumeSession), so this is safe to call on a live
// session just to find out where it lives.
//
// That is the whole difference from cliRestartSession below, and it is why
// `--tmux` belongs here: attaching to a session should never cost you the turn
// it was in the middle of.
export const cliResumeSession = mutation({
  args: {
    session: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await resolveCommandableSession(
      ctx,
      userId,
      args.session,
      "resume",
    );
    // A pane nobody can see is the same problem here as on restart: the card
    // comes back to the inbox before its agent does.
    const { wasHidden, rearmed } = await resurfaceHiddenSession(
      ctx,
      conv,
      userId,
    );
    const resume = await enqueueResumeSession(ctx, conv);
    if (!resume.fenced) await resetConversationPendingMessages(ctx, conv._id);

    return {
      ...sessionCommandResult(conv),
      deduplicated: resume.deduplicated,
      command_id: resume.command_id,
      was_hidden: wasHidden,
      rearmed_schedules: rearmed,
    };
  },
});

// Agent-facing hibernate (cast hibernate <session> via /cli/sessions/hibernate).
// Asks the session's daemon to park the pane now, without waiting for the fleet
// cap to pick it: same teardown, same wake. The card is left exactly where it
// is — parking a session is not a reason to pull a hidden one back into the
// inbox, which is the one thing this does that cliResumeSession does not.
export const cliHibernateSession = mutation({
  args: {
    session: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await resolveCommandableSession(
      ctx,
      userId,
      args.session,
      "hibernate",
    );
    const { deduplicated, command_id } = await enqueueHibernateSession(
      ctx,
      conv,
    );

    return {
      ...sessionCommandResult(conv),
      deduplicated,
      command_id,
    };
  },
});

// Agent-facing restart (cast restart <session> via /cli/sessions/restart) — the
// pair to `cast kill <session>`, and the same backend as the web header's
// "Restart session": kill the agent, then resume it through the daemon's resume
// ladder (resume the local transcript → repair from the server copy →
// reconstitute → start fresh). `repair: true` is the web's escalation rung, which
// forces the rebuild from the server copy even when a plain resume would appear
// to succeed — for a stale or corrupt local transcript.
//
// Unlike cliResumeSession this DISCARDS the running agent, so it is the wrong
// verb for merely attaching to a session.
export const cliRestartSession = mutation({
  args: {
    session: v.string(),
    repair: v.optional(v.boolean()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    noteWriteCause(ctx, "cli:restart");
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await resolveCommandableSession(
      ctx,
      userId,
      args.session,
      "restart",
    );
    const { wasHidden, rearmed } = await resurfaceHiddenSession(
      ctx,
      conv,
      userId,
    );
    const { deduplicated } = await enqueueKillAndResume(
      ctx,
      conv.user_id,
      conv,
      {
        forceReconstitute: !!args.repair,
      },
    );

    return {
      ...sessionCommandResult(conv),
      repaired: !!args.repair,
      deduplicated: !!deduplicated,
      was_hidden: wasHidden,
      rearmed_schedules: rearmed,
    };
  },
});

// Agent-facing rename (cast rename via /cli/sessions/rename). Stamps the same
// title_is_custom flag as the web Rename control, so the auto-titlers
// (titleGeneration, idleSummary, cleanup) never overwrite it. Access: anyone
// with owner-or-team visibility (checkConversationAccess) — a title is shared
// metadata like a message, so the bar matches `cast send`, not run-or-own.
// Share-link viewers ("shared") stay read-only.
export const cliRenameSession = mutation({
  args: {
    session: v.string(),
    title: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const title = args.title.trim();
    if (!title) throw new Error("Title cannot be empty");

    const conv = await findConversationByAnyRefWhere(
      ctx,
      args.session,
      async (c) => {
        const access = await checkConversationAccess(ctx, userId, c);
        return access === "owner" || access === "team";
      },
    );
    if (!conv) {
      throw new Error(
        `No session found for "${args.session}" (you can rename your own sessions and sessions shared with your team)`,
      );
    }
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    const previous = conv.title ?? null;
    await ctx.db.patch(conv._id, { title, title_is_custom: true });
    return {
      ok: true as const,
      short_id: shortId,
      title,
      previous_title: previous,
    };
  },
});
