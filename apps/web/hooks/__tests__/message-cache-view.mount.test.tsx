import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { cacheStorage } from "../../store/idb-cache";
import { pending } from "../../test-helpers/testConvex";
import { AgentDock } from "../../components/agentDock/agent-dock";
import { webBuilders } from "../../test-helpers/builders";
import { SessionPrewarm } from "../../components/session-prewarm";
import { useInboxStore, type Message } from "../../store/inboxStore";
import { MESSAGE_CACHE_BUDGET_BYTES } from "../../store/store-eviction";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useConversationMessages } from "../use-conversation-messages";

const sessionId = "cache-view-stub";
const reserveId = "cache-reserve-stub";

function Transcript() {
  useConversationMessages(sessionId);
  return null;
}

test.each([
  ["mounted transcript", <Transcript key="transcript" />, true],
  [
    "background prewarm",
    <SessionPrewarm key="prewarm" sessionId={sessionId} />,
    false,
  ],
] as const)(
  "%s retains messages only while they are on screen",
  async (_label, node, retained) => {
    const mounted = await mountWeb(node, {
      setup: (_backend, store) => {
        store.setMessages(
          sessionId,
          [
            {
              _id: "line",
              role: "assistant",
              content: "visible",
              timestamp: 1,
            },
          ],
          {},
          "cache",
        );
        useInboxStore.setState({
          queuedMessages: { [reserveId]: ["pending"] },
        });
      },
    });
    try {
      await act(async () => {
        useInboxStore.getState().setMessages(
          reserveId,
          [
            {
              _id: "reserve",
              role: "assistant",
              content: "a".repeat(MESSAGE_CACHE_BUDGET_BYTES / 2),
              timestamp: 2,
            },
          ],
          {},
          "cache",
        );
      });
      expect(Boolean(useInboxStore.getState().messages[sessionId])).toBe(
        retained,
      );
      await mounted.rerender(null);
      expect(useInboxStore.getState().messages[sessionId]).toBeUndefined();
    } finally {
      await mounted.close();
    }
  },
);

test("the open agent dock keeps its visible reply under cache pressure", async () => {
  const now = Date.now();
  const dockSession = webBuilders(
    "message-cache-view.mount.test.tsx",
  ).session.build({
    _id: sessionId,
    title: "Cache test agent",
    user_id: "cache-user",
    owner_user_id: "cache-user",
    owned_by_me: true,
    agent_status: "done",
    updated_at: now - 60_000,
    agent_status_updated_at: now - 60_000,
    started_at: now - 70_000,
    message_count: 1,
  });
  const mounted = await mountWeb(<AgentDock />, {
    setup: (_backend, store) => {
      useInboxStore.setState({
        currentUser: { _id: "cache-user" },
        queuedMessages: { [reserveId]: ["pending"] },
      });
      store.seedSession(dockSession);
      store.setMessages(
        sessionId,
        [
          {
            _id: "reply",
            role: "assistant",
            content: "The dock reply stays visible.",
            timestamp: 1,
          },
        ],
        {},
        "cache",
      );
    },
  });
  try {
    const dot = mounted.container.querySelector<HTMLButtonElement>(
      'button[title="Cache test agent"]',
    );
    expect(dot).not.toBeNull();
    await act(async () => dot!.click());
    expect(mounted.container.textContent).toContain(
      "The dock reply stays visible.",
    );
    await act(async () => {
      useInboxStore.getState().setMessages(
        reserveId,
        [
          {
            _id: "reserve",
            role: "assistant",
            content: "a".repeat(MESSAGE_CACHE_BUDGET_BYTES / 2),
            timestamp: 2,
          },
        ],
        {},
        "cache",
      );
    });
    expect(mounted.container.textContent).toContain(
      "The dock reply stays visible.",
    );
  } finally {
    await mounted.close();
  }
});

const cacheBuilders = webBuilders("message-cache-view.mount.test.tsx");
const liveSession = cacheBuilders.session.build({ message_count: 2 });
function transcriptRow(content: string, timestamp: number) {
  return {
    _id: cacheBuilders.message.build()._id as Id<"messages">,
    _creationTime: timestamp,
    conversation_id: liveSession._id as Id<"conversations">,
    role: "assistant" as const,
    content,
    timestamp,
  };
}
const first = transcriptRow("Original history", 100);
const second = transcriptRow("Snapshot tail", 200);
const live = transcriptRow("Live reply", 300);

function LiveTranscript() {
  const { conversation } = useConversationMessages(liveSession._id);
  return (
    <div>
      {conversation?.messages.map((row: Message) => row.content).join(" ")}
    </div>
  );
}

function snapshot(...page: (typeof first)[]) {
  return { isDone: true, continueCursor: "", page };
}

function configureTranscript(
  backend: Awaited<ReturnType<typeof mountWeb>>["backend"],
) {
  backend.set(api.conversations.getConversationWithMeta, pending);
  backend.set(api.conversations.getTranscriptWatermark, pending);
  backend.set(api.conversations.getUserMessages, pending);
  backend.set(api.conversations.listMessagesTail, pending);
  backend.set(api.conversations.getNewMessages, {
    messages: [live],
    has_more: false,
    last_timestamp: live.timestamp,
    updated_at: live.timestamp,
    title: "Cache test conversation",
  });
}

test("a visible cold open retries a failed snapshot and then anchors its live tail", async () => {
  const mounted = await mountWeb(<LiveTranscript />, {
    clock: true,
    setup(backend, store) {
      store.seedSession(liveSession);
      configureTranscript(backend);
      backend.set(
        api.conversations.listMessages,
        new Error("first snapshot failed"),
      );
    },
  });
  try {
    await mounted.clock!.advance(0);
    expect(
      mounted.backend.queryRequests.filter(
        (call) => call.name === "conversations:listMessages",
      ),
    ).toHaveLength(1);
    expect(mounted.container.textContent).not.toContain(first.content);
    mounted.backend.set(
      api.conversations.listMessages,
      snapshot(second, first),
    );
    await mounted.clock!.advance(1000);
    expect(mounted.container.textContent).toContain(first.content);
    expect(mounted.container.textContent).toContain(second.content);
    expect(mounted.backend.queryRequests).toContainEqual({
      name: "conversations:listMessagesTail",
      args: { conversation_id: liveSession._id, after_timestamp: 199 },
    });
    expect(
      mounted.backend.queryRequests.some(
        (call) => call.name === "conversations:getNewMessages",
      ),
    ).toBe(false);
  } finally {
    await mounted.close();
  }
});

test("an evicted prewarm ignores its anchored tail push and stays evicted", async () => {
  const mounted = await mountWeb(
    <SessionPrewarm sessionId={liveSession._id} />,
    {
      clock: true,
      setup(backend, store) {
        store.seedSession(liveSession);
        store.setMessages(liveSession._id, [first, second], {}, "cache");
        configureTranscript(backend);
        backend.set(api.conversations.listMessages, snapshot(second, first));
      },
    },
  );
  const write = spyOn(
    cacheStorage,
    "writeConversationMessages",
  ).mockImplementation(() => {});
  try {
    await mounted.clock!.advance(0);
    expect(mounted.backend.queryRequests).toContainEqual({
      name: "conversations:listMessagesTail",
      args: { conversation_id: liveSession._id, after_timestamp: 199 },
    });
    await act(async () => {
      mounted.store
        .getState()
        .setMessages(
          reserveId,
          [{ ...live, content: "a".repeat(MESSAGE_CACHE_BUDGET_BYTES / 2) }],
          {},
          "cache",
        );
      mounted.store.getState().discardForkStub(reserveId);
    });
    expect(mounted.store.getState().messages[liveSession._id]).toBeUndefined();
    await act(async () => {
      mounted.backend.set(api.conversations.listMessagesTail, {
        messages: [live],
        has_more: false,
        last_timestamp: live.timestamp,
      });
    });
    await mounted.clock!.advance(1000);
    expect(mounted.store.getState().messages[liveSession._id]).toBeUndefined();
    expect(
      mounted.store.getState().pagination[liveSession._id],
    ).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(
      mounted.backend.queryRequests.some(
        (call) => call.name === "conversations:listMessages",
      ),
    ).toBe(false);
  } finally {
    write.mockRestore();
    await mounted.close();
  }
});

test("a tail anchored at zero can populate an empty conversation", async () => {
  const mounted = await mountWeb(<LiveTranscript />, {
    clock: true,
    setup(backend, store) {
      store.seedSession({ ...liveSession, message_count: 0 });
      configureTranscript(backend);
      backend.set(api.conversations.listMessages, snapshot());
    },
  });
  try {
    await mounted.clock!.advance(0);
    expect(mounted.backend.queryRequests).toContainEqual({
      name: "conversations:listMessagesTail",
      args: { conversation_id: liveSession._id, after_timestamp: 0 },
    });
    await act(async () => {
      mounted.backend.set(api.conversations.listMessagesTail, {
        messages: [first],
        has_more: false,
        last_timestamp: first.timestamp,
      });
    });
    expect(mounted.container.textContent).toContain(first.content);
  } finally {
    await mounted.close();
  }
});

test("an empty snapshot with a stale message count stays quiet until its tail delivers", async () => {
  const mounted = await mountWeb(<LiveTranscript />, {
    clock: true,
    setup(backend, store) {
      store.seedSession({ ...liveSession, message_count: 5 });
      configureTranscript(backend);
      backend.set(api.conversations.listMessages, snapshot());
    },
  });
  const write = spyOn(cacheStorage, "writeConversationMessages");
  try {
    await mounted.clock!.advance(0);
    write.mockClear();
    for (let tick = 0; tick < 5; tick++) await mounted.clock!.advance(1000);
    expect(
      mounted.backend.queryRequests.filter(
        (call) => call.name === "conversations:listMessages",
      ),
    ).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
      mounted.backend.set(api.conversations.listMessagesTail, {
        messages: [first],
        has_more: false,
        last_timestamp: first.timestamp,
      });
    });
    expect(mounted.container.textContent).toContain(first.content);
  } finally {
    write.mockRestore();
    await mounted.close();
  }
});

test.each(["disk read", "snapshot"] as const)(
  "deleting a prewarmed session during a %s leaves it deleted",
  async (stage) => {
    const disk = Promise.withResolvers<null>();
    const load =
      stage === "disk read"
        ? spyOn(cacheStorage, "loadConversationMessages").mockImplementation(
            () => disk.promise,
          )
        : undefined;
    const mounted = await mountWeb(
      <SessionPrewarm sessionId={liveSession._id} />,
      {
        clock: true,
        setup(backend, store) {
          store.seedSession(liveSession);
          store._setDispatch(async () => null);
          configureTranscript(backend);
          backend.set(api.conversations.listMessages, pending);
        },
      },
    );
    const write = spyOn(
      cacheStorage,
      "writeConversationMessages",
    ).mockImplementation(() => {});
    const snapshots = () =>
      mounted.backend.queryRequests.filter(
        (call) => call.name === "conversations:listMessages",
      );
    try {
      await mounted.clock!.advance(0);
      expect(snapshots()).toHaveLength(stage === "disk read" ? 0 : 1);
      if (load) expect(load).toHaveBeenCalledWith(liveSession._id);
      await act(async () =>
        mounted.store.getState().deleteSession(liveSession._id),
      );
      await act(async () => {
        mounted.backend.set(
          api.conversations.listMessages,
          snapshot(second, first),
        );
        disk.resolve(null);
      });
      expect(
        mounted.store.getState().messages[liveSession._id],
      ).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
      expect(snapshots()).toHaveLength(stage === "disk read" ? 0 : 1);
    } finally {
      disk.resolve(null);
      write.mockRestore();
      load?.mockRestore();
      await mounted.close();
    }
  },
);
