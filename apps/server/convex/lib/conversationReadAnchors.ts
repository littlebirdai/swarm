import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { checkConversationAccess } from "../privacy";

type AnchorReadCtx = Pick<QueryCtx, "db">;
type AnchorWriteCtx = Pick<MutationCtx, "db">;

export async function canReadAnchor(
  ctx: AnchorReadCtx,
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
  ctx: AnchorReadCtx,
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
  ctx: AnchorReadCtx,
  conversationId: Id<"conversations">,
  anchor: { message_id: Id<"messages">; offset: number },
) {
  if (!Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > 1)
    return null;
  const message = await ctx.db.get(anchor.message_id);
  return message?.conversation_id === conversationId ? message : null;
}

export async function mergeReadAnchor(
  ctx: AnchorWriteCtx,
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
        claim_session: undefined,
        claim_order: undefined,
        sequence: undefined,
      });
    else await ctx.db.delete(destination._id);
    await ctx.db.delete(source._id);
  } else if (anchor) {
    await ctx.db.patch(source._id, {
      user_id: userId,
      anchor,
      view_id: undefined,
      claim_session: undefined,
      claim_order: undefined,
      sequence: undefined,
    });
  } else await ctx.db.delete(source._id);
}

type SaveReadAnchorArgs = {
  conversation_id: Id<"conversations">;
  message_id: Id<"messages">;
  offset: number;
  view_id: string;
  sequence: number;
};

export async function beginReadAnchor(
  ctx: AnchorWriteCtx,
  userId: Id<"users">,
  id: unknown,
  claim?: { session: string; order: number },
) {
  if (typeof id !== "string") return null;
  const conversation_id = ctx.db.normalizeId("conversations", id);
  if (!conversation_id || !(await canReadAnchor(ctx, userId, conversation_id)))
    return null;
  if (
    claim !== undefined &&
    (!claim ||
      !Number.isSafeInteger(claim.order) ||
      claim.order <= 0 ||
      typeof claim.session !== "string" ||
      !/^[0-9a-f-]{36}$/.test(claim.session))
  )
    return null;
  const row = await readAnchorRow(ctx, userId, conversation_id);
  if (
    claim &&
    row?.claim_session === claim.session &&
    claim.order <= (row.claim_order ?? 0)
  )
    return null;
  const view_id = crypto.randomUUID();
  const visit = {
    view_id,
    claim_session: claim?.session,
    claim_order: claim?.order,
    sequence: 0,
  };
  if (row) await ctx.db.patch(row._id, visit);
  else
    await ctx.db.insert("conversation_read_anchors", {
      conversation_id,
      user_id: userId,
      ...visit,
    });
  return view_id;
}

export async function saveReadAnchor(
  ctx: AnchorWriteCtx,
  userId: Id<"users">,
  input: SaveReadAnchorArgs,
) {
  if (
    typeof input?.conversation_id !== "string" ||
    typeof input.message_id !== "string" ||
    typeof input.view_id !== "string" ||
    typeof input.sequence !== "number" ||
    typeof input.offset !== "number"
  )
    return "unavailable" as const;
  const conversation = ctx.db.normalizeId(
    "conversations",
    input.conversation_id,
  );
  const message = ctx.db.normalizeId("messages", input.message_id);
  if (
    !conversation ||
    !message ||
    !(await canReadAnchor(ctx, userId, conversation))
  )
    return "unavailable" as const;
  const args = { ...input, conversation_id: conversation, message_id: message };
  const row = await readAnchorRow(ctx, userId, args.conversation_id);
  if (
    !row ||
    row.view_id !== args.view_id ||
    !Number.isSafeInteger(args.sequence) ||
    args.sequence <= (row.sequence ?? 0)
  )
    return "stale" as const;
  if (!(await readAnchorMessage(ctx, args.conversation_id, args)))
    return "invalid" as const;
  const unchanged =
    row.anchor?.message_id === args.message_id &&
    row.anchor.offset === args.offset;
  await ctx.db.patch(row._id, {
    sequence: args.sequence,
    ...(unchanged
      ? {}
      : {
          anchor: {
            message_id: args.message_id,
            offset: args.offset,
            changed_at: Date.now(),
          },
        }),
  });
  return unchanged ? ("unchanged" as const) : ("saved" as const);
}
