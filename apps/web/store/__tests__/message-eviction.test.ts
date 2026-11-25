import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  AUTH_JWT_STORAGE_KEY,
  issueFakeToken,
  mapStorage,
} from "./fixtures/fakeAuthToken";
import { webBuilders } from "../../test-helpers/builders";
import { replaceGlobals } from "../../test-helpers/globals";
import {
  planWarm,
  warmVisibleSessions,
  warmRowsFromState,
  type WarmRow,
} from "../../hooks/inbox-warm";
import {
  __createInboxStoreForTests,
  clearProtectedInboxMemory,
  ensureHydrated,
  useInboxStore,
  type InboxStoreState,
} from "../inboxStore";
import {
  flushConversationMessages,
  flushPendingMessageJournal,
  _reopenForTests,
} from "../idb-cache";
import { db } from "../persistence/db";
import {
  ensureCacheOwnership,
  writeOwnerStamp,
} from "../persistence/ownership";
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
  expect(Object.keys(state.messages).sort()).toEqual(["first", "fourth"]);
  expect(state.userMessages.second).toBeUndefined();
  expect(state.pagination.second).toBeUndefined();
  expect(state.messageCacheBytes).toBeLessThanOrEqual(
    MESSAGE_CACHE_BUDGET_BYTES * 0.75,
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
  store.setState({
    pendingMessages: {
      pending: [{ ...row(Date.now(), "unsent"), _isOptimistic: true }],
    },
    queuedMessages: { queued: ["queued"] },
  });
  try {
    for (const id of ["pane", "pending", "queued", "stream"]) {
      store.getState().setMessages(id, [row(1, large)], {}, "cache");
    }
    releasePane();
    store.getState().setMessages("recent", [row(1, large)], {}, "cache");
    expect(Object.keys(store.getState().messages).sort()).toEqual([
      "pane",
      "pending",
      "queued",
      "recent",
      "stream",
    ]);
    expect(store.getState().pendingMessages.queued).toBeUndefined();
    expect(store.getState().pendingMessages.pending[0].content).toBe("unsent");
    releaseOtherPane();
    store.getState().trimMessageCache();
    expect(store.getState().messages.pane).toBeUndefined();
    expect(store.getState().messages.recent).toBeUndefined();
    expect(store.getState().messages.queued).toBeDefined();
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
  const principal = "userA";
  const storage = mapStorage();
  storage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken(principal));
  const restoreGlobals = replaceGlobals({ localStorage: storage });
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
    await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
    await db.meta.put({ key: "currentUser", value: { _id: principal } });
    await writeOwnerStamp(principal, "test-fixture");
    expect(await ensureCacheOwnership()).toBe(principal);
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
    restoreGlobals();
  }
});

test.each(["snapshot", "cache", "merge", "tail", "navigator"] as const)(
  "%s keeps the conversation the write just loaded",
  (kind) => {
    const store = __createInboxStoreForTests();
    store.setState({ _lastViewedAt: { old: 1, recent: 2 } });
    store.getState().setMessages("old", [row(1, large)], {}, "cache");
    store.getState().setMessages("recent", [row(1, large)], {}, "cache");
    const state = store.getState();
    const message = row(2, large.repeat(3));
    if (kind === "snapshot" || kind === "cache")
      state.setMessages(
        "incoming",
        [message],
        {},
        kind === "cache" ? "cache" : undefined,
      );
    else if (kind === "merge")
      state.mergeMessages("incoming", [message], "append");
    else if (kind === "tail")
      state.applyTailMessages("incoming", 0, [message], 2);
    else state.setUserMessages("incoming", [message], "cache");
    const next = store.getState();
    const rows = kind === "navigator" ? next.userMessages : next.messages;
    expect(rows.incoming).toEqual([message]);
    expect(next.messages.old).toBeUndefined();
    expect(next.messages.recent).toBeUndefined();
  },
);

test("pending navigation protects rows until the destination clears", async () => {
  const original = useInboxStore.getState();
  useInboxStore.setState({
    messages: {},
    userMessages: {},
    pagination: {},
    messageCacheBytes: 0,
    messageCacheBytesByConversation: {},
    queuedMessages: { reserve: ["unsent"] },
  });
  try {
    useInboxStore.getState().requestNavigate("destination");
    useInboxStore
      .getState()
      .setMessages("destination", [row(1, large)], {}, "cache");
    useInboxStore
      .getState()
      .setMessages("reserve", [row(1, large.repeat(4))], {}, "cache");
    expect(useInboxStore.getState().messages.destination).toBeDefined();
    useInboxStore.setState({ pendingNavigateId: null });
    await Promise.resolve();
    expect(useInboxStore.getState().messages.destination).toBeUndefined();
  } finally {
    useInboxStore.setState(original);
  }
});

test("session updates do not schedule a trim if only protected conversations are over budget", async () => {
  const original = useInboxStore.getState();
  const trim = spyOn(original, "trimMessageCache");
  useInboxStore.setState({
    messages: {},
    userMessages: {},
    pagination: {},
    messageCacheBytes: 0,
    messageCacheBytesByConversation: {},
    queuedMessages: { reserve: ["unsent"] },
  });
  try {
    useInboxStore
      .getState()
      .setMessages("reserve", [row(1, large.repeat(4))], {}, "cache");
    useInboxStore.setState({
      sessions: { ...useInboxStore.getState().sessions },
    });
    await Promise.resolve();
    expect(trim).not.toHaveBeenCalled();
    useInboxStore.setState({ queuedMessages: {} });
    await Promise.resolve();
    expect(trim).toHaveBeenCalledTimes(1);
    expect(useInboxStore.getState().messages.reserve).toBeUndefined();
  } finally {
    trim.mockRestore();
    useInboxStore.setState(original);
  }
});

test("an evicted transcript can warm again after activity and an account reset", async () => {
  const { session } = webBuilders("message-eviction.test.ts");
  const old = "jx70000000000000000000000warmold";
  const owner = "warm-owner";
  const now = Date.now();
  const build = (id: string, offset: number) =>
    session.build({
      _id: id,
      user_id: owner,
      owner_user_id: owner,
      owned_by_me: true,
      agent_status: "done",
      updated_at: now - 60_000 + offset,
      agent_status_updated_at: now - 60_000 + offset,
      message_count: 1,
    });
  const original = useInboxStore.getState();
  useInboxStore.setState({
    messages: {},
    userMessages: {},
    pagination: {},
    messageCacheBytes: 0,
    messageCacheBytesByConversation: {},
    currentUser: { _id: owner },
    sessions: { [old]: build(old, 0) },
    liveInboxIds: new Set([old]),
    _lastViewedAt: { [old]: 0, a: 1, b: 2, c: 3, d: 4 },
  });
  const queries: string[] = [];
  const convex = {
    query: async (_fn: unknown, args: { conversation_id: string }) => {
      queries.push(args.conversation_id);
      return { page: [row(1, "m".repeat(512 * 1024))], isDone: true };
    },
  };
  const warmAndWait = async () => {
    await warmVisibleSessions(convex);
    expect(useInboxStore.getState().messages[old]).toBeDefined();
  };
  try {
    await warmAndWait();
    for (const id of ["a", "b", "c", "d"])
      useInboxStore.getState().setMessages(id, [row(1, large)], {}, "cache");
    expect(useInboxStore.getState().messages[old]).toBeUndefined();
    expect(useInboxStore.getState().messageCacheBytes).toBeLessThanOrEqual(
      MESSAGE_CACHE_BUDGET_BYTES * 0.75,
    );
    useInboxStore.setState({
      sessions: { [old]: { ...build(old, 1), message_count: 2 } },
    });
    await warmAndWait();
    clearProtectedInboxMemory();
    useInboxStore.setState({
      currentUser: { _id: "new-warm-owner" },
      sessions: {
        [old]: {
          ...build(old, 3),
          user_id: "new-warm-owner",
          owner_user_id: "new-warm-owner",
        },
      },
    });
    await warmAndWait();
    expect(queries).toContain(old);
  } finally {
    useInboxStore.setState(original);
  }
});

test("a tail write that clears its pending echo keeps the newly loaded transcript", async () => {
  const original = useInboxStore.getState();
  const id = "echoed-conversation";
  const restoreGlobals = replaceGlobals({ localStorage: mapStorage() });
  useInboxStore.setState({
    currentUser: { _id: "echo-owner" },
    messages: {},
    userMessages: {},
    pagination: {},
    messageCacheBytes: 0,
    messageCacheBytesByConversation: {},
    pendingMessages: {
      [id]: [{ ...row(1, "Sent"), _clientId: "send-id", _isOptimistic: true }],
    },
  });
  try {
    await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
    const echoed = { ...row(2, large.repeat(4)), client_id: "send-id" };
    useInboxStore.getState().applyTailMessages(id, 0, [echoed], 2);
    expect(useInboxStore.getState().pendingMessages[id]).toEqual([]);
    await Promise.resolve();
    expect(useInboxStore.getState().messages[id]).toEqual([echoed]);
    await flushPendingMessageJournal();
  } finally {
    useInboxStore.setState(original);
    db.close();
    restoreGlobals();
  }
});

test("equal view times evict the oldest updated session first", () => {
  const store = __createInboxStoreForTests();
  const { session } = webBuilders("message-cache-eviction-order");
  const ids = ["newest", "oldest", "middle", "incoming"];
  const updated = Date.now() - 60_000;
  store.setState({
    sessions: Object.fromEntries(
      ids.map((id, i) => [
        id,
        session.build({
          _id: id,
          updated_at: updated + [3, 1, 2, 4][i],
          agent_status: "done",
          agent_status_updated_at: updated,
        }),
      ]),
    ),
  });
  for (const id of ids)
    store.getState().setMessages(id, [row(1, large)], {}, "cache");
  expect(Object.keys(store.getState().messages).sort()).toEqual([
    "incoming",
    "newest",
  ]);
});

test("warming fills the newest idle transcripts without evicting or fetching older arrivals", async () => {
  const original = useInboxStore.getState();
  const { session } = webBuilders("message-cache-warm-order");
  const updated = Date.now() - 60_000;
  const owner = "warm-order-owner";
  const idle = (i: number) =>
    session.build({
      _id: `jx7${String(i).padStart(29, "0")}`,
      user_id: owner,
      owner_user_id: owner,
      owned_by_me: true,
      message_count: 1,
      agent_status: "done",
      agent_status_updated_at: updated,
      updated_at: updated - i,
    });
  const sessions = Array.from({ length: 50 }, (_, i) => idle(i + 1));
  const add = (entries: typeof sessions) =>
    useInboxStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        ...Object.fromEntries(entries.map((entry) => [entry._id, entry])),
      },
    }));
  const fetched: string[] = [];
  const oversized = {
    ...idle(0),
    _id: `jx7${"s".repeat(29)}`,
    updated_at: updated + 1,
  };
  const convex = {
    query: async (_fn: unknown, args: { conversation_id: string }) => {
      fetched.push(args.conversation_id);
      const bytes = args.conversation_id === oversized._id ? 34 : 1;
      return { isDone: true, page: [row(1, "m".repeat(bytes * 512 * 1024))] };
    },
  };
  useInboxStore.setState({
    currentUser: { _id: owner },
    clientState: { ui: { inbox_view_mode: "recent" } },
    recentFreezeOrder: null,
    _lastViewedAt: {},
    sessions: {},
    messages: {},
    userMessages: {},
    pagination: {},
    messageCacheBytes: 0,
    messageCacheBytesByConversation: {},
  });
  try {
    add(sessions);
    const order = warmRowsFromState(useInboxStore.getState()).map(
      ({ id }) => id,
    );
    expect(order).toHaveLength(50);
    await warmVisibleSessions(convex);
    expect(fetched).toEqual(order.slice(0, 23));
    expect(Object.keys(useInboxStore.getState().messages)).toEqual(fetched);

    add(Array.from({ length: 30 }, (_, i) => idle(i + 51)));
    await warmVisibleSessions(convex);
    expect(fetched).toEqual(order.slice(0, 23));

    useInboxStore.getState().discardForkStub(order[0]);
    const beforeOversized = Object.keys(useInboxStore.getState().messages);
    add([oversized]);
    await warmVisibleSessions(convex);
    expect(fetched.at(-1)).toBe(oversized._id);
    expect(Object.keys(useInboxStore.getState().messages)).toEqual(
      beforeOversized,
    );
    useInboxStore.getState().discardForkStub(oversized._id);
    const newTop = idle(0);
    add([newTop]);
    await warmVisibleSessions(convex);
    expect(fetched.at(-1)).toBe(newTop._id);
    expect(useInboxStore.getState().messages[newTop._id]).toBeDefined();
  } finally {
    useInboxStore.setState(original);
  }
});

test("a 25 MiB open transcript leaves no headroom to warm idle conversations", async () => {
  const original = useInboxStore.getState();
  const { session } = webBuilders("message-cache-warm-open");
  const owner = "warm-pane-owner";
  const updated = Date.now() - 60_000;
  const release = retainOpenMessageView("large-open-pane");
  const idle = Array.from({ length: 80 }, (_, i) =>
    session.build({
      _id: `jx7${String(i + 100).padStart(29, "0")}`,
      user_id: owner,
      owned_by_me: true,
      message_count: 1,
      updated_at: updated - i,
      agent_status: "done",
      agent_status_updated_at: updated,
    }),
  );
  useInboxStore.setState({
    currentUser: { _id: owner },
    sessions: Object.fromEntries(idle.map((entry) => [entry._id, entry])),
    messages: {},
    userMessages: {},
    pagination: {},
    messageCacheBytes: 0,
    messageCacheBytesByConversation: {},
  });
  const pane = row(1, "p".repeat(25 * 512 * 1024));
  try {
    useInboxStore
      .getState()
      .setMessages("large-open-pane", [pane], {}, "cache");
    expect(warmRowsFromState(useInboxStore.getState())).toHaveLength(80);
    let fetches = 0;
    const pass = warmVisibleSessions({
      query: async () => {
        fetches++;
        return { isDone: true, page: [row(1, "m".repeat(1024 * 1024))] };
      },
    });
    expect(
      warmRowsFromState(useInboxStore.getState()).some((row) => row.inFlight),
    ).toBe(false);
    await pass;
    expect(fetches).toBe(0);
    expect(Object.keys(useInboxStore.getState().messages)).toEqual([
      "large-open-pane",
    ]);

    useInboxStore.getState().discardForkStub("large-open-pane");
    const issued = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{
      isDone: boolean;
      page: ReturnType<typeof row>[];
    }>();
    const convex = {
      query: () => {
        fetches++;
        issued.resolve();
        return pending.promise;
      },
    };
    const first = warmVisibleSessions(convex);
    await issued.promise;
    const overlapping = warmVisibleSessions(convex);
    useInboxStore
      .getState()
      .setMessages("large-open-pane", [pane], {}, "cache");
    pending.resolve({ isDone: true, page: [row(1, "m".repeat(1024 * 1024))] });
    await Promise.all([first, overlapping]);
    expect(overlapping).toBe(first);
    expect(fetches).toBe(1);
    expect(Object.keys(useInboxStore.getState().messages)).toEqual([
      "large-open-pane",
    ]);
  } finally {
    release();
    useInboxStore.setState(original);
  }
});

test("the warm planner reserves headroom for both a cold page and a deepen", () => {
  const cold: WarmRow = {
    id: "top",
    serverCount: 200,
    storedCount: 0,
    hasMoreAbove: false,
    newestTs: null,
    syncedCount: undefined,
    inFlight: false,
  };
  const shallow: WarmRow = {
    ...cold,
    id: "next",
    storedCount: 1,
    newestTs: 1,
    hasMoreAbove: true,
  };
  const rows = [cold, shallow, { ...cold, id: "older" }];
  const bytes = 2 * (1024 * 1024 + MESSAGE_CACHE_PAGE_OVERHEAD);
  expect(planWarm(rows, bytes).map(({ id, kind }) => [id, kind])).toEqual([
    ["top", "cold"],
    ["next", "deepen"],
  ]);
});
