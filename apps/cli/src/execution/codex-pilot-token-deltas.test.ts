import { expect, test } from "bun:test";
import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import type { TokenDelta } from "@codecast/edge-client/relay-liveness";
import type { CanonicalEvent, MessageDelta } from "@codecast/edge-contract";
import type { ProviderOwnedSession } from "@codecast/provider-adapter";
import { writeOwnedPilotEvents } from "./codex-pilot-cleanup.js";
import type { CodexPilotDelivery } from "./codex-pilot-delivery.js";
import { CodexPilotDisplay } from "./codex-pilot-display.js";
import type { CodexPilotEvents } from "./codex-pilot-events.js";
import type { CodexPilotPromptCards } from "./codex-pilot-prompt-cards.js";
import { readOwnedCodexRelayFlags } from "./codex-pilot-settings.js";
import {
  createCodexPilotDeltaPublisher,
  splitTokenDeltaText,
} from "./codex-pilot-token-deltas.js";

const claim: ClaimGrant = {
  run: 7,
  lease: {
    session: "conv-1",
    fencing_token: "fence-7",
    expires_at: Date.now() + 60_000,
    heartbeat_interval_ms: 5_000,
    next_seq: 1,
    delivery_fence: {
      session: "conv-1",
      run: 7,
      fencing_token: "fence-7",
    },
  },
} as unknown as ClaimGrant;

const binding: ReadyBinding = {
  conversationId: "conv-1",
  epoch: 1,
  requestedAgent: "codex",
  actualAgent: "codex",
  transport: "app-server",
  runtimeId: "thread-1",
  handle:
    'owned-codex:{"threadId":"thread-1","sandbox":"read-only","approvalPolicy":"on-request"}',
  ownerDeviceId: "machine-1",
  daemonBootId: "boot-1",
  operationId: "op-1",
  appliedConfigurationRevision: 1,
  protocolVersion: 1,
  capabilities: [],
};

function deltaEvent(
  turn: string,
  message_id: string,
  text: string,
  offset = 0,
): MessageDelta {
  return {
    v: 1,
    session: "conv-1",
    run: 7,
    at: 1000,
    source: "provider",
    turn,
    kind: "message.delta",
    body: { message_id, offset, text },
  };
}

test("readOwnedCodexRelayFlags keeps tokenDeltas off by default", () => {
  expect(readOwnedCodexRelayFlags({})).toEqual({
    liveness: false,
    tokenDeltas: false,
  });
  expect(
    readOwnedCodexRelayFlags({ CODECAST_RELAY_TOKEN_DELTAS: "1" }),
  ).toEqual({
    liveness: false,
    tokenDeltas: true,
  });
});

test("splitTokenDeltaText splits oversized UTF-8 text on codepoint boundaries", () => {
  const emoji = "\u{1F680}";
  const longText = `${emoji.repeat(700)}end`;
  const chunks = splitTokenDeltaText(longText, 1024);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.join("")).toBe(longText);
  for (const chunk of chunks) {
    expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1024);
    expect([...chunk].every((cp) => (cp.codePointAt(0) ?? 0) > 0)).toBe(true);
  }
});

test("createCodexPilotDeltaPublisher assigns monotonic delta_seq per message and respects flag", () => {
  const published: TokenDelta[] = [];
  const off = createCodexPilotDeltaPublisher({
    enabled: false,
    run: 7,
    session: "conv-1",
    publish: () => (delta) => {
      published.push(delta);
      return true;
    },
  });
  off(deltaEvent("turn-1", "msg-1", "ignored"));
  expect(published).toEqual([]);

  const on = createCodexPilotDeltaPublisher({
    enabled: true,
    run: 7,
    session: "conv-1",
    publish: () => (delta) => {
      published.push(delta);
      return true;
    },
  });
  on(deltaEvent("turn-1", "msg-1", "He", 0));
  on(deltaEvent("turn-1", "msg-1", "llo", 2));
  on(deltaEvent("turn-1", "msg-2", "World", 0));
  on(deltaEvent("turn-2", "msg-1", "Next", 0));

  expect(
    published.map((d) => [d.turn, d.message_id, d.delta_seq, d.text]),
  ).toEqual([
    ["turn-1", "msg-1", 1, "He"],
    ["turn-1", "msg-1", 2, "llo"],
    ["turn-1", "msg-2", 1, "World"],
    ["turn-2", "msg-1", 1, "Next"],
  ]);
});

test("writeOwnedPilotEvents publishes token deltas fail-open without delaying durable writes", async () => {
  const appended: CanonicalEvent[] = [];
  const synced: string[] = [];
  const deltas: TokenDelta[] = [];
  let relayDown = true;

  const eventsList: Array<CanonicalEvent | MessageDelta> = [
    {
      v: 1,
      session: "conv-1",
      run: 7,
      seq: 1,
      at: 1000,
      source: "provider",
      turn: "turn-1",
      kind: "turn.started",
      body: {},
    } as CanonicalEvent,
    deltaEvent("turn-1", "msg-1", "First ", 0),
    deltaEvent("turn-1", "msg-1", "second", 6),
    {
      v: 1,
      session: "conv-1",
      run: 7,
      seq: 2,
      at: 1010,
      source: "provider",
      turn: "turn-1",
      kind: "message.assistant",
      body: { message_id: "msg-1", text: "First second" },
    },
    {
      v: 1,
      session: "conv-1",
      run: 7,
      seq: 3,
      at: 1020,
      source: "provider",
      turn: "turn-1",
      kind: "turn.ended",
      body: { reason: "completed" },
    },
  ];

  async function* stream() {
    for (const event of eventsList) {
      yield event;
    }
  }

  const session = {
    events: stream(),
  } as unknown as ProviderOwnedSession;

  const start = performance.now();
  await writeOwnedPilotEvents({
    claim,
    session,
    binding,
    model: "gpt-5",
    signal: new AbortController().signal,
    options: {
      siteUrl: "https://pilot.invalid",
      bearer: "bearer",
      command: () => ["codex"],
      permissions: () => ({
        sandbox: "read-only",
        approvalPolicy: "on-request",
      }),
      instructions: async () => undefined,
      display: {
        syncService: {} as never,
        retryQueue: {} as never,
        conversationCache: {},
        mapCodexAppServerThreadStatusToAgentStatus: () => "working",
        sendAgentStatus: () => {},
        trackTmuxSpawns: async () => {},
        syncMessagesBatch: async (messages) => {
          for (const msg of messages) {
            if (msg.content) synced.push(msg.content);
          }
        },
      },
      log: () => {},
    },
    events: {
      appendEvent: async (_claim: ClaimGrant, event: CanonicalEvent) => {
        appended.push(event);
      },
    } as unknown as CodexPilotEvents,
    delivery: {
      attributeTurnStart: (event: CanonicalEvent) => event,
      observe: async () => {},
    } as unknown as CodexPilotDelivery,
    promptCards: {
      publish: async () => {},
    } as unknown as CodexPilotPromptCards,
    display: new CodexPilotDisplay(),
    publishDelta: () => (delta) => {
      if (relayDown) {
        relayDown = false;
        throw new Error("relay socket down");
      }
      deltas.push(delta);
      return true;
    },
    onProgress: () => {},
  });
  const elapsedMs = performance.now() - start;

  expect(elapsedMs).toBeLessThan(200);
  expect(appended.map((event) => event.kind)).toEqual([
    "turn.started",
    "message.assistant",
    "turn.ended",
  ]);
  expect(synced).toEqual(["First second"]);
  expect(deltas).toEqual([
    {
      session: "conv-1",
      run: 7,
      turn: "turn-1",
      message_id: "msg-1",
      delta_seq: 2,
      text: "second",
    },
  ]);
});
