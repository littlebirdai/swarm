import { api } from "@codecast/convex/convex/_generated/api";
import type { RelayClientOptions } from "@codecast/relay-client";
import type { ConvexReactClient } from "convex/react";

type GetToken = RelayClientOptions["getToken"];

export function relayGrantAction(viewerId: () => string | undefined) {
  return async (
    convex: Pick<ConvexReactClient, "mutation">,
    account: string,
    url: string,
    hubs: Parameters<GetToken>[0],
    signal: AbortSignal,
  ): ReturnType<GetToken> => {
    const stillCurrent = () => !signal.aborted && viewerId() === account;
    if (!stillCurrent()) return { status: "unauthenticated" };
    try {
      const result = await convex.mutation(api.relayGrants.mint, {
        hubs: hubs.flatMap((hub) =>
          hub.kind === "session" ? [{ kind: hub.kind, id: hub.id }] : [],
        ),
      });
      if (!stillCurrent()) return { status: "unauthenticated" };
      return result.status === "ok" ? { ...result, url } : result;
    } catch {
      return { status: "unavailable" };
    }
  };
}
