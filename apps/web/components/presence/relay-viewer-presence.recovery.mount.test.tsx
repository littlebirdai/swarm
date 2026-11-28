import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useDocPresence } from "../../hooks/useDocPresence";
import { useInboxStore } from "../../store/inboxStore";
import { mountWeb } from "../../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
} from "../../test-helpers/relay-presence-testkit";
import { RelayPresenceProvider } from "../relay-presence-provider";
import { ConversationViewers } from "./ViewerFaces";
import { RelayStreamingReplies } from "../conversation/relay-streaming-replies";

const conversationId = "c".repeat(32) as Id<"conversations">;
const teamId = "t".repeat(32) as Id<"teams">;
const ownerId = "m".repeat(32) as Id<"users">;
const rosterPeerId = "r".repeat(32) as Id<"users">;
const firstMessageId = "1".repeat(32) as Id<"messages">;
const viewerHubId = `viewer:${conversationId}`;
const viewerHub = { kind: "session" as const, id: viewerHubId };

const { sockets, WebSocket: TestSocket } = relayMountFixture();

function baseRoster() {
  return [
    {
      _id: ownerId,
      name: "Owner User",
      email: "owner@example.com",
      presence_state: "active",
      roster_team: teamId,
    },
    {
      _id: rosterPeerId,
      name: "Bob Teammate",
      email: "bob@example.com",
      presence_state: "active",
      roster_team: teamId,
    },
  ];
}

test("useDocPresence heartbeat never writes Convex doc_presence anchors regardless of viewer target state", async () => {
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  const anchor = { message_id: firstMessageId, offset: 0.45 };
  function HeartbeatHarness({ relayMode }: { relayMode: "on" | "off" }) {
    useDocPresence({
      docId: `compose:${conversationId}`,
      draftText: "Draft",
      anchor,
      enabled: true,
      forceBroadcast: true,
    });
    return <span data-mode={relayMode} />;
  }

  let mintMode: "ok" | "unavailable" = "ok";

  const ui = await mountWeb(
    <RelayPresenceProvider>
      <HeartbeatHarness relayMode="on" />
    </RelayPresenceProvider>,
    {
      authenticated: true,
      clock: true,
      setup(backend) {
        window.WebSocket = TestSocket;
        useInboxStore.setState({
          currentUser: { _id: ownerId, name: "Owner User" } as never,
          teamMembers: baseRoster() as never,
        });
        backend.set(api.relayGrants.viewerTarget, {
          viewer: ownerId,
          hub: viewerHubId,
          tier: "member",
        });
        backend.set(api.relayGrants.viewerIdentities, []);
        backend.set(api.docSync.getPresence, []);
        backend.mutation(api.relayGrants.mint, () =>
          mintMode === "ok" ? ok : ({ status: "unavailable" } as const),
        );
        backend.mutation(api.docSync.updatePresence, undefined);
        backend.mutation(api.docSync.removePresence, undefined);
      },
    },
  );

  await ui.clock!.advance(3_000);
  mintMode = "unavailable";
  await act(() => {
    ui.backend.set(api.relayGrants.viewerTarget, null);
  });
  await ui.clock!.advance(3_000);
  const calls = ui.backend.mutations.filter(
    (m) => m.name === "docSync:updatePresence",
  );
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(
    calls.every((m) => (m.args as { anchor?: unknown }).anchor === undefined),
  ).toBe(true);
  await ui.close();
});

test("useDocPresence ignores relayViewerPresence status entries belonging to another viewer", async () => {
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  function AnchorProbe() {
    useDocPresence({
      docId: `compose:${conversationId}`,
      draftText: "Draft",
      anchor: { message_id: firstMessageId, offset: 0.45 },
      enabled: true,
      forceBroadcast: true,
    });
    return null;
  }

  const ui = await mountWeb(
    <RelayPresenceProvider>
      <AnchorProbe />
    </RelayPresenceProvider>,
    {
      authenticated: true,
      clock: true,
      setup(backend) {
        window.WebSocket = TestSocket;
        useInboxStore.setState({
          currentUser: { _id: ownerId, name: "Owner User" } as never,
          teamMembers: baseRoster() as never,
        });
        backend.set(api.relayGrants.viewerTarget, {
          viewer: ownerId,
          hub: viewerHubId,
          tier: "member",
        });
        backend.set(api.relayGrants.viewerIdentities, []);
        backend.set(api.docSync.getPresence, []);
        backend.mutation(api.relayGrants.mint, ok);
        backend.mutation(api.docSync.updatePresence, undefined);
        backend.mutation(api.docSync.removePresence, undefined);
      },
    },
  );

  await act(() => {
    useInboxStore
      .getState()
      .setRelayViewerStatus(
        conversationId,
        rosterPeerId,
        viewerHubId,
        "disabled",
      );
  });

  await ui.clock!.advance(3_000);
  const updates = ui.backend.mutations.filter(
    (m) => m.name === "docSync:updatePresence",
  );
  expect(updates.length).toBeGreaterThanOrEqual(1);
  expect(
    (updates.at(-1)?.args as { anchor?: unknown } | undefined)?.anchor,
  ).toBeUndefined();
  await ui.close();
});

test("a thrown network error on mint is retryable and recovers without marking viewer presence disabled", async () => {
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  let attempts = 0;
  function ViewerProbe() {
    return <ConversationViewers conversationId={conversationId} />;
  }

  const ui = await mountWeb(
    <RelayPresenceProvider>
      <ViewerProbe />
    </RelayPresenceProvider>,
    {
      authenticated: true,
      clock: true,
      expectedConsoleErrors: [/relayGrants:mint.*network timeout/],
      setup(backend) {
        window.WebSocket = TestSocket;
        useInboxStore.setState({
          currentUser: { _id: ownerId, name: "Owner User" } as never,
          teamMembers: baseRoster() as never,
        });
        backend.set(api.relayGrants.viewerTarget, {
          viewer: ownerId,
          hub: viewerHubId,
          tier: "member",
        });
        backend.set(api.relayGrants.viewerIdentities, []);
        backend.set(api.docSync.getPresence, []);
        backend.mutation(api.relayGrants.mint, () => {
          attempts++;
          if (attempts === 1) throw new Error("network timeout");
          return ok;
        });
      },
    },
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(attempts).toBe(1);
  expect(ui.store.getState().relayViewerPresence[conversationId]?.status).toBe(
    "unknown",
  );

  await ui.clock!.advance(1_500);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(attempts).toBe(2);
  expect(sockets.length).toBe(1);
  await act(() =>
    sockets[0].join(["presence", "draft_cursor", "reading_cursor"], viewerHub),
  );
  expect(ui.store.getState().relayViewerPresence[conversationId]?.status).toBe(
    "ready",
  );
  await ui.close();
});

test("shared viewer subscription remembers terminal unavailable for late-mounting presence subscribers", async () => {
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  function LateViewerSurface({ showViewers }: { showViewers: boolean }) {
    return (
      <RelayPresenceProvider>
        <RelayStreamingReplies
          conversationId={conversationId}
          messages={[]}
          agentStatus="working"
        />
        {showViewers ? (
          <ConversationViewers conversationId={conversationId} />
        ) : null}
      </RelayPresenceProvider>
    );
  }

  const ui = await mountWeb(<LateViewerSurface showViewers={false} />, {
    authenticated: true,
    clock: true,
    setup(backend) {
      window.WebSocket = TestSocket;
      useInboxStore.setState({
        currentUser: { _id: ownerId, name: "Owner User" } as never,
        conversations: {
          [conversationId]: {
            _id: conversationId,
            agent_type: "codex",
          },
        } as never,
        teamMembers: baseRoster() as never,
      });
      backend.set(api.relayGrants.viewerTarget, {
        viewer: ownerId,
        hub: viewerHubId,
        tier: "member",
      });
      backend.set(api.relayGrants.viewerIdentities, []);
      backend.set(api.sessionOwnership.listOwners, {
        short_id: "conv-short",
        conversation_id: conversationId,
        owners: [],
      });
      backend.mutation(api.relayGrants.mint, () => ({
        status: "unavailable" as const,
      }));
    },
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await ui.rerender(<LateViewerSurface showViewers={true} />);
  await act(async () => {
    await Promise.resolve();
  });

  expect(ui.store.getState().relayViewerPresence[conversationId]?.status).toBe(
    "unknown",
  );
  expect(
    ui.container.querySelector('[data-sv-presence-status="unknown"]'),
  ).not.toBeNull();
  expect(ui.container.textContent).toContain("Presence unknown");
  await ui.close();
});
