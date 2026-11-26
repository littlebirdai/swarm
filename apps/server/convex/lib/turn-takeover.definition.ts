import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation } from "../functions";
import { isConversationOwner } from "../privacy";

export const requestTurnTakeover = mutation({
  args: { conversation_id: v.id("conversations") },
  returns: v.union(
    v.object({ status: v.literal("refused") }),
    v.object({
      status: v.literal("not_available"),
      reason: v.union(
        v.literal("disabled"),
        v.literal("machine_fence_required"),
      ),
    }),
  ),
  handler: async (ctx, { conversation_id }) => {
    if (process.env.SWARM_TURN_BATON !== "1") {
      return { status: "not_available", reason: "disabled" } as const;
    }
    const user = await getAuthUserId(ctx);
    if (!user) return { status: "refused" } as const;
    const conversation = await ctx.db.get(conversation_id);
    if (
      !conversation ||
      !(await isConversationOwner(ctx, user, conversation))
    ) {
      return { status: "refused" } as const;
    }
    return {
      status: "not_available",
      reason: "machine_fence_required",
    } as const;
  },
});
