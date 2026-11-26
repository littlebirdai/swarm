import { v } from "convex/values";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { internalMutation, internalQuery } from "./functions";
import { bumpWindow } from "./ipRateLimit";

export const isDeviceBearer = internalQuery({
  args: { bearer: v.string() },
  handler: async (ctx, { bearer }) =>
    !!(await verifyDeviceApiToken(ctx, bearer)),
});

export const admit = internalMutation({
  args: {
    bearer: v.string(),
    machine: v.optional(v.string()),
    operation: v.optional(v.union(v.literal("renew"), v.literal("blob"))),
  },
  handler: async (ctx, { bearer, machine, operation }) => {
    const auth = await verifyDeviceApiToken(ctx, bearer);
    if (!auth || (machine !== undefined && auth.deviceId !== machine))
      return { status: "unauthorized" } as const;

    const windowMs = 60_000;
    const budget =
      operation === "renew"
        ? { scope: "edge/v1/renew", limit: 360 }
        : operation === "blob"
          ? { scope: "edge/v1/blobs", limit: 120 }
          : machine === undefined
            ? { scope: "edge/v1/work", limit: 120 }
            : { scope: "edge/v1", limit: 12 };
    const result = await bumpWindow(
      ctx.db,
      `${budget.scope}:${auth.userId}:${auth.deviceId}`,
      budget.limit,
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
