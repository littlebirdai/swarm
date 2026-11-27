import { hasDeliverableMessage } from "./lib/closeAside";
import { v } from "convex/values";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { internalMutation, internalQuery, query } from "./functions";
import { bumpWindow, takeFromWindow } from "./ipRateLimit";

export const isDeviceBearer = internalQuery({
  args: { bearer: v.string() },
  handler: async (ctx, { bearer }) =>
    !!(await verifyDeviceApiToken(ctx, bearer)),
});

export const admit = internalMutation({
  args: {
    bearer: v.string(),
    machine: v.optional(v.string()),
    batonHello: v.optional(
      v.object({
        boot: v.string(),
        capabilities: v.array(
          v.union(v.literal("steer-baton-v1"), v.literal("takeover-fence-v1")),
        ),
      }),
    ),
    operation: v.optional(
      v.union(v.literal("renew"), v.literal("blob"), v.literal("relay_grant")),
    ),
  },
  handler: async (ctx, { bearer, machine, operation, batonHello }) => {
    const auth = await verifyDeviceApiToken(ctx, bearer);
    if (!auth || (machine !== undefined && auth.deviceId !== machine))
      return { status: "unauthorized" } as const;

    const windowMs = 60_000;
    const budget =
      operation === "renew"
        ? { scope: "edge/v1/renew", limit: 360 }
        : operation === "blob"
          ? { scope: "edge/v1/blobs", limit: 120 }
          : operation === "relay_grant"
            ? { scope: "edge/v1/relay-grant", limit: 120 }
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
    if (batonHello && machine) {
      const registration = await ctx.db
        .query("execution_daemon_boots")
        .withIndex("by_user_device", (q) =>
          q.eq("user_id", auth.userId).eq("owner_device_id", machine),
        )
        .unique();
      if (
        registration?.daemon_boot_id === batonHello.boot &&
        JSON.stringify(registration.edge_baton_hello) !==
          JSON.stringify(batonHello)
      )
        await ctx.db.patch(registration._id, { edge_baton_hello: batonHello });
    }
    return { status: "ok" } as const;
  },
});

export const admitEvents = internalMutation({
  args: { bearer: v.string(), batches: v.number() },
  handler: async (ctx, { bearer, batches }) => {
    const auth = await verifyDeviceApiToken(ctx, bearer);
    if (!auth) return { status: "unauthorized" } as const;
    const windowMs = 60_000;
    const budget = await takeFromWindow(
      ctx.db,
      `edge/v1/events:${auth.userId}:${auth.deviceId}`,
      240,
      windowMs,
      batches,
      true,
    );
    return budget.granted === batches
      ? ({ status: "ok" } as const)
      : ({
          status: "rate_limited",
          retryAfterMs: budget.retry_after_ms ?? windowMs,
        } as const);
  },
});

export const canParkSession = query({
  args: {
    bearer: v.string(),
    conversation_id: v.id("conversations"),
    session_id: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const auth = await verifyDeviceApiToken(ctx, args.bearer);
    if (!auth) return false;
    const conversation = await ctx.db.get(args.conversation_id);
    if (
      !conversation ||
      conversation.user_id !== auth.userId ||
      (conversation.owner_device_id &&
        conversation.owner_device_id !== auth.deviceId) ||
      conversation.execution_protocol_state
    )
      return false;
    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversation._id),
      )
      .first();
    if (
      !session ||
      session.user_id !== auth.userId ||
      session.session_id !== args.session_id ||
      !["idle", "done", "dormant"].includes(session.agent_status ?? "")
    )
      return false;
    const prompt = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", conversation._id).eq("status", "pending"),
      )
      .first();
    return (
      !prompt &&
      !conversation.has_pending_messages &&
      !(await hasDeliverableMessage(ctx, conversation._id))
    );
  },
});
