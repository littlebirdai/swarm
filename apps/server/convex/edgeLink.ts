import { v } from "convex/values";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { internalMutation } from "./functions";
import { bumpWindow } from "./ipRateLimit";

export const admit = internalMutation({
  args: { bearer: v.string(), machine: v.optional(v.string()) },
  handler: async (ctx, { bearer, machine }) => {
    const auth = await verifyDeviceApiToken(ctx, bearer);
    if (!auth || (machine !== undefined && auth.deviceId !== machine))
      return { status: "unauthorized" } as const;

    const windowMs = 60_000;
    const scope = machine === undefined ? "edge/v1/work" : "edge/v1";
    const result = await bumpWindow(
      ctx.db,
      `${scope}:${auth.userId}:${auth.deviceId}`,
      machine === undefined ? 120 : 12,
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
