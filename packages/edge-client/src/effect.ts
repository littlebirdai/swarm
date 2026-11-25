import {
  EDGE_PROTOCOL_VERSION,
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

  const hello = Effect.fn("edgeClient.hello")(function* (
    request: EdgeRequests["hello"],
  ) {
    const versions = [...request.versions];
    const result = yield* send(
      "hello",
      { ...request, versions },
      parseHelloResponse,
    );
    if (result.status !== "ok") {
      return yield* new EdgeVersionRejected({
        operation: "hello",
        reason: result.status,
        supportedVersions: result.supported_versions,
      });
    }
    if (
      result.version !== EDGE_PROTOCOL_VERSION ||
      !versions.includes(result.version)
    ) {
      return yield* new EdgeVersionRejected({
        operation: "hello",
        reason: "unexpected_version",
        supportedVersions: [result.version],
      });
    }
    return result;
  });

  const heartbeat = Effect.fn("edgeClient.heartbeat")(function* (
    request: EdgeRequests["heartbeat"],
  ) {
    return yield* send("heartbeat", request, parseHeartbeatResponse);
  });

  const claim = Effect.fn("edgeClient.claim")(function* (
    request: EdgeRequests["claim"],
  ) {
    return yield* send("claim", { ...request }, parseClaimResponse);
  });

  const renew = Effect.fn("edgeClient.renew")(function* (
    request: EdgeRequests["renew"],
  ) {
    const result = yield* send("renew", request, parseRenewResponse);
    if (result.status === "stale") {
      return yield* new ClaimLost({ operation: "renew", reason: "stale" });
    }
    return result;
  });

  const release = Effect.fn("edgeClient.release")(function* (
    request: EdgeRequests["release"],
  ) {
    return yield* send("release", request, parseReleaseResponse);
  });

  return {
    hello,
    heartbeat,
    claim,
    renew,
    release,
    withClaim: makeClaimHolder({ claim, renew, release }),
  };
}
