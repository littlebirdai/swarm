import {
  EDGE_ERROR_CODES,
  EDGE_PROTOCOL_VERSION,
  negotiateEdgeVersion,
  parseBlobsGetRequest,
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
import { MAX_EDGE_BLOB_BYTES } from "./blob-policy.rules";

const policy = {
  revision: 1,
  heartbeat_interval_ms: 30_000,
  uplink_interval_ms: 250,
  limits: {
    max_batch_events: 100,
    max_batch_bytes: 1_048_576,
    max_blob_bytes: MAX_EDGE_BLOB_BYTES,
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
  ) => Promise<
    | Response
    | {
        status: string;
        retry_after_ms?: number;
      }
  >,
  operation?: "renew" | "blob",
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
      if (!(await ctx.runQuery(internal.edgeLink.isDeviceBearer, { bearer })))
        return edgeError(401, EDGE_ERROR_CODES.UNAUTHORIZED);
      const admission = await ctx.runMutation(internal.edgeLink.admit, {
        bearer,
        operation,
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
      if (response instanceof Response) return response;
      const retryAfter = response.retry_after_ms;
      return Response.json(response, {
        headers:
          retryAfter === undefined
            ? undefined
            : { "Retry-After": String(Math.ceil(retryAfter / 1_000)) },
      });
    } catch (error) {
      if (error instanceof ConvexError) {
        if (error.data === EDGE_ERROR_CODES.INVALID)
          return edgeError(422, EDGE_ERROR_CODES.INVALID);
        if (error.data === EDGE_ERROR_CODES.NOT_FOUND)
          return edgeError(404, EDGE_ERROR_CODES.NOT_FOUND);
        if (error.data === EDGE_ERROR_CODES.TOO_LARGE)
          return edgeError(413, EDGE_ERROR_CODES.TOO_LARGE);
        if (error.data === "resolution_evidence_required")
          return edgeError(422, error.data);
      }
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
      "renew",
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
    path: "/edge/v1/blobs.get",
    method: "POST",
    handler: workAction(
      parseBlobsGetRequest,
      async (ctx, bearer, body) => {
        const query = { ...body, bearer };
        const image = await ctx.runQuery(internal.edgeDelivery.getBlob, query);
        if (!image) return edgeError(404, EDGE_ERROR_CODES.NOT_FOUND);
        const blob = await ctx.storage.get(image.storageId);
        if (!blob) return edgeError(404, EDGE_ERROR_CODES.NOT_FOUND);
        if (blob.size > MAX_EDGE_BLOB_BYTES)
          return edgeError(413, EDGE_ERROR_CODES.TOO_LARGE);
        const bytes = await readBodyCapped(
          new Response(blob.stream()),
          MAX_EDGE_BLOB_BYTES,
        );
        if (!bytes) return edgeError(413, EDGE_ERROR_CODES.TOO_LARGE);
        const refreshed = await ctx
          .runQuery(internal.edgeDelivery.getBlob, query)
          .catch((error: unknown) => {
            if (error instanceof ConvexError) return null;
            throw error;
          });
        if (
          !refreshed ||
          refreshed.storageId !== image.storageId ||
          refreshed.contentType !== image.contentType
        )
          return edgeError(404, EDGE_ERROR_CODES.NOT_FOUND);
        return new Response(bytes.buffer as ArrayBuffer, {
          headers: {
            "Content-Type": image.contentType,
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "attachment",
            "Cache-Control": "private, no-store",
          },
        });
      },
      "blob",
    ),
  });
  http.route({
    path: "/edge/v1/delivery.settle",
    method: "POST",
    handler: workAction(parseDeliverySettleRequest, (ctx, bearer, body) => {
      if (body.outcome === "stale")
        throw new ConvexError(EDGE_ERROR_CODES.INVALID);
      return ctx.runMutation(internal.edgeDelivery.settle, {
        ...body,
        outcome: body.outcome,
        bearer,
      });
    }),
  });
}
