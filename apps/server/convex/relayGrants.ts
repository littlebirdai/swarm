import {
  base64urlDecode,
  base64urlEncode,
} from "@codecast/connectors/codecastSignature";
import {
  RELAY_GRANT_VERSION,
  RELAY_MAX_GRANTS_PER_TOKEN,
  type RelayGrantClaims,
} from "@codecast/relay-contract";
import {
  EDGE_PROTOCOL_VERSION,
  isRelayGrantUrl,
} from "@codecast/edge-contract";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./functions";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import { currentClaim } from "./lib/edge/runLease";
import { presenceIdentity } from "./lib/presenceIdentity";
import { canOwnerOrTeamAccess, checkConversationAccess } from "./privacy";
import { checkRateLimit, isRateLimited, RateLimitError } from "./rateLimit";

const TTL_MS = 60_000;
const SHARED_TTL_MS = 15_000;
const VIEWER_HUB_PREFIX = "viewer:";
const VIEWER_SIGNALS = ["presence", "draft_cursor", "reading_cursor"] as const;
const MAX_VIEWER_IDENTITIES = 32;
const REQUESTS_PER_MINUTE = 120;
const relayId = /^[A-Za-z0-9_:-]{1,128}$/u;
const encoder = new TextEncoder();
const omittedHub = v.object({
  id: v.string(),
  reason: v.literal("inaccessible"),
});

function viewerHubAllowedAccess(
  access: Awaited<ReturnType<typeof checkConversationAccess>>,
) {
  return access === "owner" || access === "team" || access === "shared";
}

export const mint = mutation({
  args: {
    hubs: v.array(
      v.object({
        kind: v.literal("session"),
        id: v.string(),
      }),
    ),
  },
  returns: v.union(
    v.object({
      status: v.literal("ok"),
      token: v.string(),
      ttl_ms: v.number(),
      omitted: v.array(omittedHub),
    }),
    v.object({ status: v.literal("denied"), omitted: v.array(omittedHub) }),
    v.object({ status: v.literal("unauthenticated") }),
    v.object({ status: v.literal("unavailable") }),
    v.object({ status: v.literal("invalid_hub_count") }),
    v.object({ status: v.literal("rate_limited") }),
  ),
  handler: async (ctx, { hubs }) => {
    const config = relayGrantConfig();
    if (!config) return { status: "unavailable" } as const;

    const userId = await getAuthUserId(ctx);
    if (!userId || !(await ctx.db.get(userId)))
      return { status: "unauthenticated" } as const;
    if (hubs.length === 0 || hubs.length > RELAY_MAX_GRANTS_PER_TOKEN)
      return { status: "invalid_hub_count" } as const;

    const identity = await ctx.auth.getUserIdentity();
    const rawSessionId = await getAuthSessionId(ctx);
    const sessionId = rawSessionId
      ? ctx.db.normalizeId("authSessions", rawSessionId)
      : null;
    const session = sessionId ? await ctx.db.get(sessionId) : null;
    const jwtDeadlineMs =
      typeof identity?.exp === "number" ? identity.exp * 1000 : undefined;
    if (
      (sessionId && session?.userId !== userId) ||
      (session && !Number.isFinite(session.expirationTime)) ||
      (jwtDeadlineMs !== undefined && !Number.isFinite(jwtDeadlineMs))
    )
      return { status: "unauthenticated" } as const;
    if (
      await isRateLimited(
        ctx,
        userId,
        "relayGrants.mint",
        REQUESTS_PER_MINUTE,
        1,
      )
    )
      return { status: "rate_limited" } as const;

    try {
      const grants: RelayGrantClaims["grants"] = [];
      const omitted: { id: string; reason: "inaccessible" }[] = [];
      const viewerGrantConvs = [];
      let hasSharedTier = false;
      for (const rawId of new Set(hubs.map((hub) => hub.id))) {
        if (rawId.startsWith(VIEWER_HUB_PREFIX)) {
          const convRaw = rawId.slice(VIEWER_HUB_PREFIX.length);
          const id =
            relayId.test(rawId) && convRaw
              ? ctx.db.normalizeId("conversations", convRaw)
              : null;
          const conversation = id ? await ctx.db.get(id) : null;
          const access = conversation
            ? await checkConversationAccess(ctx, userId, conversation)
            : "denied";
          if (conversation && viewerHubAllowedAccess(access)) {
            if (access === "shared") hasSharedTier = true;
            viewerGrantConvs.push(conversation._id);
            grants.push({
              kind: "session",
              id: `${VIEWER_HUB_PREFIX}${conversation._id}`,
              publish: [...VIEWER_SIGNALS],
            });
          } else {
            omitted.push({ id: rawId, reason: "inaccessible" });
          }
          continue;
        }
        const id = relayId.test(rawId)
          ? ctx.db.normalizeId("conversations", rawId)
          : null;
        const conversation = id ? await ctx.db.get(id) : null;
        if (
          conversation &&
          (await canOwnerOrTeamAccess(ctx, userId, conversation))
        ) {
          grants.push({
            kind: "session",
            id: conversation._id,
            publish: ["presence"],
          });
        } else {
          omitted.push({ id: rawId, reason: "inaccessible" });
        }
      }
      const now = Date.now();
      const expiresAtMs = Math.floor(
        Math.min(
          now + (hasSharedTier ? SHARED_TTL_MS : TTL_MS),
          session?.expirationTime ?? Infinity,
          jwtDeadlineMs ?? Infinity,
        ),
      );
      if (expiresAtMs <= now) return { status: "unauthenticated" } as const;
      const issuance = await checkRateLimit(
        ctx,
        userId,
        "relayGrants.mint",
        REQUESTS_PER_MINUTE,
        1,
        expiresAtMs,
        now,
      );
      if (!issuance) return { status: "unavailable" } as const;
      if (!grants.length) return { status: "denied", omitted } as const;
      const { issuedAtMs, sequence } = issuance;
      const signed = await signRelayGrant(config, {
        subject: { kind: "user", id: userId },
        issued_at_ms: issuedAtMs,
        grant_seq: sequence,
        expires_at_ms: expiresAtMs,
        grants,
      });
      for (const convId of viewerGrantConvs) {
        const existingGrant = await ctx.db
          .query("relay_viewer_grants")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversation_id", convId).eq("user_id", userId),
          )
          .first();
        if (existingGrant) {
          await ctx.db.patch(existingGrant._id, { expires_at: expiresAtMs });
        } else {
          await ctx.db.insert("relay_viewer_grants", {
            conversation_id: convId,
            user_id: userId,
            expires_at: expiresAtMs,
          });
        }
      }
      return {
        status: "ok",
        token: signed,
        ttl_ms: expiresAtMs - issuedAtMs,
        omitted,
      } as const;
    } catch (error) {
      if (error instanceof RateLimitError)
        return { status: "rate_limited" } as const;
      throw new ConvexError("unavailable");
    }
  },
});

export const viewerTarget = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, { conversation_id }) => {
    if (!relayGrantConfig()) return null;
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await ctx.db.get(userId))) return null;
    const id = ctx.db.normalizeId("conversations", conversation_id);
    const conversation = id ? await ctx.db.get(id) : null;
    if (!conversation) return null;
    const access = await checkConversationAccess(ctx, userId, conversation);
    if (access === "owner" || access === "team") {
      return {
        viewer: userId,
        hub: `${VIEWER_HUB_PREFIX}${conversation._id}`,
        tier: "member" as const,
      };
    }
    if (access === "shared") {
      return {
        viewer: userId,
        hub: `${VIEWER_HUB_PREFIX}${conversation._id}`,
        tier: "shared" as const,
      };
    }
    return null;
  },
});

export const viewerIdentities = query({
  args: {
    conversation_id: v.string(),
    user_ids: v.array(v.string()),
  },
  handler: async (ctx, { conversation_id, user_ids }) => {
    if (!relayGrantConfig()) return [];
    const callerId = await getAuthUserId(ctx);
    if (!callerId || !(await ctx.db.get(callerId))) return [];
    const convId = ctx.db.normalizeId("conversations", conversation_id);
    const conversation = convId ? await ctx.db.get(convId) : null;
    if (!conversation) return [];
    const callerAccess = await checkConversationAccess(
      ctx,
      callerId,
      conversation,
    );
    if (!viewerHubAllowedAccess(callerAccess)) {
      return [];
    }
    const now = Date.now();
    const identities = [];
    for (const rawId of [...new Set(user_ids)].slice(
      0,
      MAX_VIEWER_IDENTITIES,
    )) {
      const uid = ctx.db.normalizeId("users", rawId);
      if (!uid) continue;
      const grant = await ctx.db
        .query("relay_viewer_grants")
        .withIndex("by_conversation_user", (q) =>
          q.eq("conversation_id", conversation._id).eq("user_id", uid),
        )
        .first();
      if (!grant || grant.expires_at <= now) continue;
      const user = await ctx.db.get(uid);
      if (!user) continue;
      const access = await checkConversationAccess(ctx, uid, conversation);
      if (!viewerHubAllowedAccess(access)) {
        continue;
      }
      identities.push({
        user_id: uid,
        ...presenceIdentity(user),
      });
    }
    return identities;
  },
});

export const inboxTargets = query({
  args: { ids: v.array(v.id("conversations")) },
  handler: async (ctx, { ids }) => {
    if (
      !machineRelayGrantConfig() ||
      ids.length > 4 * RELAY_MAX_GRANTS_PER_TOKEN
    )
      return null;
    const viewer = await getAuthUserId(ctx);
    if (!viewer || !(await ctx.db.get(viewer))) return null;
    const targets = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const session = await ctx.db.get(id);
        if (
          !session?.owner_device_id ||
          session.execution_protocol_state !== "fenced" ||
          isHostedAgentType(session.agent_type) ||
          !(await canOwnerOrTeamAccess(ctx, viewer, session))
        )
          return null;
        const head = await ctx.db
          .query("conversation_execution_heads")
          .withIndex("by_conversation", (q) => q.eq("conversation_id", id))
          .unique();
        const run = head?.current_epoch;
        if (
          head?.protocol_state !== "fenced" ||
          head.owner_user_id !== session.user_id ||
          head.device_move ||
          run === undefined
        )
          return null;
        const binding = await ctx.db
          .query("execution_bindings")
          .withIndex("by_conversation_epoch", (q) =>
            q.eq("conversation_id", id).eq("epoch", run),
          )
          .unique();
        if (
          binding?.state !== "ready" ||
          binding.owner_user_id !== session.user_id ||
          binding.owner_device_id !== session.owner_device_id
        )
          return null;
        return { id, run, machine: binding.owner_device_id };
      }),
    );
    return { viewer, targets: targets.filter((target) => target !== null) };
  },
});

function relayGrantConfig() {
  const audience = process.env.RELAY_AUDIENCE;
  const secret = process.env.RELAY_HMAC_KEY;
  const key = secret ? base64urlDecode(secret) : null;
  return audience &&
    relayId.test(audience) &&
    key &&
    key.length >= 32 &&
    base64urlEncode(key) === secret
    ? { audience, key }
    : null;
}

export function machineRelayGrantConfig() {
  const config = relayGrantConfig();
  const url = process.env.RELAY_PUBLIC_URL;
  return config && url && isRelayGrantUrl(url) ? { ...config, url } : null;
}

async function signRelayGrant(
  { audience, key }: NonNullable<ReturnType<typeof relayGrantConfig>>,
  claims: Omit<RelayGrantClaims, "v" | "audience">,
) {
  const payload: RelayGrantClaims = {
    v: RELAY_GRANT_VERSION,
    audience,
    ...claims,
  };
  const signingInput = `v1.${base64urlEncode(encoder.encode(JSON.stringify(payload)))}`;
  const signingKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", signingKey, encoder.encode(signingInput)),
  );
  return `${signingInput}.${base64urlEncode(signature)}`;
}

export const mintMachineLiveness = internalMutation({
  args: {
    bearer: v.string(),
    sessions: v.array(
      v.object({
        session: v.string(),
        run: v.number(),
        fencing_token: v.string(),
      }),
    ),
  },
  handler: async (ctx, { bearer, sessions }) => {
    const v = EDGE_PROTOCOL_VERSION;
    const config = machineRelayGrantConfig();
    if (!config) return { v, status: "unavailable" } as const;
    const maxSessions = Math.max(1, Math.floor(RELAY_MAX_GRANTS_PER_TOKEN / 2));
    if (
      !sessions.length ||
      sessions.length > maxSessions ||
      new Set(sessions.map(({ session }) => session)).size !== sessions.length
    )
      return { v, status: "stale" } as const;

    const now = Date.now();
    const grants: RelayGrantClaims["grants"] = [];
    let owner: Awaited<ReturnType<typeof currentClaim>> = null;
    let expires = now + TTL_MS;
    for (const { session, run, fencing_token } of sessions) {
      const claim = await currentClaim(
        ctx,
        { bearer, conversation_id: session, run, fencing_token },
        now,
      );
      if (!claim) return { v, status: "stale" } as const;
      owner ??= claim;
      expires = Math.min(expires, claim.lease.expires_at);
      grants.push(
        {
          kind: "session",
          id: claim.binding.conversation_id,
          run,
          publish: ["session_liveness"],
        },
        {
          kind: "session",
          id: `${VIEWER_HUB_PREFIX}${claim.binding.conversation_id}`,
          run,
          publish: ["token_delta"],
        },
      );
    }
    if (!owner) return { v, status: "stale" } as const;
    const { binding } = owner;
    try {
      const issuance = await checkRateLimit(
        ctx,
        binding.owner_user_id,
        `relayGrants.machine:${binding.owner_device_id}`,
        REQUESTS_PER_MINUTE,
        1,
        expires,
        now,
      );
      if (!issuance) return { v, status: "unavailable" } as const;
      return {
        v,
        status: "ok",
        url: config.url,
        token: await signRelayGrant(config, {
          subject: { kind: "machine", id: binding.owner_device_id },
          issued_at_ms: issuance.issuedAtMs,
          grant_seq: issuance.sequence,
          expires_at_ms: expires,
          grants,
        }),
        ttl_ms: expires - issuance.issuedAtMs,
      } as const;
    } catch (error) {
      if (error instanceof RateLimitError)
        return { v, status: "rate_limited" } as const;
      throw new ConvexError("unavailable");
    }
  },
});

const VIEWER_GRANT_PRUNE_LIMIT = 500;

export const pruneExpiredViewerGrants = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("relay_viewer_grants")
      .withIndex("by_expiry", (q) => q.lte("expires_at", now))
      .take(VIEWER_GRANT_PRUNE_LIMIT);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === VIEWER_GRANT_PRUNE_LIMIT) {
      await ctx.scheduler.runAfter(
        0,
        internal.relayGrants.pruneExpiredViewerGrants,
        {},
      );
    }
    return rows.length;
  },
});
