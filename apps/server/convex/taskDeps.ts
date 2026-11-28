import { v } from "convex/values";
import { mutation } from "./functions";
import { cliCaller } from "./taskWaits";
import { addDepCore, removeDepCore } from "./lib/taskDeps";

export const addDep = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    blocks: v.optional(v.string()),
    blocked_by: v.optional(v.string()),
    // The session making the change: an agent's own edit wakes it for nothing (TG2).
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await addDepCore(ctx, userId, args, by);
  },
});

export const removeDep = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    blocks: v.optional(v.string()),
    blocked_by: v.optional(v.string()),
    // The session making the change: an agent's own edit wakes it for nothing (TG2).
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await removeDepCore(ctx, userId, args, by);
  },
});
