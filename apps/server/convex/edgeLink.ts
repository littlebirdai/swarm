import { hasDeliverableMessage } from "./lib/closeAside";
import type { ParkingInterlockResult } from "@codecast/edge-contract";
import { v } from "convex/values";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { internalMutation, internalQuery, query } from "./functions";
import { bumpWindow, takeFromWindow } from "./ipRateLimit";
import { messageValidator } from "./messages";
import { appendDeviceTranscripts } from "./lib/edge/transcript-appends.route";

export const appendTranscripts = internalMutation({
  args: {
    bearer: v.string(),
    batch_id: v.string(),
    writes: v.array(
      v.object({
        conversation_id: v.string(),
        messages: v.array(messageValidator),
        echo_ids: v.optional(v.boolean()),
      }),
    ),
  },
  handler: appendDeviceTranscripts,
});

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
      v.union(
        v.literal("renew"),
        v.literal("blob"),
        v.literal("relay_grant"),
        v.literal("transcript"),
      ),
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
            : operation === "transcript"
              ? { scope: "edge/v1/transcripts", limit: 240 }
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
  handler: async (ctx, args): Promise<ParkingInterlockResult> => {
    const auth = await verifyDeviceApiToken(ctx, args.bearer);
    if (!auth) return { status: "refused", reason: "ownership" };
    const conversation = await ctx.db.get(args.conversation_id);
    if (
      !conversation ||
      conversation.user_id !== auth.userId ||
      (conversation.owner_device_id &&
        conversation.owner_device_id !== auth.deviceId)
    )
      return { status: "refused", reason: "ownership" };
    if (conversation.execution_protocol_state)
      return { status: "refused", reason: "protocol" };
    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversation._id),
      )
      .first();
    if (
      !session ||
      session.user_id !== auth.userId ||
      session.session_id !== args.session_id
    )
      return { status: "refused", reason: "session" };
    if (!["idle", "done", "dormant"].includes(session.agent_status ?? ""))
      return { status: "refused", reason: "turn" };
    const prompt = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", conversation._id).eq("status", "pending"),
      )
      .first();
    if (prompt) return { status: "refused", reason: "prompt" };
    if (
      conversation.has_pending_messages ||
      (await hasDeliverableMessage(ctx, conversation._id))
    )
      return { status: "refused", reason: "delivery" };
    return { status: "allowed" };
  },
});
