import { expect, test } from "bun:test";
import { Profiler, act, useRef, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { RelayEvent } from "@codecast/relay-client";
import { useLiveComposerControl } from "../../hooks/use-live-composer-control";
import { useSyncRelayViewerPresence } from "../../hooks/use-sync-relay-viewer-presence";
import { useSharedDraft } from "../../hooks/useSharedDraft";
import {
  DATA_SCOPE,
  REPLICATION_CLASSIFICATION,
  isPersistedClientStoreKey,
} from "../../store/clientSyncRegistry";
import { useInboxStore } from "../../store/inboxStore";
import { applyRelayViewerSignal } from "../../store/relay-viewer-presence-slice";
import { mountWeb } from "../../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
} from "../../test-helpers/relay-presence-testkit";
import { OwnerComposerPresence } from "../collab-composer";
import { GhostDrafts } from "../conversation/GhostDrafts";
import { ReaderFaces, ReadingMarks } from "../conversation/ReadingMarks";
import { RelayPresenceProvider } from "../relay-presence-provider";
import { ConversationViewers } from "./ViewerFaces";

type RelaySessionHub = { kind: "session"; id: string };

const conversationId = "c".repeat(32) as Id<"conversations">;
const secondConversationId = "d".repeat(32) as Id<"conversations">;
const teamId = "t".repeat(32) as Id<"teams">;
const ownerId = "m".repeat(32) as Id<"users">;
const lowPeerId = "a".repeat(32) as Id<"users">;
const rosterPeerId = "r".repeat(32) as Id<"users">;
const guestPeerId = "z".repeat(32) as Id<"users">;
const firstMessageId = "1".repeat(32) as Id<"messages">;
const secondMessageId = "2".repeat(32) as Id<"messages">;
const viewerHubId = `viewer:${conversationId}`;
const secondViewerHubId = `viewer:${secondConversationId}`;
const viewerHub: RelaySessionHub = { kind: "session", id: viewerHubId };
const secondViewerHub: RelaySessionHub = {
  kind: "session",
  id: secondViewerHubId,
};

const { sockets, WebSocket: TestSocket } = relayMountFixture();

function peerFrame(
  type: "presence" | "reading_cursor" | "draft_cursor",
  payload: Record<string, unknown>,
  seq: number,
  userId: string = rosterPeerId,
  hub: RelaySessionHub = viewerHub,
) {
  return {
    v: 1 as const,
    hub,
    type,
    user_id: userId,
    connection_id: `conn:${userId}`,
    seq,
    ttl_ms: 15_000,
    ...payload,
  };
}

function teamMembers() {
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

function defaultClaim() {
  return {
    viewer: ownerId,
    owner: true,
    holder: { id: ownerId, name: "Owner User" },
    turn: { id: "turn-1", run: 1, start_event_seq: 1 },
    baton_token: 1,
    can_steer: true,
    can_take_over: false,
    fence_id: null,
    takeover_pending: false,
    drive_requested: false,
    can_send: true,
    delivery: null,
    queue: { items: [], count: 0 },
  };
}

test("ghost drafts, guest suggestions, joint send, and waitsToJoin shared draft keep working over doc_presence with flags on", async () => {
  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  function ScopeSurface({
    text,
    enableShared,
  }: {
    text: string;
    enableShared: boolean;
  }) {
    const [box, setBox] = useState(text);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const shared = useSharedDraft({
      conversationId,
      enabled: enableShared,
      seed: false,
      text: box,
      setText: setBox,
      inputRef,
    });
    return (
      <RelayPresenceProvider>
        <textarea ref={inputRef} value={box} onChange={() => {}} />
        <span data-sv-shared-active={shared.active ? "1" : "0"} />
        <GhostDrafts conversationId={conversationId} populate={() => {}} />
        <OwnerComposerPresence conversationId={conversationId} allowJoint />
      </RelayPresenceProvider>
    );
  }

  const presenceRows = [
    {
      _id: "p-ghost",
      doc_id: `compose:${conversationId}`,
      user_id: rosterPeerId,
      user_name: "Bob Teammate",
      user_color: "#00bcd4",
      draft_text: "checking migrations now",
      in_draft: false,
      updated_at: Date.now(),
    },
    {
      _id: "p-guest",
      doc_id: `compose:${conversationId}`,
      user_id: guestPeerId,
      user_name: "Carol Guest",
      user_color: "#22d3ee",
      draft_text: "could we also bump timeout",
      can_send: false,
      in_draft: false,
      updated_at: Date.now(),
    },
    {
      _id: "p-low",
      doc_id: `compose:${conversationId}`,
      user_id: lowPeerId,
      user_name: "Amy First",
      user_color: "#eab308",
      draft_text: "amy draft first",
      in_draft: false,
      updated_at: Date.now(),
    },
  ];

  const ui = await mountWeb(<ScopeSurface text="my words" enableShared />, {
    authenticated: true,
    clock: true,
    setup(backend) {
      window.WebSocket = TestSocket;
      useInboxStore.setState({
        currentUser: {
          _id: ownerId,
          name: "Owner User",
          email: "owner@example.com",
        } as never,
        clientState: {
          ...useInboxStore.getState().clientState,
          ui: {
            ...useInboxStore.getState().clientState?.ui,
            active_team_id: teamId,
          },
        } as never,
        teamMembers: teamMembers() as never,
        drafts: { [conversationId]: { draft_message: "my words" } } as never,
        fencedSteerClaims: { [conversationId]: defaultClaim() } as never,
      });
      const stepLog = {
        steps: [] as string[],
        clientIds: [] as string[],
        version: 1,
      };
      backend.set(api.relayGrants.viewerTarget, {
        viewer: ownerId,
        hub: viewerHubId,
        tier: "member",
      });
      backend.set(api.relayGrants.viewerIdentities, []);
      backend.set(api.docSync.getPresence, presenceRows as never);
      backend.set(api.docSync.getSnapshot, {
        version: 1,
        content: JSON.stringify({
          type: "doc",
          content: [{ type: "text", text: "shared start" }],
        }),
      });
      backend.set(api.docSync.getSteps, () => ({
        version: stepLog.version,
        steps: [...stepLog.steps],
        clientIds: [...stepLog.clientIds],
      }));
      backend.set(api.sessionOwnership.listOwners, {
        short_id: "conv-short",
        conversation_id: conversationId,
        owners: [],
      });
      backend.mutation(api.relayGrants.mint, ok);
      backend.mutation(api.docSync.updatePresence, undefined);
      backend.mutation(api.docSync.removePresence, undefined);
      backend.mutation(api.docSync.submitSteps, ({ clientId, steps }) => {
        stepLog.steps.push(...steps);
        stepLog.clientIds.push(...steps.map(() => String(clientId)));
        stepLog.version += steps.length;
        return { status: "synced" as const };
      });
    },
  });

  await act(() =>
    sockets[0].join(["presence", "draft_cursor", "reading_cursor"], viewerHub),
  );

  expect(ui.container.textContent).toContain("checking migrations now");
  expect(ui.container.textContent).toContain("could we also bump timeout");
  expect(ui.container.textContent).toContain("Suggested");
  expect(
    ui.container.querySelector('[data-sv-accept-suggestion="session"]'),
  ).not.toBeNull();
  expect(ui.container.querySelector("[data-sv-send-together]")).not.toBeNull();
  expect(
    ui.backend.queryRequests.some((q) => q.name === "docSync:getSnapshot"),
  ).toBe(false);

  await act(async () => {
    ui.backend.set(api.docSync.getPresence, [
      { ...presenceRows[0], in_draft: true },
      { ...presenceRows[2], in_draft: true },
    ] as never);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    ui.backend.queryRequests.some((q) => q.name === "docSync:getSnapshot"),
  ).toBe(true);
  expect(
    ui.container
      .querySelector("[data-sv-shared-active]")
      ?.getAttribute("data-sv-shared-active"),
  ).toBe("1");
  expect(
    ui.backend.mutations.some((m) => m.name === "docSync:updatePresence"),
  ).toBe(true);

  await ui.close();
});

test("multiple viewer surfaces share one ref-counted subscription without connecting flicker", async () => {
  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  function MultiSurface({
    showSession = true,
    showExtraReader = false,
  }: {
    showSession?: boolean;
    showExtraReader?: boolean;
  }) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    return (
      <RelayPresenceProvider>
        {showSession ? (
          <div>
            <ConversationViewers conversationId={conversationId} />
            <ReaderFaces
              conversationId={conversationId}
              messageId={firstMessageId}
            />
            {showExtraReader ? (
              <ReaderFaces
                conversationId={conversationId}
                messageId={secondMessageId}
              />
            ) : null}
            <div ref={scrollRef} />
            <ReadingMarks
              conversationId={conversationId}
              scrollRef={scrollRef}
              messageIds={[firstMessageId, secondMessageId]}
              onJump={() => {}}
              top={0}
              bottom={0}
            />
            <OwnerComposerPresence conversationId={conversationId} showHere />
          </div>
        ) : null}
      </RelayPresenceProvider>
    );
  }

  const ui = await mountWeb(<MultiSurface />, {
    authenticated: true,
    clock: true,
    setup(backend) {
      window.WebSocket = TestSocket;
      useInboxStore.setState({
        currentUser: { _id: ownerId, name: "Owner User" } as never,
        clientState: {
          ...useInboxStore.getState().clientState,
          ui: {
            ...useInboxStore.getState().clientState?.ui,
            active_team_id: teamId,
          },
        } as never,
        teamMembers: teamMembers() as never,
        fencedSteerClaims: { [conversationId]: defaultClaim() } as never,
      });
      backend.set(api.relayGrants.viewerTarget, {
        viewer: ownerId,
        hub: viewerHubId,
        tier: "member",
      });
      backend.set(api.relayGrants.viewerIdentities, []);
      backend.set(api.docSync.getPresence, []);
      backend.set(api.sessionOwnership.listOwners, {
        short_id: "conv-short",
        conversation_id: conversationId,
        owners: [],
      });
      backend.mutation(api.relayGrants.mint, ok);
      backend.mutation(api.docSync.updatePresence, undefined);
      backend.mutation(api.docSync.removePresence, undefined);
    },
  });

  const [socket] = sockets;
  await act(() =>
    socket.join(["presence", "draft_cursor", "reading_cursor"], viewerHub),
  );
  expect(
    socket.frames.filter(
      (f) =>
        f.type === "subscribe" &&
        (f.hub as { id?: string } | undefined)?.id === viewerHubId,
    ),
  ).toHaveLength(1);
  expect(ui.store.getState().relayViewerPresence[conversationId]?.status).toBe(
    "ready",
  );

  const statuses: Array<string | undefined> = [];
  const unsub = useInboxStore.subscribe((state) => {
    statuses.push(state.relayViewerPresence[conversationId]?.status);
  });

  await ui.rerender(<MultiSurface showSession showExtraReader />);
  expect(
    socket.frames.filter(
      (f) =>
        f.type === "subscribe" &&
        (f.hub as { id?: string } | undefined)?.id === viewerHubId,
    ),
  ).toHaveLength(1);
  expect(statuses.includes("connecting")).toBe(false);
  unsub();

  await ui.rerender(<MultiSurface showSession showExtraReader={false} />);
  expect(socket.frames.some((f) => f.type === "unsubscribe")).toBe(false);
  expect(ui.store.getState().relayViewerPresence[conversationId]?.status).toBe(
    "ready",
  );

  await ui.rerender(<MultiSurface showSession={false} />);
  expect(socket.frames.some((f) => f.type === "unsubscribe")).toBe(true);
  expect(
    ui.store.getState().relayViewerPresence[conversationId],
  ).toBeUndefined();

  await ui.close();
});

test("mixed member and shared tiers mint grants in separate batches", async () => {
  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  const mintBatches: Array<Array<{ id: string }>> = [];
  function DualSubscribers() {
    useSyncRelayViewerPresence(conversationId, true);
    useSyncRelayViewerPresence(secondConversationId, true);
    return null;
  }

  const ui = await mountWeb(
    <RelayPresenceProvider>
      <DualSubscribers />
    </RelayPresenceProvider>,
    {
      authenticated: true,
      clock: true,
      setup(backend) {
        window.WebSocket = TestSocket;
        useInboxStore.setState({
          currentUser: { _id: ownerId, name: "Owner User" } as never,
          clientState: {
            ...useInboxStore.getState().clientState,
            ui: {
              ...useInboxStore.getState().clientState?.ui,
              active_team_id: teamId,
            },
          } as never,
        });
        backend.set(api.relayGrants.viewerTarget, ({ conversation_id }) => ({
          viewer: ownerId,
          hub:
            conversation_id === secondConversationId
              ? secondViewerHubId
              : viewerHubId,
          tier:
            conversation_id === secondConversationId
              ? ("shared" as const)
              : ("member" as const),
        }));
        backend.set(api.relayGrants.viewerIdentities, []);
        backend.mutation(api.relayGrants.mint, ({ hubs }) => {
          mintBatches.push(hubs.map((h) => ({ id: h.id })));
          return ok;
        });
      },
    },
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mintBatches).toHaveLength(1);
  expect(mintBatches[0].map((h) => h.id)).toEqual([viewerHubId]);

  await act(async () => {
    sockets[0]?.join(["presence"], viewerHub);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mintBatches).toHaveLength(2);
  expect(mintBatches.map((batch) => batch.map((h) => h.id))).toEqual([
    [viewerHubId],
    [secondViewerHubId],
  ]);

  await act(() => {
    sockets[0]?.join(["presence"], secondViewerHub);
  });

  await ui.close();
});

test("relay viewer slice classifies local/entity/non-persisted and prunes zombie connections", () => {
  expect(REPLICATION_CLASSIFICATION.relayViewerPresence).toBe("local");
  expect(DATA_SCOPE.relayViewerPresence).toBe("entity");
  expect(isPersistedClientStoreKey("relayViewerPresence")).toBe(false);

  const readingSignal = (
    cursor: { message_id: string; offset: number } | null,
    seq: number,
  ): RelayEvent["signal"] => ({
    v: 1,
    hub: viewerHub,
    type: "reading_cursor",
    user_id: rosterPeerId,
    connection_id: `conn:${rosterPeerId}`,
    seq,
    ttl_ms: 15_000,
    cursor,
  });

  const map: Parameters<typeof applyRelayViewerSignal>[0] = {};
  applyRelayViewerSignal(
    map,
    conversationId,
    ownerId,
    viewerHubId,
    {
      type: "signal",
      signal: readingSignal({ message_id: firstMessageId, offset: 0.25 }, 1),
    },
    100,
  );
  expect(map[conversationId]?.connections[rosterPeerId]).toBeDefined();

  applyRelayViewerSignal(
    map,
    conversationId,
    ownerId,
    viewerHubId,
    { type: "signal", signal: readingSignal(null, 2) },
    110,
  );
  expect(map[conversationId]?.connections[rosterPeerId]).toBeUndefined();

  applyRelayViewerSignal(
    map,
    conversationId,
    ownerId,
    viewerHubId,
    {
      type: "signal",
      signal: readingSignal({ message_id: firstMessageId, offset: 0.5 }, 3),
    },
    120,
  );
  applyRelayViewerSignal(
    map,
    conversationId,
    ownerId,
    viewerHubId,
    {
      type: "removed",
      signal: readingSignal({ message_id: firstMessageId, offset: 0.5 }, 3),
    },
    130,
  );
  expect(map[conversationId]?.connections[rosterPeerId]).toBeUndefined();
});

test("relay failure drops UI to Presence unknown with viewer guard, preserves stored data, and isolates keystrokes and driver", async () => {
  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  let viewersRenders = 0;
  let readerFirstRenders = 0;
  let readerSecondRenders = 0;
  let composerRenders = 0;
  const driver = { latest: null as string | null };

  function DriverProbe() {
    const control = useLiveComposerControl(conversationId, ownerId);
    const name =
      control && "shared" in control
        ? (control.shared?.facts.driver?.name ?? null)
        : null;
    driver.latest = name;
    return <span data-sv-driver-probe>{name ?? "none"}</span>;
  }

  function ResilientSurface() {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    return (
      <RelayPresenceProvider>
        <Profiler
          id="viewers"
          onRender={() => {
            viewersRenders++;
          }}
        >
          <ConversationViewers conversationId={conversationId} />
        </Profiler>
        <DriverProbe />
        <div ref={scrollRef} />
        <Profiler
          id="reader-first"
          onRender={() => {
            readerFirstRenders++;
          }}
        >
          <ReaderFaces
            conversationId={conversationId}
            messageId={firstMessageId}
          />
        </Profiler>
        <Profiler
          id="reader-second"
          onRender={() => {
            readerSecondRenders++;
          }}
        >
          <ReaderFaces
            conversationId={conversationId}
            messageId={secondMessageId}
          />
        </Profiler>
        <ReadingMarks
          conversationId={conversationId}
          scrollRef={scrollRef}
          messageIds={[firstMessageId, secondMessageId]}
          onJump={() => {}}
          top={0}
          bottom={0}
        />
        <Profiler
          id="composer"
          onRender={() => {
            composerRenders++;
          }}
        >
          <OwnerComposerPresence conversationId={conversationId} showHere />
        </Profiler>
      </RelayPresenceProvider>
    );
  }

  const ui = await mountWeb(<ResilientSurface />, {
    authenticated: true,
    clock: true,
    setup(backend) {
      window.WebSocket = TestSocket;
      useInboxStore.setState({
        currentUser: { _id: ownerId, name: "Owner User" } as never,
        clientState: {
          ...useInboxStore.getState().clientState,
          ui: {
            ...useInboxStore.getState().clientState?.ui,
            active_team_id: teamId,
          },
        } as never,
        teamMembers: teamMembers() as never,
        fencedSteerClaims: { [conversationId]: defaultClaim() } as never,
        sessionReadAnchors: {
          [conversationId]: {
            _id: conversationId,
            user_id: ownerId,
            message_id: firstMessageId,
            offset: 0.4,
            timestamp: 100,
            changed_at: 100,
          },
        },
        drafts: {
          [conversationId]: { draft_message: "persisted draft" },
        } as never,
      });
      backend.set(api.relayGrants.viewerTarget, {
        viewer: ownerId,
        hub: viewerHubId,
        tier: "member",
      });
      backend.set(api.relayGrants.viewerIdentities, []);
      backend.set(api.docSync.getPresence, []);
      backend.set(api.sessionOwnership.listOwners, {
        short_id: "conv-short",
        conversation_id: conversationId,
        owners: [],
      });
      backend.mutation(api.relayGrants.mint, ok);
      backend.mutation(api.docSync.updatePresence, undefined);
      backend.mutation(api.docSync.removePresence, undefined);
    },
  });

  const [socket] = sockets;
  expect(driver.latest).toBe("Owner User");
  await act(() =>
    socket.join(["presence", "draft_cursor", "reading_cursor"], viewerHub),
  );
  await act(() =>
    socket.message(
      peerFrame("presence", { state: "active", in_draft: false }, 1),
    ),
  );
  await act(() =>
    socket.message(
      peerFrame(
        "reading_cursor",
        { cursor: { message_id: firstMessageId, offset: 0.5 } },
        2,
      ),
    ),
  );

  const beforeKeystroke = {
    viewersRenders,
    readerFirstRenders,
    readerSecondRenders,
    relaySlice: ui.store.getState().relayViewerPresence[conversationId],
  };
  await act(() => {
    ui.store.getState().setDraft(conversationId, { draft_message: "hello" });
    ui.store
      .getState()
      .setDraft(conversationId, { draft_message: "hello world" });
  });
  expect(viewersRenders).toBe(beforeKeystroke.viewersRenders);
  expect(readerFirstRenders).toBe(beforeKeystroke.readerFirstRenders);
  expect(readerSecondRenders).toBe(beforeKeystroke.readerSecondRenders);
  expect(ui.store.getState().relayViewerPresence[conversationId]).toBe(
    beforeKeystroke.relaySlice,
  );

  const viewersBeforeCursor = viewersRenders;
  const secondBeforeCursor = readerSecondRenders;
  const composerBeforeCursor = composerRenders;
  await act(() =>
    socket.message(
      peerFrame(
        "reading_cursor",
        { cursor: { message_id: firstMessageId, offset: 0.7 } },
        3,
      ),
    ),
  );
  expect(viewersRenders).toBe(viewersBeforeCursor);
  expect(readerSecondRenders).toBe(secondBeforeCursor);
  expect(composerRenders).toBe(composerBeforeCursor);
  expect(readerFirstRenders).toBeGreaterThan(
    beforeKeystroke.readerFirstRenders,
  );

  await act(() => socket.fail());
  expect(
    ui.container.querySelectorAll('[data-sv-presence-status="unknown"]').length,
  ).toBeGreaterThanOrEqual(2);
  expect(ui.container.querySelector("[data-sv-viewers]")).toBeNull();
  expect(ui.container.querySelector("[data-sv-reader-faces]")).toBeNull();
  expect(driver.latest).toBe("Owner User");
  expect(ui.store.getState().sessionReadAnchors[conversationId]).toEqual({
    _id: conversationId,
    user_id: ownerId,
    message_id: firstMessageId,
    offset: 0.4,
    timestamp: 100,
    changed_at: 100,
  });

  await act(() => {
    useInboxStore
      .getState()
      .setRelayViewerStatus(
        conversationId,
        "other-viewer",
        viewerHubId,
        "unknown",
      );
  });
  expect(
    ui.container.querySelectorAll('[data-sv-presence-status="unknown"]').length,
  ).toBe(0);

  await act(async () => {
    await ui.clock!.advance(1_500);
  });
  const reconnected = sockets[1];
  expect(reconnected).toBeDefined();
  await act(() =>
    reconnected.join(["presence", "draft_cursor", "reading_cursor"], viewerHub),
  );
  await act(() =>
    reconnected.message(
      peerFrame("presence", { state: "active", in_draft: false }, 1),
    ),
  );
  expect(
    ui.container.querySelectorAll('[data-sv-presence-status="unknown"]').length,
  ).toBe(0);
  expect(ui.container.querySelector("[data-sv-viewers]")).not.toBeNull();
  expect(driver.latest).toBe("Owner User");

  await ui.close();
});
