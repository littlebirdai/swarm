import { mutation, query, type QueryCtx } from "./functions";
import { v } from "convex/values";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { getAuthUserId } from "@convex-dev/auth/server";
import { patchConversationLifecycle } from "./lib/sessionStatusWriter";
import { PATCHABLE_CONVERSATION_FIELDS } from "@codecast/sessions/conversationFields";
import { normalizeCharacterFields } from "@codecast/org/sessionCharacter";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { pinCapExceeded, PIN_CAP_ERROR } from "./inboxProjection";
import { normalizePaneUrl } from "@codecast/browser/browserPaneOffer";
import { canOwnerOrTeamAccess } from "./privacy";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";

// Returns this user's distinct git_root values for the given remote URL,
// most-recently-updated first. The CLI/daemon uses this to remap a foreign
// project_path (created on another machine, or forked from another user) to
// a local checkout of the same repo. Pure metadata — no message bodies.
export const findUserLocalCheckouts = query({
  args: {
    git_remote_url: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    if (!args.git_remote_url) return [];
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_git_remote_url", (q) =>
        q.eq("user_id", userId).eq("git_remote_url", args.git_remote_url),
      )
      .collect();
    const seen = new Set<string>();
    const out: {
      git_root: string;
      project_path: string | null;
      updated_at: number;
    }[] = [];
    convs.sort((a, b) => b.updated_at - a.updated_at);
    for (const c of convs) {
      const root = c.git_root;
      if (!root || seen.has(root)) continue;
      seen.add(root);
      out.push({
        git_root: root,
        project_path: c.project_path ?? null,
        updated_at: c.updated_at,
      });
    }
    return out;
  },
});

// Lightweight metadata fetch used by the daemon to resolve project paths
// without pulling the full conversation + messages. Auth-checked.
/** The repository a folder holds, as the person's own earlier sessions
 *  recorded it: a session in the folder itself, else one whose checkout root
 *  is the folder or a folder above it. Null when none of them saw a remote. */
export async function recordedRepoForFolder(
  ctx: QueryCtx,
  userId: Id<"users">,
  folder: string | null,
): Promise<{ git_root: string; git_remote_url: string } | null> {
  if (!folder || !folder.startsWith("/")) return null;
  const inFolder = await ctx.db
    .query("conversations")
    .withIndex("by_user_project_path", (q) =>
      q.eq("user_id", userId).eq("project_path", folder),
    )
    .order("desc")
    .take(8);
  const direct = inFolder.find((c) => c.git_remote_url && c.git_root);
  if (direct)
    return {
      git_root: direct.git_root!,
      git_remote_url: direct.git_remote_url!,
    };
  let dir = folder.replace(/\/+$/, "");
  for (let depth = 0; dir && dir !== "/" && depth < 8; depth++) {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_user_git_root", (q) =>
        q.eq("user_id", userId).eq("git_root", dir),
      )
      .order("desc")
      .take(4);
    const hit = rows.find((c) => c.git_remote_url);
    if (hit) return { git_root: dir, git_remote_url: hit.git_remote_url! };
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return null;
}

export const getProjectInfo = query({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) return null;
    // A session started from codecast has no repo recorded until its agent
    // reports one, but the machine starting it needs the repo to find or clone
    // its checkout. The owner's earlier sessions in the same folder name it.
    const repo = conv.git_remote_url
      ? null
      : await recordedRepoForFolder(
          ctx,
          conv.user_id,
          conv.git_root ?? conv.project_path ?? null,
        );
    return {
      project_path: conv.project_path ?? null,
      git_root: conv.git_root ?? repo?.git_root ?? null,
      git_remote_url: conv.git_remote_url ?? repo?.git_remote_url ?? null,
      // Resume effort fallback: a session launched with --effort but never
      // switched in-session has no transcript echo to re-pin from; the
      // conversation row is the only durable record.
      effort: conv.effort ?? null,
      // Same for the per-session Claude account: a resume must re-source that
      // account's token file or the session hops to the keychain login.
      cc_account: conv.cc_account ?? null,
      // Lets the daemon refuse a legacy start_session that was enqueued before
      // this conversation crossed onto the fenced execution rail.
      execution_protocol_state: conv.execution_protocol_state ?? null,
    };
  },
});

export const listProjectHashes = query({
  args: { api_token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Not authenticated");

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .take(args.limit || 100);

    const hashes = new Map<
      string,
      { count: number; sample_title: string | null }
    >();
    for (const conv of conversations) {
      const hash = conv.project_hash || "__no_project__";
      const existing = hashes.get(hash);
      if (existing) {
        existing.count++;
      } else {
        hashes.set(hash, { count: 1, sample_title: conv.title || null });
      }
    }

    return Array.from(hashes.entries())
      .map(([hash, data]) => ({
        hash,
        count: data.count,
        sample_title: data.sample_title,
      }))
      .sort((a, b) => b.count - a.count);
  },
});

export const deleteByProjectHash = mutation({
  args: {
    project_hash: v.string(),
    api_token: v.optional(v.string()),
    conv_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Not authenticated");

    let convId: Id<"conversations"> | null = null;
    if (args.conv_id) {
      // Continuation branch: the id is client-supplied, so prove ownership
      // before deleting anything. Deletion is owner-only — team visibility
      // never grants it.
      const cid = ctx.db.normalizeId("conversations", args.conv_id);
      const conv = cid ? await ctx.db.get(cid) : null;
      if (!conv) return { deleted: 0, hasMore: false, conv_id: null };
      if (conv.user_id.toString() !== authUserId.toString()) {
        throw new Error("Not authorized");
      }
      convId = conv._id;
    } else {
      const convs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .take(100);
      const conv = convs.find((c) => c.project_hash === args.project_hash);
      if (!conv) return { deleted: 0, hasMore: false, conv_id: null };
      convId = conv._id;
    }

    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
      .take(50);

    for (const m of msgs) await ctx.db.delete(m._id);

    const hasMoreMsgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
      .first();

    if (!hasMoreMsgs) {
      await ctx.db.delete(convId);
      await ctx.scheduler.runAfter(
        0,
        internal.sessionDelete.purgeConversationRows,
        { conversation_id: String(convId) },
      );
      return { deleted: 1, hasMore: false, conv_id: null };
    }
    return { deleted: 0, hasMore: true, conv_id: convId };
  },
});

export const getMessageCountsForReconciliation = query({
  args: {
    session_ids: v.array(v.string()),
    // Daemon-side hints: { session_id (local JSONL UUID) → conversation_id it's
    // already bound to }. Necessary because `conversations.session_id` only
    // stores the FIRST UUID a conversation was bound to; resumed sessions get
    // new JSONL UUIDs that never appear on any conversation row, so the
    // by_session_id index returns nothing and the daemon's reconciliation
    // would falsely flag them as `missing_backend` and reset their sync
    // position — the storm fix.
    conversation_id_hints: v.optional(
      v.array(
        v.object({
          session_id: v.string(),
          conversation_id: v.id("conversations"),
        }),
      ),
    ),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const results: Array<{
      session_id: string;
      conversation_id: string;
      message_count: number;
      updated_at: number;
    }> = [];

    const hintMap = new Map<string, Id<"conversations">>();
    for (const hint of args.conversation_id_hints ?? []) {
      hintMap.set(hint.session_id, hint.conversation_id);
    }

    for (const sessionId of args.session_ids.slice(0, 100)) {
      const hintedConvId = hintMap.get(sessionId);
      const conv = hintedConvId
        ? await ctx.db.get(hintedConvId)
        : await ctx.db
            .query("conversations")
            .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
            .first();

      if (conv && conv.user_id.toString() === authUserId.toString()) {
        results.push({
          session_id: sessionId,
          conversation_id: conv._id,
          message_count: conv.message_count || 0,
          updated_at: conv.updated_at || conv._creationTime,
        });
      }
    }

    return results;
  },
});

const PATCHABLE_FIELDS = new Set<string>(PATCHABLE_CONVERSATION_FIELDS);

export const patchConversation = mutation({
  args: {
    id: v.id("conversations"),
    fields: v.any(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");

    const patch: Record<string, any> = {};
    for (const [key, value] of Object.entries(
      args.fields as Record<string, any>,
    )) {
      if (!PATCHABLE_FIELDS.has(key)) continue;
      patch[key] = value === null ? undefined : value;
    }
    Object.assign(patch, normalizeCharacterFields(patch));
    if (await pinCapExceeded(ctx, userId, conv, patch))
      throw new Error(PIN_CAP_ERROR);
    if (Object.keys(patch).length > 0) {
      await patchConversationLifecycle(ctx, args.id, patch);
    }
  },
});

// ── the browser pane an agent offers ────────────────────────────────────────
//
// `cast browser pane <url>` stamps ONE offer on the session; the viewer grows a
// chip beside the title and the reader opens it beside the conversation. The
// agent never opens anything: the web app refuses machine-initiated moves of
// what a reader is looking at (web store/viewNav.ts), and a pane that opened
// itself would be that same intrusion wearing another hat.
//
// The URL is normalized again here rather than trusted from the CLI, because
// what this field holds ends up in an iframe src: an old or hand-rolled client
// must not be able to store `javascript:` for the browser to load.
export const offerBrowserPane = mutation({
  args: {
    session: v.string(),
    url: v.string(),
    title: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const url = normalizePaneUrl(args.url);
    if (!url)
      throw new Error(`"${args.url}" is not a web address a pane can load`);

    const conv = await findConversationByAnyRefWhere(
      ctx,
      args.session,
      (c) =>
        c.user_id?.toString() === userId.toString() ||
        c.owner_user_id?.toString() === userId.toString(),
    );
    if (!conv) {
      throw new Error(
        `No session found for "${args.session}" (you can only offer a pane in sessions you run or own)`,
      );
    }

    const title = args.title?.trim().slice(0, 120) || undefined;
    await ctx.db.patch(conv._id, {
      browser_pane_offer: {
        url,
        offered_at: Date.now(),
        ...(title ? { title } : {}),
      },
    });
    return {
      ok: true as const,
      short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
      url,
      ...(title ? { title } : {}),
    };
  },
});

// The reader acted on the chip. Opening and dismissing write the same stamp on
// purpose: from the offer's point of view both mean "handled", and the only
// thing the field has to do is keep the chip from coming back here and on every
// other device.
//
// `at` is the client's clock rather than the server's, and that is deliberate:
// the web writes the same value optimistically, and the local-first field lock
// retires only when the server's echo matches what the client wrote (see the
// engine's fieldEchoesPending). A server-chosen timestamp would differ by
// milliseconds and hold the lock open.
export async function stampBrowserPaneOfferHandled(
  ctx: { db: any },
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  at: number,
): Promise<{ changed: boolean }> {
  const conv = await ctx.db.get(conversationId);
  if (!conv) throw new Error("Conversation not found");
  if (!(await canOwnerOrTeamAccess(ctx as any, userId, conv))) {
    throw new Error("Unauthorized: can only act on conversations you can see");
  }
  const offer = conv.browser_pane_offer;
  // Nothing to do twice: a second click (two windows, a re-render) must not
  // move the stamp and make a handled offer look freshly handled.
  if (!offer || offer.opened_at) return { changed: false };
  await ctx.db.patch(conv._id, {
    browser_pane_offer: { ...offer, opened_at: at },
  });
  return { changed: true };
}
