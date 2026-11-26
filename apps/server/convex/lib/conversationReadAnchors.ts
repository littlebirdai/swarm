import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { checkConversationAccess } from "../privacy";

export const readAnchorsEnabled = () =>
  process.env.CODECAST_SESSION_READ_ANCHORS === "1";

export async function canReadAnchor(
  ctx: QueryCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  return (
    conversation !== null &&
    (await checkConversationAccess(ctx, userId, conversation)) !== "denied"
  );
}

export function readAnchorRow(
  ctx: QueryCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
) {
  return ctx.db
    .query("conversation_read_anchors")
    .withIndex("by_user", (q) =>
      q.eq("user_id", userId).eq("conversation_id", conversationId),
    )
    .unique();
}

export async function readAnchorMessage(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  anchor: { message_id: Id<"messages">; offset: number },
) {
  if (!Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > 1)
    return null;
  const message = await ctx.db.get(anchor.message_id);
  return message?.conversation_id === conversationId ? message : null;
}

export async function saveLegacyReadAnchor(
  ctx: MutationCtx,
  presence: Doc<"doc_presence">,
) {
  if (!presence.anchor || presence.anchor_at === undefined) return;
  const conversationId = ctx.db.normalizeId(
    "conversations",
    presence.doc_id.slice("compose:".length),
  );
  const messageId = ctx.db.normalizeId("messages", presence.anchor.message_id);
  if (
    !conversationId ||
    !messageId ||
    !(await canReadAnchor(ctx, presence.user_id, conversationId))
  )
    return;
  const row = await readAnchorRow(ctx, presence.user_id, conversationId);
  if (
    row?.view_id ||
    (row?.anchor && row.anchor.changed_at >= presence.anchor_at)
  )
    return;
  const anchor = {
    message_id: messageId,
    offset: presence.anchor.offset,
    changed_at: presence.anchor_at,
  };
  if (!(await readAnchorMessage(ctx, conversationId, anchor))) return;
  if (row) await ctx.db.patch(row._id, { anchor });
  else
    await ctx.db.insert("conversation_read_anchors", {
      conversation_id: conversationId,
      user_id: presence.user_id,
      anchor,
    });
}

export async function mergeReadAnchor(
  ctx: MutationCtx,
  source: Doc<"conversation_read_anchors">,
  userId: Id<"users">,
) {
  const conversationId = source.conversation_id;
  const destination = await readAnchorRow(ctx, userId, conversationId);
  const allowed = await canReadAnchor(ctx, userId, conversationId);
  const valid = async (row: Doc<"conversation_read_anchors"> | null) =>
    allowed &&
    row?.anchor &&
    (await readAnchorMessage(ctx, conversationId, row.anchor))
      ? row.anchor
      : undefined;
  const sourceAnchor = await valid(source);
  const destinationAnchor = await valid(destination);
  const anchor =
    sourceAnchor &&
    (!destinationAnchor ||
      sourceAnchor.changed_at > destinationAnchor.changed_at)
      ? sourceAnchor
      : destinationAnchor;
  if (destination) {
    if (anchor)
      await ctx.db.patch(destination._id, {
        anchor,
        view_id: undefined,
        sequence: undefined,
      });
    else await ctx.db.delete(destination._id);
    await ctx.db.delete(source._id);
  } else if (anchor) {
    await ctx.db.patch(source._id, {
      user_id: userId,
      anchor,
      view_id: undefined,
      sequence: undefined,
    });
  } else await ctx.db.delete(source._id);
}
