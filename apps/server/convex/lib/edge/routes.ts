import {
  EDGE_ERROR_CODES,
  EDGE_PROTOCOL_VERSION,
  negotiateEdgeVersion,
  parseHeartbeatRequest,
  parseHelloRequest,
  type EdgeErrorResponse,
  type EdgeParseResult,
  type HeartbeatResponse,
  type HelloResponse,
} from "@codecast/edge-contract";
import type { HttpRouter } from "convex/server";
import { internal } from "../../_generated/api";
import { httpAction } from "../../_generated/server";

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
}
