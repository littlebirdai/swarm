import { expect, test } from "bun:test";
import fc from "fast-check";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { planWarm, type WarmRow } from "../../hooks/inbox-warm";
import {
  __createInboxStoreForTests,
  ensureHydrated,
  useInboxStore,
  type InboxStoreState,
} from "../inboxStore";
import { flushConversationMessages, _reopenForTests } from "../idb-cache";
import { db } from "../persistence/db";
import { writeOwnerStamp } from "../persistence/ownership";
import {
  MESSAGE_CACHE_BUDGET_BYTES,
  MESSAGE_CACHE_PAGE_OVERHEAD,
  messageRowBytes,
  retainOpenMessageView,
} from "../store-eviction";

const row = (timestamp: number, content = "hi") => ({
  _id: `m-${timestamp}`,
  role: "user" as const,
  content,
  timestamp,
});
const large = "x".repeat(MESSAGE_CACHE_BUDGET_BYTES / 8);

function recount(store: InboxStoreState) {
  const pages = [store.messages, store.userMessages];
  const ids = new Set(pages.flatMap(Object.keys));
  return Object.fromEntries(
    [...ids].map((id) => [
      id,
      pages.reduce((bytes, page) => {
        const rows = page[id];
        if (!rows) return bytes;
        return (
          bytes +
          MESSAGE_CACHE_PAGE_OVERHEAD +
          rows.reduce((sum, message) => sum + messageRowBytes(message), 0)
        );
      }, 0),
    ]),
  );
}

test("keeps more than 400 small conversations and evicts whole conversations by bytes and last view", () => {
  const store = __createInboxStoreForTests();
  for (let i = 0; i < 405; i++) {
    store.getState().setMessages(`small-${i}`, [row(i)], {}, "cache");
  }
  expect(Object.keys(store.getState().messages)).toHaveLength(405);

  store.setState({
    _lastViewedAt: { first: 4, second: 1, third: 3, fourth: 2 },
  });
  for (const id of ["first", "second", "third", "fourth"]) {
    store.getState().setUserMessages(id, [row(1)], "cache");
    store.getState().setMessages(id, [row(1, large)], {}, "cache");
  }

  const state = store.getState();
  expect(Object.keys(state.messages).sort()).toEqual([
    "first",
    "fourth",
    "third",
  ]);
  expect(state.userMessages.second).toBeUndefined();
  expect(state.pagination.second).toBeUndefined();
  expect(state.messageCacheBytes).toBeLessThanOrEqual(
    MESSAGE_CACHE_BUDGET_BYTES,
  );
});

test("protects open panes, pending sends, queued sends and streaming conversations", () => {
  const store = __createInboxStoreForTests();
  const releasePane = retainOpenMessageView("pane");
  const releaseOtherPane = retainOpenMessageView("pane");
  const now = Date.now();
  store.setState({
    _lastViewedAt: { pane: 1, pending: 2, queued: 3, stream: 4, recent: 5 },
    sessions: {
      stream: {
        _id: "stream",
        agent_status: "working",
        message_count: 1,
        updated_at: now,
        last_heartbeat: now,
        is_idle: false,
      },
    } as InboxStoreState["sessions"],
  });
  try {
    store.getState().addOptimisticMessage("pending", "unsent");
    store.getState().setQueuedMessagesFor("queued", ["queued"]);
    for (const id of ["pane", "pending", "queued", "stream"]) {
      store.getState().setMessages(id, [row(1, large)], {}, "cache");
    }
    releasePane();
    store.getState().setMessages("recent", [row(1, large)], {}, "cache");
    expect(Object.keys(store.getState().messages).sort()).toEqual([
      "pane",
      "pending",
      "queued",
      "stream",
    ]);
    expect(store.getState().pendingMessages.pending[0].content).toBe("unsent");
    releaseOtherPane();
    store.getState().trimMessageCache();
    expect(store.getState().messages.pane).toBeUndefined();
    expect(store.getState().messageCacheBytes).toBeLessThanOrEqual(
      MESSAGE_CACHE_BUDGET_BYTES,
    );
  } finally {
    releasePane();
    releaseOtherPane();
  }
});

test("keeps inline-only images and strips redundant bytes from stored attachment references", () => {
  const store = __createInboxStoreForTests();
  const inline = { media_type: "image/png", data: "aW1hZ2U=" };
  const backed = {
    media_type: "image/png",
    storage_id: "image",
    tool_use_id: "tool",
  };
  const message = {
    ...row(1),
    images: [inline, { ...backed, data: "aW1hZ2U=" }],
  };
  store.getState().setMessages("image-chat", [message], {}, "cache");
  store.getState().setUserMessages("image-chat", [message], "cache");
  expect(store.getState().messages["image-chat"][0].images).toEqual([
    inline,
    backed,
  ]);
  expect(store.getState().userMessages["image-chat"][0].images).toEqual([
    inline,
    backed,
  ]);
  expect(message.images[1].data).toBe("aW1hZ2U=");
});

test("incremental byte counts match a full recount after edits, deletions and rekeys", () => {
  const action = fc.record({
    kind: fc.constantFrom(
      "snapshot",
      "tail",
      "append",
      "prepend",
      "navigator",
      "delete",
      "rekey",
    ),
    id: fc.constantFrom("a", "b", "c"),
    content: fc.string({ maxLength: 100 }),
    timestamp: fc.integer({ min: 1, max: 8 }),
  });
  fc.assert(
    fc.property(
      fc.array(action, { minLength: 20, maxLength: 60 }),
      (actions) => {
        const store = __createInboxStoreForTests();
        for (const { kind, id, timestamp, content } of actions) {
          const state = store.getState();
          const msg = row(timestamp, content);
          if (kind === "snapshot") state.setMessages(id, [msg], {}, "cache");
          else if (kind === "tail") state.applyTailMessages(id, 0, [msg], 8);
          else if (kind === "append" || kind === "prepend")
            state.mergeMessages(id, [msg], kind);
          else if (kind === "navigator")
            state.setUserMessages(id, [msg], "cache");
          else if (kind === "delete") state.discardForkStub(id);
          else state.resolveForkSessionId(id, id === "a" ? "b" : "a");

          const actual = store.getState();
          const totals = recount(actual);
          expect(actual.messageCacheBytesByConversation).toEqual(totals);
          expect(actual.messageCacheBytes).toBe(
            Object.values(totals).reduce((sum, bytes) => sum + bytes, 0),
          );
        }
      },
    ),
    { seed: 16 },
  );
});

test("rehydrates an evicted transcript and navigator from disk without resetting its read markers", async () => {
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
  const id = "restorable";
  const message = {
    ...row(Date.now(), "An image sent offline"),
    images: [{ media_type: "image/png", data: "aW1hZ2U=" }],
  };
  const original = useInboxStore.getState();
  useInboxStore.setState({
    _lastViewedAt: { [id]: 1 },
    _seenUpToAt: { [id]: 123 },
    _seenMessageCount: { [id]: 7 },
  });
  try {
    useInboxStore.getState().setMessages(id, [message], { initialized: true });
    useInboxStore.getState().setUserMessages(id, [message]);
    flushConversationMessages();
    await db.transaction(
      "r",
      db.conversationMessageRows,
      db.conversationUserMessages,
      () => db.conversationMessageRows.count(),
    );
    useInboxStore.setState({
      _lastViewedAt: { [id]: 1, a: 2, b: 3, c: 4, d: 5 },
    });
    for (const other of ["a", "b", "c", "d"]) {
      useInboxStore.getState().setMessages(other, [row(1, large)], {}, "cache");
    }
    expect(useInboxStore.getState().messages[id]).toBeUndefined();
    const release = retainOpenMessageView(id);
    try {
      expect(await ensureHydrated(id)).toBe(true);
      const restored = useInboxStore.getState();
      expect(restored.messages[id]).toEqual([message]);
      expect(restored.userMessages[id]).toEqual([message]);
      expect(restored.pagination[id].initialized).toBe(true);
      expect(restored._seenUpToAt[id]).toBe(123);
      expect(restored._seenMessageCount[id]).toBe(7);
    } finally {
      release();
    }
  } finally {
    useInboxStore.setState(original);
    db.close();
  }
});

test("cache pressure suppresses cold warms and deepens while allowing deltas", () => {
  const cold: WarmRow = {
    id: "evicted",
    serverCount: 101,
    storedCount: 0,
    hasMoreAbove: false,
    newestTs: null,
    syncedCount: undefined,
    inFlight: false,
  };
  const shallow: WarmRow = {
    ...cold,
    id: "shallow",
    storedCount: 60,
    newestTs: 2,
    hasMoreAbove: true,
    syncedCount: 100,
  };
  expect(planWarm([cold, shallow]).map(({ kind }) => kind)).toEqual([
    "cold",
    "deepen",
  ]);
  expect(planWarm([cold, shallow], true)).toEqual([
    { kind: "delta", id: "shallow", after: 1, serverCount: 101 },
  ]);
});
