import { mutation, query, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { outcomeOfDeclaration, subagentEnded } from "./subagentFleet";
import {
  resolveConversationRefRanked,
  findConversationByAnyRefWhere,
} from "./conversationSessionLookup";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  clearThreadState,
  patchConversationLifecycle,
  writeThreadState,
} from "./lib/sessionStatusWriter";
import type { ThreadStateStatus } from "@codecast/sessions/threadState";
import { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  normalizeThreadState,
  parseThreadStateStatus,
  THREAD_STATE_RESULT_MAX_CHARS,
} from "@codecast/sessions/threadState";
import { scheduleLiveActivityRefresh } from "./lib/liveActivityRefresh";
import { canAccessConversation } from "./lib/access";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";

// The pinned thread state (cast state via /cli/sessions/state). The agent writes
// its own standing "where does this stand?" line here and rewrites it as the
// work moves; the human reads it pinned above the composer and truncated on the
// inbox card, instead of reading back through the thread.
//
// Empty text is a CLEAR, so `cast state ""` and `cast state clear` land on the
// same path. We stamp message_count alongside the text because that gap — not
// the clock — is what tells the reader how far the thread has moved since the
// agent last vouched for this (see packages/sessions/src/threadState).
// The CLI writes it over /cli/sessions/state/set; the web's clear control goes
// through the store's generic patchConversation rail instead, so the panel
// disappears on click without waiting for a round-trip.
// Access: the runner or the second-party owner — same rule as cliRenameSession.
// The one write path for a pinned thread state (`cast state`, and the brief
// edit that mirrors a role's first line, orgRoles.performBriefEdit). `text`
// is already normalized by the caller.
/** A station's json result as sent: kept only when it parses and fits. */
function threadStateResultOf(result: string | undefined): string | null {
  const text = result?.trim();
  if (!text || text.length > THREAD_STATE_RESULT_MAX_CHARS) return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text;
}

export async function performSetThreadState(
  ctx: MutationCtx,
  conv: Doc<"conversations">,
  text: string,
  status: ThreadStateStatus,
  result?: string | null,
): Promise<{ at: number; resurfaced: boolean }> {
  const at = await writeThreadState(ctx, conv, text, status, result);
  // A `blocked` declaration from a HIDDEN session is a claim on the user's
  // eyes — the same claim `cast trigger complete --needs-attention` makes,
  // cleared the same way (agentTasks.completeTaskRun). If the session is
  // still stashed when the agent declares blocked, nobody is watching by
  // definition (a human send un-stashes at enqueue), so the machine woke it
  // and the human must now be shown. `done` / `dormant` / `working` never
  // resurface anything: stash fails quiet except for asks. Killed rows are
  // exempt — kill tore the agent down; a straggling write must not resurrect.
  let resurfaced = false;
  if (
    status === "blocked" &&
    (conv.inbox_stashed_at || conv.inbox_dismissed_at) &&
    !conv.inbox_killed_at
  ) {
    await patchConversationLifecycle(ctx, conv._id, {
      inbox_stashed_at: undefined,
      inbox_dismissed_at: undefined,
    });
    resurfaced = true;
  }
  // The pin is the strip's title, and a blocked / done declaration can move
  // the row between Lock Screen statuses: those refresh at once, a reworded
  // working line rides the next routine push.
  await scheduleLiveActivityRefresh(ctx, conv.user_id, {
    urgent: status !== "working",
  });
  // A session under a role that declares blocked reaches its role through
  // the needs-input check (org-staffing.md S28), the one door for a waiting
  // episode: a declaration made mid-turn is heard when the turn settles, and
  // one made by a session already at rest is heard now.
  if ((conv.org_role_id || conv.standing_role_id) && status === "blocked") {
    await ctx.scheduler?.runAfter(0, internal.notifications.checkNeedsInput, {
      conversation_id: conv._id,
    });
  }
  // A worker declaring done or blocked frees its fleet slot and settles its
  // worktree (subagentFleet.ts).
  const outcome = outcomeOfDeclaration(status);
  if (outcome && conv.parent_conversation_id)
    await subagentEnded(ctx, conv, outcome);
  return { at, resurfaced };
}

export const setThreadState = mutation({
  args: {
    session: v.string(),
    text: v.optional(v.string()),
    // "working" | "blocked" | "done" (loose spellings accepted). Absent on
    // writes from older CLIs — those default to "working", the overwhelmingly
    // common truth for a state written mid-session.
    status: v.optional(v.string()),
    result: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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
      throw new Error(
        `No session found for "${args.session}" (you can only set state on sessions you run or own)`,
      );
    }

    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    const previous = conv.thread_state ?? null;
    const text = normalizeThreadState(args.text ?? "");

    if (!text) {
      await clearThreadState(ctx, conv._id);
      await scheduleLiveActivityRefresh(ctx, conv.user_id, {});
      return {
        ok: true as const,
        short_id: shortId,
        cleared: true as const,
        state: null,
        previous_state: previous,
      };
    }

    const status = parseThreadStateStatus(args.status) ?? "working";
    const { at, resurfaced } = await performSetThreadState(
      ctx,
      conv,
      text,
      status,
      threadStateResultOf(args.result),
    );
    return {
      ok: true as const,
      short_id: shortId,
      cleared: false as const,
      state: text,
      status,
      previous_state: previous,
      at,
      resurfaced,
    };
  },
});

// Read side of the same field (cast state / cast state show <session>). Same
// access rule as the write: a session you run or own.
export const getThreadState = query({
  args: {
    session: v.string(),
    // Background probes (the stale-state reminder, the scheduler's filing
    // read) ask about a session that may not have synced yet: answer null
    // instead of throwing, so an expected miss is not logged as an error.
    if_exists: v.optional(v.boolean()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Read access is the conversation's own (canAccessConversation): a
    // session you run or own, or a teammate's team-visible one. A Head of
    // People reads the standing session of a lead that reports to someone
    // else this way (org-staffing.md S29); the write above stays run-or-own.
    const conv = await resolveConversationRefRanked(
      ctx,
      args.session,
      userId,
      (c) => canAccessConversation(ctx, userId, c as any),
    );
    if (!conv || !(await canAccessConversation(ctx, userId, conv as any))) {
      if (args.if_exists) return null;
      throw new Error(
        `No session found for "${args.session}" (you can only read state on sessions you run, own or can see in your team)`,
      );
    }
    return {
      ok: true as const,
      short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
      title: conv.title ?? null,
      state: conv.thread_state ?? null,
      status: conv.thread_state_status ?? null,
      result: conv.thread_state_result ?? null,
      // When the pin was written, or, once a person's message took it down,
      // when the report still standing was: a run reads a report as its hand's
      // answer only when it is newer than the one it sent the hand back with.
      at:
        conv.thread_state_at ??
        (conv.thread_state_result ? conv.thread_state_result_at : undefined) ??
        null,
      msg_count_at_write: conv.thread_state_msg_count ?? null,
      message_count: conv.message_count ?? 0,
      // The session's filing, for the daemon's trigger scheduler: a machine
      // wake into a stashed session tells the agent nobody is watching (see
      // taskScheduler's inject preamble). "stashed" | "killed" | null.
      visibility: conv.inbox_killed_at
        ? ("killed" as const)
        : conv.inbox_stashed_at
          ? ("stashed" as const)
          : null,
    };
  },
});
