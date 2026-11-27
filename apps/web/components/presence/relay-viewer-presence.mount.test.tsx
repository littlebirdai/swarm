import { afterEach, expect, test } from "bun:test";
import { Profiler, act, useRef } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { SharedDraftStatus } from "../../hooks/useSharedDraft";
import { useLiveComposerControl } from "../../hooks/use-live-composer-control";
import { useDocPresence } from "../../hooks/useDocPresence";
import type { RelayHub } from "@codecast/relay-contract";
import { mountWeb } from "../../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
  type RelaySocket,
} from "../../test-helpers/relay-presence-testkit";
import { CollabPresenceBar, OwnerComposerPresence } from "../collab-composer";
import { ReaderFaces, ReadingMarks } from "../conversation/ReadingMarks";
import { RelayPresenceProvider } from "../relay-presence-provider";
import { ConversationViewers } from "./ViewerFaces";
import {
  DATA_SCOPE,
  REPLICATION_CLASSIFICATION,
  isPersistedClientStoreKey,
} from "../../store/clientSyncRegistry";
import { useInboxStore } from "../../store/inboxStore";

const conversationId = "c".repeat(32) as Id<"conversations">;
const teamId = "t".repeat(32) as Id<"teams">;
const ownerId = "o".repeat(32) as Id<"users">;
const rosterPeerId = "r".repeat(32) as Id<"users">;
const guestPeerId = "g".repeat(32) as Id<"users">;
const firstMessageId = "m".repeat(32) as Id<"messages">;
const secondMessageId = "n".repeat(32) as Id<"messages">;
const viewerHubId = `viewer:${conversationId}`;
const viewerHub: RelayHub = { kind: "session", id: viewerHubId };

const { sockets, WebSocket: TestSocket } = relayMountFixture();

afterEach(() => {
  delete process.env.VITE_RELAY_PRESENCE;
  delete process.env.VITE_RELAY_URL;
});

function peerFrame(
  type: "presence" | "reading_cursor" | "draft_cursor",
  payload: Record<string, unknown>,
  seq: number,
  userId: string = rosterPeerId,
) {
  return {
    v: 1 as const,
    hub: viewerHub,
    type,
    user_id: userId,
    connection_id: `conn:${userId}`,
    seq,
    ttl_ms: 15_000,
    ...payload,
  };
}

function sendSubscribed(socket: RelaySocket, hub: RelayHub = viewerHub) {
  return socket.join(["presence", "draft_cursor", "reading_cursor"], hub);
}

function publishedFrames(socket: RelaySocket, type?: string) {
  return socket.frames.filter((frame) => {
    const kind = frame.type as string | undefined;
    if (
      !kind ||
      kind === "auth" ||
      kind === "subscribe" ||
      kind === "unsubscribe"
    ) {
      return false;
    }
    return !type || kind === type;
  });
}

function baseRoster(opts?: {
  rosterPeerViewing?: string;
  extra?: Record<string, unknown>[];
}) {
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
      ...(opts?.rosterPeerViewing
        ? { viewing_conversation_id: opts.rosterPeerViewing }
        : {}),
      roster_team: teamId,
    },
    ...(opts?.extra ?? []),
  ];
}

function defaultSteerClaim(
  holderId: string = ownerId,
  holderName = "Owner User",
) {
  return {
    viewer: ownerId,
    owner: true,
    holder: { id: holderId, name: holderName },
    turn: {
      id: "turn-1",
      run: 1,
      start_event_seq: 1,
    },
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

async function mountSessionSurface(opts: {
  relayOn: boolean;
  viewerTarget: {
    viewer: string;
    hub: string;
    tier: "owner" | "member" | "shared";
  } | null;
  legacyPresenceRows?: unknown[];
  rosterPeerViewing?: string;
  sharedDraft?: SharedDraftStatus | null;
  identities?: Array<{ user_id: string; user_name: string; color: string }>;
  anchor?: { messageId: string; offset: number } | null;
  onRenderCounts?: {
    viewers: () => void;
    readerFirst: () => void;
    readerSecond: () => void;
    composer: () => void;
  };
  onDriver?: (driverName: string | null) => void;
}) {
  if (opts.relayOn) {
    process.env.VITE_RELAY_PRESENCE = "1";
    process.env.VITE_RELAY_URL = "wss://relay.test/relay";
  } else {
    delete process.env.VITE_RELAY_PRESENCE;
    delete process.env.VITE_RELAY_URL;
  }

  function DriverProbe() {
    const control = useLiveComposerControl(conversationId, ownerId);
    opts.onDriver?.(control?.shared?.facts.driver?.name ?? null);
    return (
      <span data-sv-driver-probe>
        {control?.shared?.facts.driver?.name ?? "none"}
      </span>
    );
  }

  function Surface({ showSession = true }: { showSession?: boolean }) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    return (
      <RelayPresenceProvider>
        {showSession ? (
          <div>
            <Profiler
              id="viewers"
              onRender={() => {
                opts.onRenderCounts?.viewers();
              }}
            >
              <ConversationViewers conversationId={conversationId} />
            </Profiler>
            <DriverProbe />
            <div ref={scrollRef}>
              <div data-index={0}>
                <Profiler
                  id="reader-first"
                  onRender={() => {
                    opts.onRenderCounts?.readerFirst();
                  }}
                >
                  <ReaderFaces
                    conversationId={conversationId}
                    messageId={firstMessageId}
                  />
                </Profiler>
              </div>
              <div data-index={1}>
                <Profiler
                  id="reader-second"
                  onRender={() => {
                    opts.onRenderCounts?.readerSecond();
                  }}
                >
                  <ReaderFaces
                    conversationId={conversationId}
                    messageId={secondMessageId}
                  />
                </Profiler>
              </div>
            </div>
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
                opts.onRenderCounts?.composer();
              }}
            >
              <OwnerComposerPresence conversationId={conversationId} showHere />
            </Profiler>
          </div>
        ) : null}
      </RelayPresenceProvider>
    );
  }

  const ui = await mountWeb(<Surface />, {
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
        teamMembers: baseRoster({
          rosterPeerViewing: opts.rosterPeerViewing,
        }) as never,
        conversations: {
          [conversationId]: {
            _id: conversationId,
            share_token: "share-token",
          },
        } as never,
        fencedSteerClaims: {
          [conversationId]: defaultSteerClaim(),
        } as never,
        sessionReadAnchors: {
          [conversationId]: {
            messageId: firstMessageId,
            offset: 0.4,
            savedAt: 100,
          },
        } as never,
        drafts: {
          [conversationId]: {
            draft_message: "persisted draft",
          },
        } as never,
        ...(opts.anchor !== undefined && {
          viewAnchor: opts.anchor
            ? {
                conversationId,
                messageId: opts.anchor.messageId,
                offset: opts.anchor.offset,
              }
            : null,
        }),
      });
      backend.set(api.relayGrants.viewerTarget, opts.viewerTarget);
      backend.set(api.relayGrants.viewerIdentities, opts.identities ?? []);
      backend.set(api.docSync.getPresence, opts.legacyPresenceRows ?? []);
      backend.set(api.sharedDrafts.getStatus, opts.sharedDraft ?? null);
      backend.set(api.sessionOwnership.listOwners, {
        conversation_id: conversationId,
        owners: [],
      });
      backend.mutation(api.relayGrants.mint, ok);
      backend.mutation(api.docSync.updatePresence, null);
      backend.mutation(api.docSync.removePresence, null);
    },
  });

  return { ...ui, sockets, Surface };
}

test("flag off uses Convex doc_presence and opens no relay viewer watch", async () => {
  const ui = await mountSessionSurface({
    relayOn: false,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "owner" },
    rosterPeerViewing: conversationId,
    legacyPresenceRows: [
      {
        _id: "p1",
        doc_id: `compose:${conversationId}`,
        user_id: rosterPeerId,
        user_name: "Bob Teammate",
        color: "#00bcd4",
        draft_text: "typing via convex",
        anchor: { message_id: firstMessageId, offset: 0.25 },
        cursor_pos: null,
        in_draft: false,
        updated_at: Date.now(),
      },
    ],
    anchor: { messageId: firstMessageId, offset: 0.5 },
  });

  expect(ui.sockets.length).toBe(0);
  expect(
    ui.backend.queryRequests.filter((q) => q.name.startsWith("relayGrants:")),
  ).toEqual([]);
  expect(
    ui.backend.queryRequests.some((q) => q.name === "docSync:getPresence"),
  ).toBe(true);
  expect(
    ui.backend.mutations.some((m) => m.name === "docSync:updatePresence"),
  ).toBe(true);
  expect(
    ui.container
      .querySelector("[data-sv-viewers]")
      ?.getAttribute("data-sv-viewers"),
  ).toBe("1");
  expect(ui.container.querySelector("[data-sv-reader-faces]")).not.toBeNull();
  expect(ui.container.textContent).toContain("Bob Teammate is typing");

  await ui.close();
  expect(
    ui.backend.mutations.some((m) => m.name === "docSync:removePresence"),
  ).toBe(true);
});

test("server flag off falls back to doc_presence without opening a viewer relay subscription", async () => {
  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: null,
    legacyPresenceRows: [
      {
        _id: "p1",
        doc_id: `compose:${conversationId}`,
        user_id: rosterPeerId,
        user_name: "Bob Teammate",
        color: "#00bcd4",
        draft_text: "",
        anchor: { message_id: firstMessageId, offset: 0.1 },
        cursor_pos: null,
        in_draft: false,
        updated_at: Date.now(),
      },
    ],
  });

  expect(
    ui.backend.queryRequests.some((q) => q.name === "relayGrants:viewerTarget"),
  ).toBe(true);
  const viewerSubSent = ui.sockets.some((s) =>
    s.frames.some(
      (f) =>
        f.type === "subscribe" &&
        (f.hub as { id?: string } | undefined)?.id === viewerHubId,
    ),
  );
  expect(viewerSubSent).toBe(false);
  expect(
    ui.backend.queryRequests.some((q) => q.name === "docSync:getPresence"),
  ).toBe(true);
  expect(
    ui.backend.mutations.some((m) => m.name === "docSync:updatePresence"),
  ).toBe(true);
  expect(ui.container.querySelector("[data-sv-reader-faces]")).not.toBeNull();

  await ui.close();
});

test("flag on routes presence and cursors over relay with zero doc_presence reads or writes", async () => {
  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "owner" },
    identities: [
      { user_id: guestPeerId, user_name: "Carol Guest", color: "#22d3ee" },
    ],
    anchor: { messageId: firstMessageId, offset: 0.45 },
  });

  expect(
    ui.backend.queryRequests.some((q) => q.name === "docSync:getPresence"),
  ).toBe(false);
  expect(ui.backend.mutations.some((m) => m.name.startsWith("docSync:"))).toBe(
    false,
  );

  expect(ui.sockets.length).toBe(1);
  const socket = ui.sockets[0];
  await act(() => sendSubscribed(socket));

  expect(
    socket.frames.some(
      (f) =>
        f.type === "subscribe" &&
        (f.hub as { id?: string } | undefined)?.id === viewerHubId,
    ),
  ).toBe(true);
  expect(publishedFrames(socket, "presence").length).toBeGreaterThan(0);

  await act(() =>
    socket.message(
      peerFrame(
        "presence",
        { state: "active", in_draft: false },
        1,
        rosterPeerId,
      ),
    ),
  );
  await act(() =>
    socket.message(
      peerFrame(
        "reading_cursor",
        { cursor: { message_id: firstMessageId, offset: 0.6 } },
        2,
        rosterPeerId,
      ),
    ),
  );
  await act(async () => {
    socket.message(
      peerFrame(
        "presence",
        { state: "active", in_draft: true },
        3,
        guestPeerId,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await ui.clock!.advance(10);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    ui.backend.queryRequests.some(
      (q) =>
        q.name === "relayGrants:viewerIdentities" &&
        Array.isArray((q.args as { user_ids?: string[] })?.user_ids) &&
        (q.args as { user_ids: string[] }).user_ids.includes(guestPeerId),
    ),
  ).toBe(true);

  const viewersEl = ui.container.querySelector("[data-sv-viewers]");
  expect(viewersEl?.getAttribute("data-sv-viewers")).toBe("2");
  expect(viewersEl?.getAttribute("aria-label")).toContain("Bob");
  expect(viewersEl?.getAttribute("aria-label")).toContain("Carol");
  expect(ui.container.querySelector("[data-sv-reader-faces]")).not.toBeNull();

  await ui.clock!.advance(10);
  const initialReadingCount = publishedFrames(socket, "reading_cursor").length;
  expect(initialReadingCount).toBeGreaterThan(0);

  await act(() => {
    ui.store.getState().setViewAnchor({
      conversationId,
      messageId: secondMessageId,
      offset: 0.2,
    });
  });
  await ui.clock!.advance(200);
  expect(publishedFrames(socket, "reading_cursor").length).toBe(
    initialReadingCount,
  );

  await ui.clock!.advance(350);
  const afterThrottle = publishedFrames(socket, "reading_cursor");
  expect(afterThrottle.length).toBe(initialReadingCount + 1);
  const lastSignal = afterThrottle.at(-1) as {
    cursor?: { message_id: string; offset: number };
  };
  expect(lastSignal.cursor).toEqual({
    message_id: secondMessageId,
    offset: 0.2,
  });

  expect(
    ui.backend.queryRequests.some((q) => q.name === "docSync:getPresence"),
  ).toBe(false);
  expect(ui.backend.mutations.some((m) => m.name.startsWith("docSync:"))).toBe(
    false,
  );

  await ui.rerender(<ui.Surface showSession={false} />);
  expect(
    publishedFrames(socket, "presence").some((f) => f.state === "left"),
  ).toBe(true);
  await ui.close();
});

test("relay failure drops UI to Presence unknown, preserves stored data, and recovers on reconnect", async () => {
  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "owner" },
  });
  const [socket] = ui.sockets;
  await act(() => sendSubscribed(socket));
  await act(() =>
    socket.message(
      peerFrame(
        "presence",
        { state: "active", in_draft: false },
        1,
        rosterPeerId,
      ),
    ),
  );
  await act(() =>
    socket.message(
      peerFrame(
        "reading_cursor",
        { cursor: { message_id: firstMessageId, offset: 0.5 } },
        2,
        rosterPeerId,
      ),
    ),
  );
  expect(ui.container.querySelector("[data-sv-viewers]")).not.toBeNull();
  expect(ui.container.querySelector("[data-sv-reader-faces]")).not.toBeNull();

  await act(() => socket.fail());

  const unknownNodes = ui.container.querySelectorAll(
    '[data-sv-presence-status="unknown"]',
  );
  expect(unknownNodes.length).toBeGreaterThanOrEqual(2);
  expect(ui.container.textContent).toContain("Presence unknown");
  expect(ui.container.querySelector("[data-sv-viewers]")).toBeNull();
  expect(ui.container.querySelector("[data-sv-reader-faces]")).toBeNull();

  expect(ui.store.getState().sessionReadAnchors[conversationId]).toEqual({
    messageId: firstMessageId,
    offset: 0.4,
    savedAt: 100,
  });
  expect(ui.store.getState().drafts[conversationId]?.draft_message).toBe(
    "persisted draft",
  );

  await act(async () => {
    await ui.clock!.advance(1_500);
  });
  const reconnected = ui.sockets[1];
  expect(reconnected).toBeDefined();
  await act(() => sendSubscribed(reconnected));
  await act(() =>
    reconnected.message(
      peerFrame(
        "presence",
        { state: "active", in_draft: false },
        1,
        rosterPeerId,
      ),
    ),
  );

  expect(
    ui.container.querySelectorAll('[data-sv-presence-status="unknown"]').length,
  ).toBe(0);
  expect(ui.container.querySelector("[data-sv-viewers]")).not.toBeNull();

  await act(() =>
    reconnected.message({
      v: 1,
      type: "subscription",
      status: "denied",
      hub: viewerHub,
    }),
  );
  expect(ui.container.querySelector("[data-sv-viewers]")).toBeNull();

  await ui.close();
});

test("claim row alone decides driver regardless of relay peers or relay failure", async () => {
  let latestDriver: string | null = null;
  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "owner" },
    onDriver: (name) => {
      latestDriver = name;
    },
  });
  const [socket] = ui.sockets;
  expect(latestDriver).toBe("Owner User");

  await act(() => sendSubscribed(socket));
  await act(() =>
    socket.message(
      peerFrame(
        "presence",
        { state: "active", in_draft: true },
        1,
        rosterPeerId,
      ),
    ),
  );
  expect(latestDriver).toBe("Owner User");

  await act(() => socket.fail());
  expect(ui.container.textContent).toContain("Presence unknown");
  expect(latestDriver).toBe("Owner User");

  await ui.close();
});

test("composer keystrokes and peer anchor updates stay isolated across subscribers", async () => {
  let viewersRenders = 0;
  let readerFirstRenders = 0;
  let readerSecondRenders = 0;
  let composerRenders = 0;

  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "owner" },
    onRenderCounts: {
      viewers: () => {
        viewersRenders++;
      },
      readerFirst: () => {
        readerFirstRenders++;
      },
      readerSecond: () => {
        readerSecondRenders++;
      },
      composer: () => {
        composerRenders++;
      },
    },
  });
  const [socket] = ui.sockets;
  await act(() => sendSubscribed(socket));
  await act(() =>
    socket.message(
      peerFrame(
        "presence",
        { state: "active", in_draft: false },
        1,
        rosterPeerId,
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
    ui.store.getState().setDraft(conversationId, "hello");
    ui.store.getState().setDraft(conversationId, "hello world");
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
        2,
        rosterPeerId,
      ),
    ),
  );

  expect(viewersRenders).toBe(viewersBeforeCursor);
  expect(readerSecondRenders).toBe(secondBeforeCursor);
  expect(composerRenders).toBe(composerBeforeCursor);
  expect(readerFirstRenders).toBeGreaterThan(
    beforeKeystroke.readerFirstRenders,
  );

  await ui.close();
});

test("relay viewer presence publishes draft_cursor with shared revision and classifies store slice", async () => {
  expect(REPLICATION_CLASSIFICATION.relayViewerPresence).toBe("local");
  expect(DATA_SCOPE.relayViewerPresence).toBe("entity");
  expect(isPersistedClientStoreKey("relayViewerPresence")).toBe(false);

  process.env.VITE_RELAY_PRESENCE = "1";
  process.env.VITE_RELAY_URL = "wss://relay.test/relay";

  function DraftReporter() {
    useDocPresence({
      docId: `compose:${conversationId}`,
      inDraft: true,
      cursor: 4,
      cursorRevision: 7,
      enabled: true,
      forceBroadcast: false,
    });
    return (
      <CollabPresenceBar
        present={[]}
        showHere={false}
        presenceUnknown={false}
      />
    );
  }

  const ui = await mountWeb(
    <RelayPresenceProvider>
      <DraftReporter />
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
          teamMembers: baseRoster() as never,
        });
        backend.set(api.relayGrants.viewerTarget, {
          viewer: ownerId,
          hub: viewerHubId,
          tier: "shared",
        });
        backend.set(api.relayGrants.viewerIdentities, []);
        backend.mutation(api.relayGrants.mint, ok);
      },
    },
  );

  const [socket] = sockets;
  await act(() => sendSubscribed(socket));
  const draftCursors = publishedFrames(socket, "draft_cursor");
  expect(draftCursors.length).toBeGreaterThan(0);
  expect(draftCursors[0].cursor).toEqual({
    revision: 7,
    anchor: 4,
    head: 4,
  });

  await ui.close();
});
