import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  beginReadAnchor,
  canReadAnchor,
  readAnchorMessage,
  readAnchorRow,
  readAnchorsEnabled,
  saveReadAnchor,
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
  args: {
    conversation_id: v.id("conversations"),
    claim: v.optional(v.object({ id: v.string(), order: v.number() })),
  },
  handler: async (ctx, { conversation_id, claim }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return beginReadAnchor(ctx, userId, conversation_id, claim);
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
    const userId = await getAuthUserId(ctx);
    if (!userId) return "unavailable" as const;
    return saveReadAnchor(ctx, userId, args);
  },
});
