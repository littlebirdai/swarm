import { sanitizeConvexObjectKeys } from "./convexFieldNames";
import { query, type QueryCtx, type MutationCtx } from "../functions";
import { titleLine } from "@codecast/messages/machineMessages";
import { resolveConversationRefRanked } from "../conversationSessionLookup";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "../_generated/dataModel";
import { verifyApiToken } from "../apiTokens";
import {
  isTeamMember,
  canTeamMemberAccess,
  canTeamMemberReadSummary,
  checkConversationAccess,
  isConversationOwner,
  type AccessLevel,
} from "../privacy";
import { activeTeamMembershipFor } from "./access";
import { formatSlugAsTitle } from "./conversationBasics";

// Hard cap on per-field diff size stored on conversation rows. Daemon already
// truncates at 100KB before send, but the server defends against any future
// client that bypasses that. Oversized diffs blow the Convex isolate's 96 MiB
// memory limit when collateral queries (heartbeat, webListPaginated, webList)
// do `ctx.db.get(conversationId)` and pull the whole row.
const MAX_GIT_DIFF_SIZE = 100_000;

function truncateGitDiff(s: string | undefined): string | undefined {
  return s && s.length > MAX_GIT_DIFF_SIZE ? s.slice(0, MAX_GIT_DIFF_SIZE) : s;
}

// Upsert the git side row for a conversation. The diff blobs and the status
// text live off the conversations hot doc (see conversation_git_diffs in
// schema.ts): the inbox scan reads every candidate doc in full, so any bytes a
// list never renders are paid on every recompute. Only getConversationGitDiff
// reads them. Deletes the row when everything is empty.
export async function setConvGitDiff(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  gitDiff: string | undefined,
  gitDiffStaged: string | undefined,
  gitStatus?: string,
) {
  const diff = truncateGitDiff(gitDiff);
  const staged = truncateGitDiff(gitDiffStaged);
  const status = truncateGitDiff(gitStatus);
  const existing = await ctx.db
    .query("conversation_git_diffs")
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversationId),
    )
    .first();
  if (!diff && !staged && !status) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (existing) {
    await ctx.db.patch(existing._id, {
      git_diff: diff,
      git_diff_staged: staged,
      git_status: status,
      updated_at: Date.now(),
    });
  } else {
    await ctx.db.insert("conversation_git_diffs", {
      conversation_id: conversationId,
      git_diff: diff,
      git_diff_staged: staged,
      git_status: status,
      updated_at: Date.now(),
    });
  }
}

// Upsert / read the stable-context side row (conversation_context). Same
// hot-doc rationale as the git side row; the sweep in debugTmp moves legacy
// on-doc values here.
export async function setConvStableContext(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  data: string,
) {
  const existing = await ctx.db
    .query("conversation_context")
    .withIndex("by_conversation_id", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      stable_context: data,
      updated_at: Date.now(),
    });
  } else {
    await ctx.db.insert("conversation_context", {
      conversation_id: conversationId,
      stable_context: data,
      updated_at: Date.now(),
    });
  }
}

export async function getConvStableContext(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<string | null> {
  const row = await ctx.db
    .query("conversation_context")
    .withIndex("by_conversation_id", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .first();
  return row?.stable_context ?? null;
}

// Read the git side row (conversation_git_diffs). Blobs no longer live on the
// conversation doc.
export async function getConvGitDiff(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
): Promise<{
  git_diff: string | null;
  git_diff_staged: string | null;
  git_status: string | null;
}> {
  const row = await ctx.db
    .query("conversation_git_diffs")
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversationId),
    )
    .first();
  return {
    git_diff: row?.git_diff ?? null,
    git_diff_staged: row?.git_diff_staged ?? null,
    git_status: row?.git_status ?? null,
  };
}

export async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

export async function getAuthenticatedUserIdReadOnly(
  ctx: { db: any },
  apiToken?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken, false);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

function resolveUserSkills(
  userSkillsJson: string | undefined,
  projectPath: string | undefined | null,
): string | undefined {
  if (!userSkillsJson) return undefined;
  try {
    const parsed = JSON.parse(userSkillsJson);
    if (Array.isArray(parsed)) return userSkillsJson;
    const global: Array<{ name: string }> = parsed["global"] || [];
    const project: Array<{ name: string }> = projectPath
      ? parsed[projectPath] || []
      : [];
    const seen = new Set<string>();
    const merged = [];
    for (const s of [...global, ...project]) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        merged.push(s);
      }
    }
    return merged.length > 0 ? JSON.stringify(merged) : undefined;
  } catch {
    return userSkillsJson;
  }
}

/**
 * Stable context is a snapshot of the owner's recent solo/team feed, not part
 * of the shared conversation itself. It can contain unrelated session titles,
 * teammate names, full project paths, and private conversation ids. Preserve it
 * for authenticated owner/team views, but never let a share token turn that
 * feed snapshot into public data.
 */
export function conversationForAccess<T extends Record<string, any>>(
  conversation: T,
  // "summary": a teammate the session is shared with as a summary. They get
  // the share-link shape minus every field that quotes the conversation.
  access: AccessLevel | "summary",
): T {
  if (access === "owner") return conversation;
  if (access === "summary") {
    const summary: Record<string, any> = conversationForAccess(
      conversation,
      "shared",
    );
    for (const key of SUMMARY_HIDDEN_CONVERSATION_FIELDS) delete summary[key];
    return summary as T;
  }
  if (access === "team") {
    if (!("peer_transfer" in conversation)) return conversation;
    const { peer_transfer: _ownerOnly, ...teamConversation } = conversation;
    return teamConversation as T;
  }
  const publicConversation: Record<string, any> = { ...conversation };
  for (const key of SHARE_HIDDEN_CONVERSATION_FIELDS)
    delete publicConversation[key];
  if (typeof publicConversation.git_remote_url === "string") {
    publicConversation.git_remote_url = stripUrlCredentials(
      publicConversation.git_remote_url,
    );
  }
  return publicConversation as T;
}

/**
 * Conversation fields a share-link viewer never gets: the owner's machine,
 * accounts, team, unsent draft, launch flags and host paths. The read-only
 * share view draws none of them; they only describe the owner's setup.
 */
const SHARE_HIDDEN_CONVERSATION_FIELDS = [
  "stable_context",
  "team_id",
  "owner_device_id",
  "subagent_slot_device",
  "cc_account",
  "cc_account_auto",
  "cc_account_model_pin",
  "codex_account",
  "cli_flags",
  "draft_message",
  "fork_daemon_args",
  "local_mirror",
  "migration",
  "cloud_placement_token",
  "cloud_seed",
  "cloud_checkout_path",
  "worktree_path",
  "needs_input_notified_key",
  "hand_wake_notified_key",
  "title_embedding",
  "peer_transfer",
] as const;

/**
 * A session its viewer's team sees as a summary: what it was about (title,
 * summary, status, owner), none of its content. Null when the viewer may not
 * see even that. `content_access: "summary"` tells the page to draw the
 * summary in place of a transcript.
 */
export async function summaryOnlyConversation(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
  conversation: Doc<"conversations">,
) {
  if (
    !viewerId ||
    !(await canTeamMemberReadSummary(ctx, viewerId, conversation))
  )
    return null;
  const owner = await ctx.db.get(conversation.user_id);
  return sanitizeConvexObjectKeys({
    ...conversationForAccess(conversation, "summary"),
    title:
      conversation.title ||
      (conversation.slug
        ? formatSlugAsTitle(conversation.slug)
        : "New Session"),
    user: conversationAuthorForAccess(owner, "shared"),
    content_access: "summary" as const,
  });
}

/** Conversation fields that quote the conversation itself: a teammate who
 *  sees a session as a summary never gets them. */
const SUMMARY_HIDDEN_CONVERSATION_FIELDS = [
  "first_prompt",
  "last_message_preview",
  "image_preview_url",
  "last_comment_excerpt",
] as const;

/** A remote URL without its user:password@ part (an https remote can carry a token). */
function stripUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** The session author as the viewer may see them. A share-link viewer gets the
 *  name the UI would draw (name, else the email's local part) and the avatar,
 *  never the email itself. */
export function conversationAuthorForAccess(
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    github_avatar_url?: string | null;
  } | null,
  access: AccessLevel,
) {
  if (!user) return null;
  const avatar_url = user.image || user.github_avatar_url || null;
  if (access === "owner" || access === "team")
    return { name: user.name, email: user.email, avatar_url };
  return { name: user.name || user.email?.split("@")[0], avatar_url };
}

// The parent a caller may link a conversation under: one they own (runner,
// primary owner, or an assigned owner), else none. Takes the raw string a
// client sent; an id of another table or a malformed one resolves to none.
export async function ownedParentConversationId(
  ctx: { db: any },
  userId: Id<"users">,
  parentRef: string | undefined,
): Promise<Id<"conversations"> | undefined> {
  if (!parentRef) return undefined;
  const parentId = ctx.db.normalizeId
    ? ctx.db.normalizeId("conversations", parentRef)
    : (parentRef as Id<"conversations">);
  if (!parentId) return undefined;
  let parent: any = null;
  try {
    parent = await ctx.db.get(parentId);
  } catch {
    return undefined;
  }
  if (!parent || !(await isConversationOwner(ctx, userId, parent)))
    return undefined;
  return parent._id;
}

/** A session title as stored: paste markers out, one line. Undefined when nothing is left. */
export function storedTitle(title: string | undefined): string | undefined {
  return title === undefined ? undefined : titleLine(title) || undefined;
}

// An anchor's session renders under its bot identity (acting_user_id), not the
// human host that runs and bills it. Resolve that identity for the author chip;
// returns null for ordinary sessions so callers fall back to the owner. Cheap:
// only anchors set acting_user_id, so the extra read is sparse.
export async function resolveActingAuthor(
  ctx: any,
  conv: { acting_user_id?: Id<"users"> | null },
  getDoc: (id: any) => Promise<any> = (id) => ctx.db.get(id),
): Promise<{ name: string; avatar: string | null } | null> {
  if (!conv.acting_user_id) return null;
  const bot = await getDoc(conv.acting_user_id);
  if (!bot) return null;
  return {
    name: (bot as any).name || "Workspace agent",
    avatar: (bot as any).image || (bot as any).github_avatar_url || null,
  };
}

// Resolve a conversation reference (full id or 7-char short id) for a signed-in
// caller. Short ids collide across users (they're just the id's first 7 chars),
// so this ranks candidates own > team-accessible > newest via the shared
// resolver, keeping "found but not accessible" distinguishable from "not
// found" — callers still run their usual access check on the result.
export async function resolveConversationRef(
  ctx: any,
  ref: string,
  userId: Id<"users">,
): Promise<Doc<"conversations"> | null> {
  return resolveConversationRefRanked(ctx, ref, userId, (conversation) =>
    canTeamMemberAccess(ctx, userId, conversation),
  );
}

/**
 * A session spawned by `scopeId` that its owner link-shared, read by a viewer
 * who can open `scopeId` (with `scopeToken` presented, or a redemption). This
 * is how a shared parent's page names and opens its shared workers: the
 * child's own link is the grant, and the viewer receives it only from inside
 * the parent, so an unshared child stays private and rotating the child's
 * link revokes it here too.
 */
export async function isSharedChildOf(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
  conv: Doc<"conversations">,
  scopeId: string | undefined,
  scopeToken: string | undefined,
): Promise<boolean> {
  if (!scopeId || !conv.share_token) return false;
  const parentId =
    conv.parent_conversation_id ?? conv.spawned_by_conversation_id;
  if (!parentId || parentId.toString() !== scopeId) return false;
  const parent = await ctx.db.get(parentId);
  return (
    !!parent &&
    (await checkConversationAccess(ctx, viewerId, parent, scopeToken)) !==
      "denied"
  );
}

// The conversation reads a transcript view subscribes to take their id as
// v.string, not v.id: it arrives raw from a URL (the inbox `?s=` deep link, a
// pane path) and the client's isConvexId guard is format-only. A 32-char id
// from another table (a message id, seen in prod) must read as not found
// instead of an ArgumentValidationError thrown into the subscriber's render.
export async function getConversationByRawId(ctx: QueryCtx, raw: string) {
  const id = ctx.db.normalizeId("conversations", raw);
  return id ? await ctx.db.get(id) : null;
}

// A user turn delivered by a teammate (web or `cast send` into someone else's
// session) carries from_user_id — the sender, stamped when the echo is matched
// to its pending row. Attach that sender's display identity so the UI renders
// the turn as them instead of the conversation owner. Owner turns stay bare,
// so the payload only grows for the rare cross-user message.
export async function attachSenderIdentities<
  T extends { role?: string; from_user_id?: Id<"users"> },
>(
  ctx: { db: { get: (id: Id<"users">) => Promise<any> } },
  ownerUserId: Id<"users">,
  messages: T[],
): Promise<T[]> {
  const senderIds = new Set<string>();
  for (const m of messages) {
    if (
      m.role === "user" &&
      m.from_user_id &&
      m.from_user_id.toString() !== ownerUserId.toString()
    ) {
      senderIds.add(m.from_user_id.toString());
    }
  }
  if (senderIds.size === 0) return messages;
  const senders = new Map<
    string,
    { name: string; avatar_url: string | null }
  >();
  for (const id of senderIds) {
    const u = await ctx.db.get(id as Id<"users">);
    if (u) {
      senders.set(id, {
        name: u.name || u.email?.split("@")[0] || "Unknown",
        avatar_url: u.image || u.github_avatar_url || null,
      });
    }
  }
  return messages.map((m) => {
    const sender = m.from_user_id
      ? senders.get(m.from_user_id.toString())
      : undefined;
    return sender
      ? { ...m, sender_name: sender.name, sender_avatar_url: sender.avatar_url }
      : m;
  });
}

/**
 * Attach a spooled stable-context record (parked by recordStableContext when
 * no conversation carried the session id yet) to its now-known conversation.
 * Doesn't clobber an existing record — the direct recordStableContext patch is
 * fresher. Also lazily prunes this user's stale spool rows so the transient
 * table can't grow unbounded.
 */
export async function consumeStableContextSpool(
  ctx: { db: any },
  userId: Id<"users">,
  sessionId: string,
  conversationId: Id<"conversations">,
): Promise<void> {
  const spooled = await ctx.db
    .query("stable_context_spool")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
    .filter((q: any) => q.eq(q.field("user_id"), userId))
    .first();
  if (spooled) {
    const conv = await ctx.db.get(conversationId);
    // Don't clobber an existing record (side row, or a legacy on-doc value not
    // yet swept) — the direct recordStableContext write is fresher.
    if (
      conv &&
      !conv.stable_context &&
      !(await getConvStableContext(ctx, conversationId))
    ) {
      await setConvStableContext(ctx, conversationId, spooled.data);
    }
    await ctx.db.delete(spooled._id);
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = await ctx.db
    .query("stable_context_spool")
    .withIndex("by_user_created", (q: any) =>
      q.eq("user_id", userId).lt("created_at", cutoff),
    )
    .take(20);
  for (const row of stale) {
    if (row.created_at < cutoff) await ctx.db.delete(row._id);
  }
}

// Resolve which team the inbox "team mode" scopes to, membership-gated. A client
// may pass any activeTeamId, so this is a real access check, not a hint: the
// caller must actually belong to the team or nothing is returned. Falls back to
// the user's active/default team when no explicit team is passed.
export async function resolveInboxTeamScope(
  ctx: any,
  userId: Id<"users">,
  activeTeamId?: Id<"teams">,
): Promise<Id<"teams"> | null> {
  if (activeTeamId) {
    return (await isTeamMember(ctx, userId, activeTeamId))
      ? activeTeamId
      : null;
  }
  // No team named: the one the user is working in, through the one resolver
  // that reads that pointer and proves the membership behind it.
  return (await activeTeamMembershipFor(ctx, userId))?.teamId ?? null;
}
