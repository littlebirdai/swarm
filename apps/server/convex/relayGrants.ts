import {
  base64urlDecode,
  base64urlEncode,
} from "@codecast/connectors/codecastSignature";
import {
  RELAY_GRANT_VERSION,
  RELAY_MAX_GRANTS_PER_TOKEN,
  type RelayGrantClaims,
} from "@codecast/relay-contract";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation } from "./functions";
import { canOwnerOrTeamAccess } from "./privacy";
import { checkRateLimit, RateLimitError } from "./rateLimit";

const TTL_MS = 60_000;
const REQUESTS_PER_MINUTE = 120;
const relayId = /^[A-Za-z0-9_:-]{1,128}$/u;
const encoder = new TextEncoder();
const omittedHub = v.object({
  id: v.string(),
  reason: v.literal("inaccessible"),
});

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
    const audience = process.env.RELAY_AUDIENCE;
    const secret = process.env.RELAY_HMAC_KEY;
    const key = secret ? base64urlDecode(secret) : null;
    if (
      !audience ||
      !relayId.test(audience) ||
      !key ||
      key.length < 32 ||
      base64urlEncode(key) !== secret
    )
      return { status: "unavailable" } as const;

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
    const now = Date.now();
    const jwtDeadlineMs =
      typeof identity?.exp === "number" ? identity.exp * 1000 : undefined;
    if (
      (sessionId && session?.userId !== userId) ||
      (session && !Number.isFinite(session.expirationTime)) ||
      (jwtDeadlineMs !== undefined && !Number.isFinite(jwtDeadlineMs))
    )
      return { status: "unauthenticated" } as const;
    const expiresAtMs = Math.floor(
      Math.min(
        now + TTL_MS,
        session?.expirationTime ?? Infinity,
        jwtDeadlineMs ?? Infinity,
      ),
    );
    if (expiresAtMs <= now) return { status: "unauthenticated" } as const;

    try {
      const issuance = await checkRateLimit(
        ctx,
        userId,
        "relayGrants.mint",
        REQUESTS_PER_MINUTE,
        1,
        expiresAtMs,
      );
      if (!issuance) return { status: "unavailable" } as const;
      const { issuedAtMs, sequence } = issuance;
      const grants: RelayGrantClaims["grants"] = [];
      const omitted: { id: string; reason: "inaccessible" }[] = [];
      for (const rawId of new Set(hubs.map((hub) => hub.id))) {
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
      if (!grants.length) return { status: "denied", omitted } as const;
      const claims: RelayGrantClaims = {
        v: RELAY_GRANT_VERSION,
        audience,
        subject: { kind: "user", id: userId },
        issued_at_ms: issuedAtMs,
        grant_seq: sequence,
        expires_at_ms: expiresAtMs,
        grants,
      };
      const signingInput = `v1.${base64urlEncode(encoder.encode(JSON.stringify(claims)))}`;
      const signingKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          signingKey,
          encoder.encode(signingInput),
        ),
      );
      return {
        status: "ok",
        token: `${signingInput}.${base64urlEncode(signature)}`,
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
