import {
  EDGE_ERROR_CODES,
  EDGE_PROTOCOL_VERSION,
  negotiateEdgeVersion,
  parseClaimRequest,
  parseDeliverySettleRequest,
  parseDeliveryStartRequest,
  parseHeartbeatRequest,
  parseHelloRequest,
  parsePermitsNextRequest,
  parseReleaseRequest,
  parseRenewRequest,
  type EdgeErrorResponse,
  type EdgeParseResult,
  type HeartbeatResponse,
  type HelloResponse,
} from "@codecast/edge-contract";
import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import { httpAction, type ActionCtx } from "../../_generated/server";
import { readBodyCapped } from "../tokenHttp";

const policy = {
  revision: 1,
  heartbeat_interval_ms: 30_000,
  uplink_interval_ms: 250,
  limits: {
    max_batch_events: 100,
    max_batch_bytes: 1_048_576,
    max_blob_bytes: 8_388_608,
  },
  capabilities: ["heartbeat"],
};
const supportedVersions = new Set([EDGE_PROTOCOL_VERSION]);

function edgeError(
  status: number,
  code: string,
  retryable = false,
  retryAfterMs?: number,
): Response {
  const body: EdgeErrorResponse = {
    v: EDGE_PROTOCOL_VERSION,
    status: "error",
    code,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
  };
  return Response.json(body, {
    status,
    headers:
      retryAfterMs === undefined
        ? undefined
        : { "Retry-After": String(Math.ceil(retryAfterMs / 1_000)) },
  });
}

function linkAction<T extends { machine: string }>(
  parse: (body: unknown) => EdgeParseResult<T>,
  reply: (body: T) => HelloResponse | HeartbeatResponse,
) {
  return httpAction(async (ctx, request) => {
    if (process.env.CODECAST_EDGE_V1 !== "1")
      return new Response(null, { status: 404 });
    const bearer = request.headers
      .get("Authorization")
      ?.match(/^Bearer (\S+)$/i)?.[1];
    if (!bearer) return edgeError(401, EDGE_ERROR_CODES.UNAUTHORIZED);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return edgeError(400, EDGE_ERROR_CODES.INVALID);
    }
    const parsed = parse(body);
    if (!parsed.ok) return edgeError(400, EDGE_ERROR_CODES.INVALID);

    try {
      const admission = await ctx.runMutation(internal.edgeLink.admit, {
        bearer,
        machine: parsed.value.machine,
      });
      if (admission.status === "unauthorized")
        return edgeError(401, EDGE_ERROR_CODES.UNAUTHORIZED);
      if (admission.status === "rate_limited")
        return edgeError(
          429,
          EDGE_ERROR_CODES.RATE_LIMITED,
          true,
          admission.retryAfterMs,
        );
    } catch {
      return edgeError(503, EDGE_ERROR_CODES.UNAVAILABLE, true);
    }
    return Response.json(reply(parsed.value));
  });
}

function workAction<T>(
  parse: (body: unknown) => EdgeParseResult<T>,
  run: (
    ctx: ActionCtx,
    bearer: string,
    body: T,
  ) => Promise<{
    status: string;
    retry_after_ms?: number;
  }>,
) {
  return httpAction(async (ctx, request) => {
    if (process.env.CODECAST_EDGE_DELIVERY_V1 !== "1") {
      const { pathname } = new URL(request.url);
      return new Response(`No HttpAction routed for ${pathname}`, {
        status: 404,
      });
    }
    const bearer = request.headers
      .get("Authorization")
      ?.match(/^Bearer (\S+)$/i)?.[1];
    if (!bearer) return edgeError(401, EDGE_ERROR_CODES.UNAUTHORIZED);

    let body: unknown;
    try {
      const bytes = await readBodyCapped(request, 64 * 1024);
      if (!bytes) return edgeError(413, EDGE_ERROR_CODES.TOO_LARGE);
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return edgeError(400, EDGE_ERROR_CODES.INVALID);
    }
    const parsed = parse(body);
    if (!parsed.ok) return edgeError(400, EDGE_ERROR_CODES.INVALID);

    try {
      const admission = await ctx.runMutation(internal.edgeLink.admit, {
        bearer,
      });
      if (admission.status === "unauthorized")
        return edgeError(401, EDGE_ERROR_CODES.UNAUTHORIZED);
      if (admission.status === "rate_limited")
        return edgeError(
          429,
          EDGE_ERROR_CODES.RATE_LIMITED,
          true,
          admission.retryAfterMs,
        );

      const response = await run(ctx, bearer, parsed.value);
      const retryAfter = response.retry_after_ms;
      return Response.json(response, {
        headers:
          retryAfter === undefined
            ? undefined
            : { "Retry-After": String(Math.ceil(retryAfter / 1_000)) },
      });
    } catch (error) {
      if (
        error instanceof ConvexError &&
        error.data === "edge-delivery-unsupported"
      )
        return edgeError(422, EDGE_ERROR_CODES.INVALID);
      return edgeError(503, EDGE_ERROR_CODES.UNAVAILABLE, true, 1_000);
    }
  });
}

export function registerEdgeRoutes(http: HttpRouter) {
  http.route({
    path: "/edge/v1/hello",
    method: "POST",
    handler: linkAction(parseHelloRequest, (body): HelloResponse => {
      const version = negotiateEdgeVersion(body.versions, supportedVersions);
      if (version.status !== "ok") return version;
      return {
        ...version,
        policy: {
          ...policy,
          capabilities: policy.capabilities.filter((capability) =>
            body.capabilities.includes(capability),
          ),
        },
      };
    }),
  });
  http.route({
    path: "/edge/v1/heartbeat",
    method: "POST",
    handler: linkAction(parseHeartbeatRequest, (): HeartbeatResponse => ({
      v: EDGE_PROTOCOL_VERSION,
      policy_revision: policy.revision,
    })),
  });
  http.route({
    path: "/edge/v1/claim",
    method: "POST",
    handler: workAction(
      parseClaimRequest,
      (ctx, bearer, { session, machine, boot, claim_id }) =>
        ctx.runMutation(internal.edgeRunLease.claim, {
          bearer,
          conversation_id: session,
          machine,
          boot,
          claim_id,
        }),
    ),
  });
  http.route({
    path: "/edge/v1/renew",
    method: "POST",
    handler: workAction(
      parseRenewRequest,
      (ctx, bearer, { session, run, fencing_token }) =>
        ctx.runMutation(internal.edgeRunLease.renew, {
          bearer,
          conversation_id: session,
          run,
          fencing_token,
        }),
    ),
  });
  http.route({
    path: "/edge/v1/release",
    method: "POST",
    handler: workAction(
      parseReleaseRequest,
      (ctx, bearer, { session, run, fencing_token }) =>
        ctx.runMutation(internal.edgeRunLease.release, {
          bearer,
          conversation_id: session,
          run,
          fencing_token,
        }),
    ),
  });
  http.route({
    path: "/edge/v1/permits.next",
    method: "POST",
    handler: workAction(parsePermitsNextRequest, (ctx, bearer, body) =>
      ctx.runMutation(internal.edgeDelivery.next, { ...body, bearer }),
    ),
  });
  http.route({
    path: "/edge/v1/delivery.start",
    method: "POST",
    handler: workAction(parseDeliveryStartRequest, (ctx, bearer, body) =>
      ctx.runMutation(internal.edgeDelivery.start, { ...body, bearer }),
    ),
  });
  http.route({
    path: "/edge/v1/delivery.settle",
    method: "POST",
    handler: workAction(parseDeliverySettleRequest, (ctx, bearer, body) => {
      if (
        body.outcome === "stale" ||
        body.outcome === "rejected" ||
        (body.outcome === "failed" && !body.retryable)
      )
        throw new ConvexError("edge-delivery-unsupported");
      return ctx.runMutation(internal.edgeDelivery.settle, {
        ...body,
        outcome: body.outcome,
        retryable: body.outcome === "failed" ? true : undefined,
        bearer,
      });
    }),
  });
}
