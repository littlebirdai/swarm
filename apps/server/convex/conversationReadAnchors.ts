import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  canReadAnchor,
  readAnchorMessage,
  readAnchorRow,
  readAnchorsEnabled,
} from "./lib/conversationReadAnchors";

async function viewer(ctx: QueryCtx, conversationId: Id<"conversations">) {
  if (!readAnchorsEnabled()) return null;
  const userId = await getAuthUserId(ctx);
  if (!userId || !(await canReadAnchor(ctx, userId, conversationId)))
    return null;
  return userId;
}

export const get = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }) => {
    const userId = await viewer(ctx, conversation_id);
    if (!userId) return null;
    const row = await readAnchorRow(ctx, userId, conversation_id);
    if (!row?.anchor) return null;
    const message = await readAnchorMessage(ctx, conversation_id, row.anchor);
    if (!message) return null;
    return {
      _id: conversation_id,
      user_id: userId,
      ...row.anchor,
      timestamp: message.timestamp,
    };
  },
});

export const begin = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }) => {
    const userId = await viewer(ctx, conversation_id);
    if (!userId) return null;
    const row = await readAnchorRow(ctx, userId, conversation_id);
    const viewId = crypto.randomUUID();
    if (row) await ctx.db.patch(row._id, { view_id: viewId, sequence: 0 });
    else
      await ctx.db.insert("conversation_read_anchors", {
        conversation_id,
        user_id: userId,
        view_id: viewId,
        sequence: 0,
      });
    return viewId;
  },
});

export const save = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    offset: v.number(),
    view_id: v.string(),
    sequence: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await viewer(ctx, args.conversation_id);
    if (!userId) return "unavailable" as const;
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
  },
});
