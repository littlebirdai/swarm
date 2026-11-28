import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../../store/inboxStore";
import { mountWeb } from "../../../test-helpers/mountWeb";
import {
  ok,
  relayMountFixture,
} from "../../../test-helpers/relay-presence-testkit";
import { ConversationViewers } from "../../presence/ViewerFaces";
import { RelayPresenceProvider } from "../../relay-presence-provider";
import { RelayStreamingReplies } from "../relay-streaming-replies";

const conversationId = "d".repeat(32) as Id<"conversations">;
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

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  delete process.env.VITE_RELAY_TOKEN_DELTAS;
  delete process.env.VITE_RELAY_PRESENCE;
  delete process.env.VITE_RELAY_URL;
  useInboxStore.setState({ relayTokenDeltas: {} });
});

async function mountStreamingSurface(opts: {
  tokenDeltas: boolean;
  presence?: boolean;
  messages?: Array<{ message_uuid?: string }>;
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
    messages = opts.messages ?? [],
    agentStatus = opts.agentStatus ?? "working",
  }: {
    messages?: Array<{ message_uuid?: string }>;
    agentStatus?: string | null;
  }) {
    return (
      <RelayPresenceProvider>
        {opts.presence ? (
          <ConversationViewers conversationId={conversationId} />
        ) : null}
        <RelayStreamingReplies
          conversationId={conversationId}
          messages={messages}
          agentStatus={agentStatus}
        />
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
        } as never,
        relayTokenDeltas: {},
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
    await flushMicrotasks();

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

test("streams token deltas while turn is open and replaces with durable message when it arrives", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushMicrotasks();

    expect(sockets.length).toBe(1);
    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
    });

    const connect = socket.frames.find((frame) => frame.type === "connect");
    expect(connect?.capabilities).toContain("token_delta");

    await act(async () => {
      socket.message(deltaFrame({ seq: 1, delta_seq: 1, text: "Hello " }));
      socket.message(deltaFrame({ seq: 2, delta_seq: 2, text: "world!" }));
    });

    const rendered = ui.container.querySelector(
      '[data-testid="relay-streaming-reply"]',
    );
    expect(rendered).not.toBeNull();
    expect(rendered?.textContent).toContain("Hello world!");

    await ui.rerender(
      <ui.Surface
        messages={[{ message_uuid: "msg-1" }]}
        agentStatus="working"
      />,
    );
    await flushMicrotasks();

    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});

test("sequence gap drops relay text and waits for durable message", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushMicrotasks();

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
    });

    await act(async () => {
      socket.message(deltaFrame({ seq: 1, delta_seq: 1, text: "Partial " }));
    });
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]')
        ?.textContent,
    ).toContain("Partial");

    await act(async () => {
      socket.message(deltaFrame({ seq: 2, delta_seq: 3, text: "skipped" }));
    });
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();

    await act(async () => {
      socket.message(deltaFrame({ seq: 3, delta_seq: 4, text: "more" }));
    });
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});

test("hides streaming text when turn closes", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushMicrotasks();

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
      socket.message(deltaFrame({ seq: 1, delta_seq: 1, text: "Streaming" }));
    });
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]')
        ?.textContent,
    ).toContain("Streaming");

    await ui.rerender(<ui.Surface messages={[]} agentStatus="idle" />);
    await flushMicrotasks();
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});

test("clears streaming text when relay access fails or is revoked", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushMicrotasks();

    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["token_delta"], viewerHub);
      socket.message(
        deltaFrame({ seq: 1, delta_seq: 1, text: "Revoked soon" }),
      );
    });
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]')
        ?.textContent,
    ).toContain("Revoked soon");

    await act(async () => {
      socket.fail();
    });
    expect(
      ui.container.querySelector('[data-testid="relay-streaming-reply"]'),
    ).toBeNull();
  } finally {
    await ui.close();
  }
});

test("shares one ref-counted viewer subscription when presence and token deltas are both enabled", async () => {
  const ui = await mountStreamingSurface({
    tokenDeltas: true,
    presence: true,
    messages: [],
    agentStatus: "working",
  });
  try {
    await flushMicrotasks();

    expect(sockets.length).toBe(1);
    const socket = sockets[0]!;
    await act(async () => {
      socket.join(["presence", "token_delta"], viewerHub);
    });

    const subscribes = socket.frames.filter((f) => f.type === "subscribe");
    expect(subscribes.length).toBe(1);
  } finally {
    await ui.close();
  }
});
