import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  approxMessageBytes,
  isNavigableUserMessage,
  navPromptPatch,
  toNavigatorRow,
  type FilteredUserMessage,
} from "./userMessagesFilter";
import { checkConversationAccess } from "./privacy";
import { getConversationByRawId } from "./lib/conversationHelpers";

// Scan caps for the user-prompt navigation list. The user-role index range is
// dominated by tool results (they sync as user-role rows), so a monster agent
// session holds thousands of docs here — an unbounded collect blew Convex's
// system-operation budget ("too many system operations") on every reactive
// re-run, and this query is live-subscribed by every open conversation view.
// Newest-first take keeps the recent prompts (rewind/fork). Oldest-first take
// keeps the opening prompts so the list's #1 is the first thing in the
// transcript, not a later prompt after the newest window filled with tool
// results. A prompt in the gap is filled in by the client from the loaded
// window. Removing both caps re-introduces the timeout.
export const NAV_USER_MESSAGES_SCAN_LIMIT = 2000;

export const NAV_USER_MESSAGES_OLDEST_LIMIT = 500;

// The scan's real ceiling. A "user" message is not only a person's prompt: in
// an agent transcript every TOOL RESULT is written with role "user", carrying
// the whole command output or file body, and the navigator throws all of those
// away. Reading 2500 of them to keep a few dozen prompts moved megabytes per
// execution, which is exactly what the 1s user-JS cap and the
// system-operation budget both measure — this query timed out in production on
// both counts (Sentry JAVASCRIPT-REACT-5J and -5B).
//
// So the scan is bounded in BYTES as well as in documents, and it streams:
// each document is judged and reduced to its two-line row as it arrives, so
// only one heavy body is ever in the heap and the discarded ones cost nothing
// past the read. Both ceilings below are spent ACROSS the two directions, not
// per direction, so they bound the whole execution.
export const NAV_USER_MESSAGES_BYTE_BUDGET = 2_000_000;

// The byte budget alone could starve the very list it protects: a transcript
// whose newest turns are two 1MB file reads would spend the budget before
// reaching a single prompt, and the navigator would open empty. So the soft
// budget only stops a scan that already has this many rows — a heavy document
// is discarded, and discarding it is not a reason to stop looking.
export const NAV_USER_MESSAGES_MIN_ROWS = 50;

// The stop with no floor under it. Whatever the transcript looks like, one
// execution never deserializes past this — the timeout must not come back just
// because the rows were slow to appear.
export const NAV_USER_MESSAGES_HARD_BYTE_CEILING = 4_000_000;

// Bytes and rows spent so far, shared by both direction passes.
type NavScanBudget = { bytes: number; kept: number };

// Walk one direction of the user-message index, keeping only navigable rows.
// Stops at whichever ceiling comes first — documents, or bytes deserialized.
// `indexed` walks the nav_prompt index, which holds only navigable rows, instead
// of the whole user-role range; the predicate still runs, so a row whose flag
// lags its content can never leak a tool result into the list.
async function streamNavigableUserMessages(
  db: { query: (table: "messages") => any },
  conversationId: Id<"conversations">,
  order: "desc" | "asc",
  docLimit: number,
  into: Map<string, FilteredUserMessage>,
  budget: NavScanBudget,
  indexed: boolean,
): Promise<void> {
  const q = (
    indexed
      ? db
          .query("messages")
          .withIndex("by_conversation_nav_prompt", (qq: any) =>
            qq.eq("conversation_id", conversationId).eq("nav_prompt", true),
          )
      : db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (qq: any) =>
            qq.eq("conversation_id", conversationId).eq("role", "user"),
          )
  ).order(order);
  let docs = 0;
  for await (const m of q) {
    docs++;
    budget.bytes += approxMessageBytes(m as any);
    if (isNavigableUserMessage(m as any)) {
      if (!into.has(m._id)) budget.kept++;
      into.set(m._id, toNavigatorRow(m as any));
    }
    if (budget.bytes >= NAV_USER_MESSAGES_HARD_BYTE_CEILING) break;
    if (
      budget.bytes >= NAV_USER_MESSAGES_BYTE_BUDGET &&
      budget.kept >= NAV_USER_MESSAGES_MIN_ROWS
    )
      break;
    if (docs >= docLimit) break;
  }
}

// `indexed` once the conversation's history carries nav_prompt flags
// (conversations.nav_prompts_indexed_at); before that, the bounded scan.
export async function collectNavigableUserMessages(
  db: { query: (table: "messages") => any },
  conversationId: Id<"conversations">,
  indexed = false,
) {
  const byId = new Map<string, FilteredUserMessage>();
  // Newest first: the end of the transcript is what the navigator opens on, so
  // it gets the budget first and the oldest pass only fills in the head with
  // whatever is left.
  const budget: NavScanBudget = { bytes: 0, kept: 0 };
  await streamNavigableUserMessages(
    db,
    conversationId,
    "desc",
    NAV_USER_MESSAGES_SCAN_LIMIT,
    byId,
    budget,
    indexed,
  );
  await streamNavigableUserMessages(
    db,
    conversationId,
    "asc",
    NAV_USER_MESSAGES_OLDEST_LIMIT,
    byId,
    budget,
    indexed,
  );
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export const getUserMessages = query({
  args: { conversation_id: v.string(), share_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const conv = await getConversationByRawId(ctx, args.conversation_id);
    if (!conv) return [];
    // Same admission as listMessages: owner, team, or share link. The message
    // browser must serve every viewer the transcript itself serves — including
    // unauthenticated visitors presenting a public share token.
    if (
      (await checkConversationAccess(ctx, userId, conv, args.share_token)) ===
      "denied"
    )
      return [];
    return collectNavigableUserMessages(
      ctx.db,
      conv._id,
      conv.nav_prompts_indexed_at !== undefined,
    );
  },
});

// User-role rows per backfill page. Most are tool results carrying whole
// command outputs, so the page is small enough to stay well under a
// mutation's read limit even when every row is a large file body.
const NAV_PROMPT_BACKFILL_PAGE_SIZE = 100;

// A sweep that started this recently is presumed still running; a newer open
// does not start a second chain. One that died is restarted after this.
const NAV_PROMPT_BACKFILL_CLAIM_MS = 10 * 60_000;

/**
 * Flag a conversation's history for the navigator's prompt index. Live
 * writes flag every new row, so this only catches up rows written before the
 * flag existed: once per conversation, on first open by anyone who can read
 * it. Idempotent: each page writes only the rows whose flag disagrees.
 */
export const backfillNavPrompts = mutation({
  args: { conversation_id: v.string(), share_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const conv = await getConversationByRawId(ctx, args.conversation_id);
    if (!conv || conv.nav_prompts_indexed_at !== undefined) return;
    const userId = await getAuthUserId(ctx);
    if (
      (await checkConversationAccess(ctx, userId, conv, args.share_token)) ===
      "denied"
    )
      return;
    const started = conv.nav_prompts_backfill_started_at;
    if (
      started !== undefined &&
      Date.now() - started < NAV_PROMPT_BACKFILL_CLAIM_MS
    )
      return;
    await ctx.db.patch(conv._id, {
      nav_prompts_backfill_started_at: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.conversationNav.backfillNavPromptsPage,
      { conversation_id: conv._id },
    );
  },
});

export const backfillNavPromptsPage = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation_role_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("role", "user"),
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: NAV_PROMPT_BACKFILL_PAGE_SIZE,
      });
    let flagged = 0;
    for (const m of page.page) {
      const nav = navPromptPatch(m, {});
      if ("nav_prompt" in nav) {
        await ctx.db.patch(m._id, nav);
        flagged++;
      }
    }
    if (page.isDone) {
      await ctx.db.patch(args.conversation_id, {
        nav_prompts_indexed_at: Date.now(),
        nav_prompts_backfill_started_at: undefined,
      });
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.conversationNav.backfillNavPromptsPage,
        {
          conversation_id: args.conversation_id,
          cursor: page.continueCursor,
        },
      );
    }
    return { scanned: page.page.length, flagged, done: page.isDone };
  },
});
