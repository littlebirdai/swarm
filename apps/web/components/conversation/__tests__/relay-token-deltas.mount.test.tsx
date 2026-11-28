import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../../store/inboxStore";
import { MAX_STREAM_TEXT_BYTES } from "../../../store/relay-token-deltas-slice";
import { mountWeb } from "../../../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
} from "../../../test-helpers/relay-presence-testkit";
import { ConversationViewers } from "../../presence/ViewerFaces";
import { RelayPresenceProvider } from "../../relay-presence-provider";
import { RelayStreamingReplies } from "../relay-streaming-replies";

const conversationId = "d".repeat(32) as Id<"conversations">;
const secondConversationId = "e".repeat(32) as Id<"conversations">;
const ownerId = "m".repeat(32) as Id<"users">;
const viewerHubId = `viewer:${conversationId}`;
const viewerHub = { kind: "session", id: viewerHubId } as const;

const { sockets, WebSocket: TestSocket } = relayMountFixture();

function deltaFrame(params: {
  seq: number;
  run?: number;
  turn?: string;
  message_id?: string;
  delta_seq: number;
  text: string;
}) {
  return {
    v: 1 as const,
    type: "token_delta" as const,
    hub: viewerHub,
    connection_id: "machine:m1",
    machine_id: "m1",
    ttl_ms: 15_000,
    seq: params.seq,
    run: params.run ?? 5,
    turn: params.turn ?? "turn-1",
    message_id: params.message_id ?? "msg-1",
    delta_seq: params.delta_seq,
    text: params.text,
  };
}

async function flushRender(
  ui: Awaited<ReturnType<typeof mountWeb>>,
  advanceMs = 24,
) {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await ui.clock?.advance(advanceMs);
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  delete process.env.VITE_RELAY_TOKEN_DELTAS;
  delete process.env.VITE_RELAY_PRESENCE;
  delete process.env.VITE_RELAY_URL;
  useInboxStore.setState({ relayTokenDeltas: {}, relayViewerPresence: {} });
});

async function mountStreamingSurface(opts: {
  tokenDeltas: boolean;
  presence?: boolean;
  conversation?: string;
  showReplies?: boolean;
  messages?: Array<{ message_uuid?: string; role?: string }>;
  agentStatus?: string | null;
}) {
  if (opts.tokenDeltas) process.env.VITE_RELAY_TOKEN_DELTAS = "1";
  else delete process.env.VITE_RELAY_TOKEN_DELTAS;

  if (opts.presence) process.env.VITE_RELAY_PRESENCE = "1";
  else delete process.env.VITE_RELAY_PRESENCE;

  if (opts.tokenDeltas || opts.presence)
    process.env.VITE_RELAY_URL = "wss://relay.test/relay";
  else delete process.env.VITE_RELAY_URL;

  function Surface({
    convId = opts.conversation ?? conversationId,
    showReplies = opts.showReplies ?? true,
    messages = opts.messages ?? [],
    agentStatus = opts.agentStatus ?? "working",
  }: {
    convId?: string;
    showReplies?: boolean;
    messages?: Array<{ message_uuid?: string; role?: string }>;
    agentStatus?: string | null;
  }) {
    return (
      <RelayPresenceProvider>
        {opts.presence ? <ConversationViewers conversationId={convId} /> : null}
        {showReplies ? (
          <RelayStreamingReplies
            conversationId={convId}
            messages={messages}
            agentStatus={agentStatus}
          />
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
        conversations: {
          [conversationId]: {
            _id: conversationId,
            title: "Streaming thread",
            agent_type: "codex",
          },
          [secondConversationId]: {
            _id: secondConversationId,
            title: "Second thread",
            agent_type: "codex",
          },
        } as never,
        relayTokenDeltas: {},
        relayViewerPresence: {},
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
      backend.mutation(api.relayGrants.mint, () => ok);
    },
  });

  return { ...ui, Surface };
}

test("flag off opens nothing and renders no relay streaming UI", async () => {
  const ui = await mountStreamingSurface({ tokenDeltas: false });
  try {
    await flushRender(ui);

    expect(sockets.length).toBe(0);
    expect(
      ui.backend.queryRequests.filter((q) => q.name.startsWith("relayGrants:")),
    ).toEqual([]);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});

test("only delta flag on offers only token_delta and avoids presence state or viewerIdentities queries", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    presence: false,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushRender(ui);

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
    });
    const connect = socket.frames.find((frame) => frame.type === "connect");
    expect(connect?.capabilities).toEqual(["token_delta"]);

    await act(async () => {
      socket.message({
        v: 1,
        type: "presence",
        hub: viewerHub,
        connection_id: "peer:1",
        seq: 1,
        ttl_ms: 15_000,
        user_id: "u-peer",
        state: "active",
        in_draft: false,
      });
    });
    expect(
      ui.store.getState().relayViewerPresence[conversationId],
    ).toBeUndefined();
    expect(
      ui.backend.queryRequests.some(
        (q) => q.name === "relayGrants:viewerIdentities",
      ),
    ).toBe(false);
  } finally {
    await ui.close();
  }
});

test("only presence flag on omits token_delta capability and never writes delta store status", async () => {
  const spy = spyOn(useInboxStore.getState(), "applyRelayTokenDeltaStatus");
  const ui = await mountStreamingSurface({
    tokenDeltas: false,
    presence: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushRender(ui);

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["presence"], viewerHub);
    });
    const connect = socket.frames.find((frame) => frame.type === "connect");
    expect(connect?.capabilities).not.toContain("token_delta");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    await ui.close();
  }
});

test("clears all streams of a turn when durable merged message arrives and clears old streams on new turn", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushRender(ui);

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
      socket.message(
        deltaFrame({
          seq: 1,
          run: 5,
          turn: "turn-1",
          message_id: "msg-1",
          delta_seq: 1,
          text: "First part",
        }),
      );
      socket.message(
        deltaFrame({
          seq: 2,
          run: 5,
          turn: "turn-1",
          message_id: "msg-2",
          delta_seq: 1,
          text: "Second part",
        }),
      );
    });
    await flushRender(ui);

    expect(
      ui.container.querySelectorAll('[data-testid="relay-streaming-reply"]'),
    ).toHaveLength(2);

    await ui.rerender(
      <ui.Surface
        messages={[{ role: "assistant", message_uuid: "msg-1" }]}
        agentStatus="working"
      />,
    );
    await flushRender(ui);

    expect(
      ui.container.querySelectorAll('[data-testid="relay-streaming-reply"]'),
    ).toHaveLength(0);

    await act(async () => {
      socket.message(
        deltaFrame({
          seq: 3,
          run: 5,
          turn: "turn-2",
          message_id: "msg-3",
          delta_seq: 1,
          text: "Turn two A",
        }),
      );
      socket.message(
        deltaFrame({
          seq: 4,
          run: 5,
          turn: "turn-3",
          message_id: "msg-4",
          delta_seq: 1,
          text: "Turn three B",
        }),
      );
    });
    await flushRender(ui);

    const rendered = ui.container.querySelectorAll(
      '[data-testid="relay-streaming-reply"]',
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.textContent).toContain("Turn three B");
    expect(rendered[0]?.textContent).not.toContain("Turn two A");
  } finally {
    await ui.close();
  }
});

test("sequence gap or exceeding 64 KiB stream limit drops relay text and waits for durable message", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushRender(ui);

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
      socket.message(deltaFrame({ seq: 1, delta_seq: 1, text: "Partial" }));
    });
    await flushRender(ui);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]')
        ?.textContent,
    ).toContain("Partial");

    await act(async () => {
      socket.message(deltaFrame({ seq: 2, delta_seq: 3, text: "skipped" }));
    });
    await flushRender(ui);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();

    await act(async () => {
      socket.message(
        deltaFrame({
          seq: 3,
          turn: "turn-2",
          message_id: "msg-big",
          delta_seq: 1,
          text: "A".repeat(4096),
        }),
      );
    });
    await flushRender(ui);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).not.toBeNull();

    await act(async () => {
      for (let i = 0; i < 16; i += 1) {
        socket.message(
          deltaFrame({
            seq: 4 + i,
            turn: "turn-2",
            message_id: "msg-big",
            delta_seq: 2 + i,
            text: "B".repeat(4096),
          }),
        );
      }
    });
    await flushRender(ui);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});

test("conversation switch resets turn tracking and unmount clears relayTokenDeltas while presence remains mounted", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    presence: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushRender(ui);

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["presence", "token_delta"], viewerHub);
    });
    const subscribes = socket.frames.filter((f) => f.type === "subscribe");
    expect(subscribes.length).toBe(1);

    await act(async () => {
      socket.message(deltaFrame({ seq: 1, delta_seq: 1, text: "Live line" }));
    });
    await flushRender(ui);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]')
        ?.textContent,
    ).toContain("Live line");

    await ui.rerender(
      <ui.Surface
        convId={conversationId}
        showReplies={false}
        messages={[]}
        agentStatus="working"
      />,
    );
    await flushRender(ui);
    expect(
      ui.store.getState().relayTokenDeltas[conversationId],
    ).toBeUndefined();

    await act(async () => {
      socket.message(
        deltaFrame({
          seq: 2,
          delta_seq: 1,
          turn: "turn-2",
          message_id: "msg-after-unmount",
          text: "Ignored",
        }),
      );
    });
    expect(
      ui.store.getState().relayTokenDeltas[conversationId],
    ).toBeUndefined();

    await ui.rerender(
      <ui.Surface
        convId={secondConversationId}
        showReplies={true}
        messages={[]}
        agentStatus="idle"
      />,
    );
    await flushRender(ui);
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});
