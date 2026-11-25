import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { internalMutation } from "./functions";
import { bumpWindow } from "./ipRateLimit";

export const admit = internalMutation({
  args: { bearer: v.string(), machine: v.string() },
  handler: async (ctx, { bearer, machine }) => {
    const auth = await verifyApiToken(ctx, bearer);
    if (!auth) return { status: "unauthorized" } as const;
    const token = await ctx.db.get(auth.tokenId);
    if (token?.device_id !== machine)
      return { status: "unauthorized" } as const;

    const windowMs = 60_000;
    const result = await bumpWindow(
      ctx.db,
      `edge/v1:${auth.userId}:${machine}`,
      12,
      windowMs,
    );
    if (!result.ok)
      return {
        status: "rate_limited",
        retryAfterMs: result.retry_after_ms ?? windowMs,
      } as const;
    return { status: "ok" } as const;
  },
});
