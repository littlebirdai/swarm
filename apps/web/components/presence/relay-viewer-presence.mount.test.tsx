import { expect, test } from "bun:test";
import { Profiler, act, useRef } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useLiveComposerControl } from "../../hooks/use-live-composer-control";
import { useInboxStore } from "../../store/inboxStore";
import { mountWeb } from "../../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
  type RelaySocket,
} from "../../test-helpers/relay-presence-testkit";
import { OwnerComposerPresence } from "../collab-composer";
import { ReaderFaces, ReadingMarks } from "../conversation/ReadingMarks";
import { RelayPresenceProvider } from "../relay-presence-provider";
import { ConversationViewers } from "./ViewerFaces";

const conversationId = "c".repeat(32) as Id<"conversations">;
const teamId = "t".repeat(32) as Id<"teams">;
const ownerId = "m".repeat(32) as Id<"users">;
const rosterPeerId = "r".repeat(32) as Id<"users">;
const guestPeerId = "z".repeat(32) as Id<"users">;
const firstMessageId = "1".repeat(32) as Id<"messages">;
const secondMessageId = "2".repeat(32) as Id<"messages">;
type RelaySessionHub = { kind: "session"; id: string };

const viewerHubId = `viewer:${conversationId}`;
const viewerHub: RelaySessionHub = { kind: "session", id: viewerHubId };

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

function sendSubscribed(socket: RelaySocket, hub: RelaySessionHub = viewerHub) {
  return socket.join(["presence", "draft_cursor", "reading_cursor"], hub);
}

function publishedFrames(socket: RelaySocket, type?: string) {
  return socket.frames.filter((frame) => {
    const kind = frame.type as string | undefined;
    if (
      !kind ||
      kind === "auth" ||
      kind === "connect" ||
      kind === "grant_update" ||
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
  withoutProvider?: boolean;
  withoutWebSocket?: boolean;
  viewerTarget: {
    viewer: Id<"users">;
    hub: string;
    tier: "member" | "shared";
  } | null;
  legacyPresenceRows?: Array<{
    _id: string;
    doc_id: string;
    user_id: Id<"users">;
    user_name: string;
    user_color: string;
    user_image?: string;
    draft_text?: string;
    cursor_pos?: number | null;
    in_draft?: boolean;
    can_send?: boolean;
    anchor?: { message_id: string; offset: number };
    anchor_at?: number;
    claims?: Array<{
      user_id: Id<"users">;
      text: string;
      at: number;
      how?: string;
    }>;
    updated_at: number;
  }>;
  rosterPeerViewing?: string;
  identities?: Array<{
    user_id: Id<"users">;
    user_name: string;
    user_color: string;
    user_image: string | undefined;
  }>;
  anchor?: { messageId: string; offset: number } | null;
  mintReply?: () =>
    | typeof ok
    | { status: "unavailable" }
    | { status: "rate_limited" }
    | { status: "denied"; omitted: never[] };
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
    const driverName =
      control && "shared" in control
        ? (control.shared?.facts.driver?.name ?? null)
        : null;
    opts.onDriver?.(driverName);
    return <span data-sv-driver-probe>{driverName ?? "none"}</span>;
  }

  function Surface({
    showSession = true,
    showExtraReader = false,
  }: {
    showSession?: boolean;
    showExtraReader?: boolean;
  }) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const body = showSession ? (
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
        {showExtraReader ? (
          <ReaderFaces
            conversationId={conversationId}
            messageId={firstMessageId}
          />
        ) : null}
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
    ) : null;

    if (opts.withoutProvider) return body;
    return <RelayPresenceProvider>{body}</RelayPresenceProvider>;
  }

  const ui = await mountWeb(<Surface />, {
    authenticated: true,
    clock: true,
    setup(backend) {
      window.WebSocket = opts.withoutWebSocket
        ? (undefined as unknown as typeof WebSocket)
        : TestSocket;
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
            _id: conversationId,
            user_id: ownerId,
            message_id: firstMessageId,
            offset: 0.4,
            timestamp: 100,
            changed_at: 100,
          },
        },
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
      backend.set(
        api.docSync.getPresence,
        (opts.legacyPresenceRows ?? []) as never,
      );
      backend.set(api.sessionOwnership.listOwners, {
        short_id: "conv-short",
        conversation_id: conversationId,
        owners: [],
      });
      backend.mutation(api.relayGrants.mint, () =>
        opts.mintReply ? opts.mintReply() : ok,
      );
      backend.mutation(api.docSync.updatePresence, undefined);
      backend.mutation(api.docSync.removePresence, undefined);
    },
  });

  return { ...ui, sockets, Surface };
}

test("flag off uses Convex doc_presence and opens no relay viewer watch", async () => {
  const ui = await mountSessionSurface({
    relayOn: false,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "member" },
    rosterPeerViewing: conversationId,
    legacyPresenceRows: [
      {
        _id: "p1",
        doc_id: `compose:${conversationId}`,
        user_id: rosterPeerId,
        user_name: "Bob Teammate",
        user_color: "#00bcd4",
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

test("missing RelayPresenceContext or missing WebSocket stays on Convex immediately", async () => {
  const withoutProvider = await mountSessionSurface({
    relayOn: true,
    withoutProvider: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "member" },
    rosterPeerViewing: conversationId,
    legacyPresenceRows: [
      {
        _id: "p1",
        doc_id: `compose:${conversationId}`,
        user_id: rosterPeerId,
        user_name: "Bob Teammate",
        user_color: "#00bcd4",
        draft_text: "live via convex",
        anchor: { message_id: firstMessageId, offset: 0.2 },
        updated_at: Date.now(),
      },
    ],
  });

  expect(withoutProvider.sockets.length).toBe(0);
  expect(
    withoutProvider.backend.queryRequests.some(
      (q) => q.name === "docSync:getPresence",
    ),
  ).toBe(true);
  expect(
    withoutProvider.container
      .querySelector("[data-sv-viewers]")
      ?.getAttribute("data-sv-viewers"),
  ).toBe("1");
  expect(
    withoutProvider.container.querySelector("[data-sv-reader-faces]"),
  ).not.toBeNull();
  expect(withoutProvider.container.textContent).toContain("live via convex");
  await withoutProvider.close();

  const withoutSocket = await mountSessionSurface({
    relayOn: true,
    withoutWebSocket: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "member" },
    rosterPeerViewing: conversationId,
    legacyPresenceRows: [
      {
        _id: "p2",
        doc_id: `compose:${conversationId}`,
        user_id: rosterPeerId,
        user_name: "Bob Teammate",
        user_color: "#00bcd4",
        draft_text: "no websocket convex",
        anchor: { message_id: firstMessageId, offset: 0.3 },
        updated_at: Date.now(),
      },
    ],
  });

  expect(withoutSocket.sockets.length).toBe(0);
  expect(
    withoutSocket.backend.queryRequests.some(
      (q) => q.name === "docSync:getPresence",
    ),
  ).toBe(true);
  expect(
    withoutSocket.container
      .querySelector("[data-sv-viewers]")
      ?.getAttribute("data-sv-viewers"),
  ).toBe("1");
  expect(
    withoutSocket.container.querySelector("[data-sv-reader-faces]"),
  ).not.toBeNull();
  expect(withoutSocket.container.textContent).toContain("no websocket convex");
  await withoutSocket.close();
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
        user_color: "#00bcd4",
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

test("mint unavailable or rate_limited cancels automatic retries and falls back to Convex", async () => {
  for (const terminalStatus of ["rate_limited", "unavailable"] as const) {
    let mints = 0;
    const ui = await mountSessionSurface({
      relayOn: true,
      viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "member" },
      rosterPeerViewing: conversationId,
      legacyPresenceRows: [
        {
          _id: "p-fallback",
          doc_id: `compose:${conversationId}`,
          user_id: rosterPeerId,
          user_name: "Bob Teammate",
          user_color: "#00bcd4",
          anchor: { message_id: firstMessageId, offset: 0.4 },
          updated_at: Date.now(),
        },
      ],
      mintReply: () => {
        mints++;
        return { status: terminalStatus };
      },
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const mintsAfterFirst = mints;
    await ui.clock!.advance(120_000);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mints).toBe(mintsAfterFirst);
    expect(
      ui.store.getState().relayViewerPresence[conversationId]?.status,
    ).toBe("disabled");
    expect(
      ui.container
        .querySelector("[data-sv-viewers]")
        ?.getAttribute("data-sv-viewers"),
    ).toBe("1");
    expect(ui.container.querySelector("[data-sv-reader-faces]")).not.toBeNull();

    await ui.close();
  }
});

test("denied subscription hides viewer faces instead of falling back to roster", async () => {
  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "member" },
    rosterPeerViewing: conversationId,
    legacyPresenceRows: [
      {
        _id: "p1",
        doc_id: `compose:${conversationId}`,
        user_id: rosterPeerId,
        user_name: "Bob Teammate",
        user_color: "#00bcd4",
        anchor: { message_id: firstMessageId, offset: 0.4 },
        updated_at: Date.now(),
      },
    ],
  });
  const [socket] = ui.sockets;
  await act(() => {
    socket.join(["presence", "reading_cursor"], viewerHub);
    socket.message({
      v: 1,
      type: "subscription",
      status: "denied",
      hub: viewerHub,
    });
  });

  expect(ui.store.getState().relayViewerPresence[conversationId]?.status).toBe(
    "denied",
  );
  expect(ui.container.querySelector("[data-sv-viewers]")).toBeNull();
  expect(ui.container.querySelector("[data-sv-reader-faces]")).toBeNull();
  expect(
    ui.container.querySelectorAll('[data-sv-presence-status="unknown"]').length,
  ).toBe(0);

  await ui.close();
});

test("flag on routes faces and reading_cursor over relay, publishes presence once per connect, and writes zero doc_presence anchors on scroll", async () => {
  const ui = await mountSessionSurface({
    relayOn: true,
    viewerTarget: { viewer: ownerId, hub: viewerHubId, tier: "member" },
    identities: [
      {
        user_id: guestPeerId,
        user_name: "Carol Guest",
        user_color: "#22d3ee",
        user_image: undefined,
      },
    ],
    anchor: { messageId: firstMessageId, offset: 0.45 },
  });

  expect(
    ui.backend.mutations.some((m) => m.name === "docSync:updatePresence"),
  ).toBe(false);

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
  expect(publishedFrames(socket, "presence")).toHaveLength(1);
  expect(publishedFrames(socket, "draft_cursor")).toHaveLength(0);

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
  expect(initialReadingCount).toBe(1);

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
  expect(afterThrottle.at(-1)?.cursor).toEqual({
    message_id: secondMessageId,
    offset: 0.2,
  });

  expect(
    ui.backend.mutations.filter(
      (m) =>
        m.name === "docSync:updatePresence" &&
        Boolean((m.args as { anchor?: unknown })?.anchor),
    ),
  ).toHaveLength(0);
  expect(publishedFrames(socket, "draft_cursor")).toHaveLength(0);

  await act(() => socket.fail());
  await act(async () => {
    await ui.clock!.advance(1_500);
  });
  const reconnected = ui.sockets[1];
  expect(reconnected).toBeDefined();
  await act(() => sendSubscribed(reconnected));
  expect(publishedFrames(reconnected, "presence")).toHaveLength(1);

  await ui.rerender(<ui.Surface showSession={false} />);
  expect(
    publishedFrames(reconnected, "presence").some((f) => f.state === "left"),
  ).toBe(true);
  await ui.close();
});
