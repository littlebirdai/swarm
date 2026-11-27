import { api } from "@codecast/convex/convex/_generated/api";
import type { RelayClientOptions } from "@codecast/relay-client";
import type { ConvexReactClient } from "convex/react";
import { sync } from "./mutativeMiddleware";

type GetToken = RelayClientOptions["getToken"];

export type InboxRelayContact = {
  viewer: string;
  machine: string;
  connection: string;
  sequence: number;
  deadline: number;
};

type RelayInboxSliceDraft = {
  relayInboxCards: Record<string, number>;
  relayInboxContacts: Record<string, InboxRelayContact | undefined>;
};

export type RelayInboxSlice = {
  countRelayInboxCard: (id: string, delta: 1 | -1) => void;
  setInboxRelayContact: (id: string, contact?: InboxRelayContact) => void;
};

export function createRelayInboxSlice(): RelayInboxSlice {
  return {
    countRelayInboxCard: sync(function (
      this: RelayInboxSliceDraft,
      id: string,
      delta: 1 | -1,
    ) {
      const count = (this.relayInboxCards[id] ?? 0) + delta;
      if (count > 0) this.relayInboxCards[id] = count;
      else if (id in this.relayInboxCards) delete this.relayInboxCards[id];
    }),
    setInboxRelayContact: sync(function (
      this: RelayInboxSliceDraft,
      id: string,
      contact?: InboxRelayContact,
    ) {
      const current = this.relayInboxContacts[id];
      if (!contact) {
        if (current) delete this.relayInboxContacts[id];
      } else if (
        current?.viewer !== contact.viewer ||
        current.machine !== contact.machine ||
        current.connection !== contact.connection ||
        current.sequence < contact.sequence
      ) {
        this.relayInboxContacts[id] = contact;
      }
    }),
  } as unknown as RelayInboxSlice;
}

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
