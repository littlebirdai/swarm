import {
  EDGE_PROTOCOL_VERSION,
  EXPECTED_CAPABILITY,
  STEER_BATON_CAPABILITY,
  TAKEOVER_FENCE_CAPABILITY,
  parseClaimResponse,
  parseHeartbeatResponse,
  parseHelloResponse,
  parseReleaseResponse,
  parseRenewResponse,
} from "@codecast/edge-contract";
import { Service } from "effect/Context";
import * as Effect from "effect/Effect";
import { effect } from "effect/Layer";
import { ClaimLost, EdgeVersionRejected } from "./failures";
import { makeDelivery } from "./delivery";
import { makeClaimHolder } from "./lease";
import { makeRequest } from "./request";
import type { EdgeClientOptions, EdgeRequests } from "./types";

export {
  ClaimLost,
  EdgeParseError,
  EdgeRejected,
  EdgeUnavailable,
  EdgeVersionRejected,
  type EdgeError,
} from "./failures";

export class EdgeClient extends Service<
  EdgeClient,
  ReturnType<typeof makeService>
>()("@codecast/edge-client/EdgeClient") {
  static layer(options: EdgeClientOptions) {
    return effect(
      EdgeClient,
      Effect.sync(() => makeService(options)),
    );
  }
}

function makeService(options: EdgeClientOptions) {
  const send = makeRequest(options);
  let policy: readonly string[] = [];
  let helloGeneration = 0;
  const deliverNext = makeDelivery(send, options.steering, () => policy);
  const hello = Effect.fn("edgeClient.hello")(function* (
    request: EdgeRequests["hello"],
  ) {
    const generation = ++helloGeneration;
    policy = [];
    const versions = [...request.versions];
    const capabilities = request.capabilities.filter(
      (capability) =>
        capability !== STEER_BATON_CAPABILITY &&
        capability !== TAKEOVER_FENCE_CAPABILITY,
    );
    if (options.steering) {
      if (!capabilities.includes(EXPECTED_CAPABILITY))
        capabilities.push(EXPECTED_CAPABILITY);
      capabilities.push(STEER_BATON_CAPABILITY, TAKEOVER_FENCE_CAPABILITY);
    }
    const { value } = yield* send(
      "hello",
      { ...request, versions, capabilities },
      parseHelloResponse,
    );
    if (value.status !== "ok") {
      return yield* new EdgeVersionRejected({
        operation: "hello",
        reason: value.status,
        supportedVersions: value.supported_versions,
      });
    }
    if (
      value.version !== EDGE_PROTOCOL_VERSION ||
      !versions.includes(value.version)
    ) {
      return yield* new EdgeVersionRejected({
        operation: "hello",
        reason: "unexpected_version",
        supportedVersions: [value.version],
      });
    }
    if (generation === helloGeneration)
      policy = value.policy.capabilities.filter((capability) =>
        capabilities.includes(capability),
      );
    return value;
  });
  const heartbeat = Effect.fn("edgeClient.heartbeat")(
    (request: EdgeRequests["heartbeat"]) =>
      Effect.map(
        send("heartbeat", request, parseHeartbeatResponse),
        ({ value }) => value,
      ),
  );
  const claim = Effect.fn("edgeClient.claim")(
    (request: EdgeRequests["claim"]) =>
      send("claim", { ...request }, parseClaimResponse),
  );
  const renew = Effect.fn("edgeClient.renew")(function* (
    request: EdgeRequests["renew"],
    budget?: Effect.Effect<number>,
  ) {
    const { value, started } = yield* send(
      "renew",
      request,
      parseRenewResponse,
      budget,
    );
    if (value.status === "stale") {
      return yield* new ClaimLost({ operation: "renew", reason: "stale" });
    }
    return { value, started };
  });
  const release = Effect.fn("edgeClient.release")(
    (request: EdgeRequests["release"], cleanup?: "cleanup") =>
      Effect.map(
        send("release", request, parseReleaseResponse, cleanup),
        ({ value }) => value,
      ),
  );
  return {
    hello,
    deliverNext,
    heartbeat,
    claim: (request: EdgeRequests["claim"]) =>
      Effect.map(claim(request), ({ value }) => value),
    renew: (request: EdgeRequests["renew"]) =>
      Effect.map(renew(request), ({ value }) => value),
    release: (request: EdgeRequests["release"]) => release(request),
    withClaim: makeClaimHolder({
      claim,
      renew,
      release: (request) => release(request, "cleanup"),
    }),
  };
}

export {
  TranscriptUplink,
  type TranscriptUplinkOptions,
  TranscriptUplinkError,
} from "./transcript-uplink";
export { fileTranscriptSpool, type TranscriptSpool } from "./transcript-spool";
