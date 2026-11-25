import { expect, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  clearProtectedInboxMemory,
  ensureHydrated,
  useInboxStore,
} from "../../store/inboxStore";
import { cacheStorage, type CachedConversation } from "../../store/idb-cache";
import { MESSAGE_CACHE_BUDGET_BYTES } from "../../store/store-eviction";
import { mapStorage } from "../../store/__tests__/fixtures/fakeAuthToken";
import { webBuilders } from "../../test-helpers/builders";
import { replaceGlobals } from "../../test-helpers/globals";
import { startTestClock } from "../../test-helpers/testTimers";
import {
  startWarmLoop,
  warmRowsFromState,
  warmVisibleSessions,
} from "../inbox-warm";

const mib = 1024 * 1024;
const startedAt = Date.now() - 60_000;
const me = "warm-budget-owner";
const { session } = webBuilders("inbox-warm-budget.test.ts");
const id = (i: number) => `j${String(i).padStart(31, "0")}`;
const message = (bytes: number, timestamp = 1) => ({
  _id: `message-${timestamp}`,
  role: "assistant",
  content: "m".repeat(bytes / 2),
  timestamp,
});

function seed(indexes: number[], owner = me) {
  useInboxStore.setState((state) => ({
    currentUser: { _id: owner },
    clientState: { ui: { inbox_view_mode: "recent" } },
    sessions: {
      ...state.sessions,
      ...Object.fromEntries(
        indexes.map((i) => [
          id(i),
          session.build({
            _id: id(i),
            user_id: owner,
            owner_user_id: owner,
            owned_by_me: true,
            message_count: 1,
            agent_status: "done",
            agent_status_updated_at: startedAt,
            updated_at: startedAt - i,
          }),
        ]),
      ),
    },
  }));
}

function resetFixture() {
  const original = useInboxStore.getState();
  const restoreGlobals = replaceGlobals({ localStorage: mapStorage() });
  clearProtectedInboxMemory();
  return () => {
    clearProtectedInboxMemory();
    useInboxStore.setState(original);
    restoreGlobals();
  };
}

function sizes(...indexes: number[]) {
  return indexes.map((index) => id(index));
}

function fixture(bytes: number, specialBytes?: number) {
  const asks: string[] = [];
  const convex = {
    query: async (_fn: unknown, args: { conversation_id: string }) => {
      asks.push(args.conversation_id);
      return {
        isDone: true,
        page: [
          message(
            args.conversation_id === id(0) ? (specialBytes ?? bytes) : bytes,
          ),
        ],
      };
    },
  };
  return { asks, convex };
}

async function warm(convex: Parameters<typeof warmVisibleSessions>[0]) {
  warmVisibleSessions(convex);
  await Promise.resolve();
  const cold = warmRowsFromState(useInboxStore.getState()).filter(
    (row) => row.inFlight && row.storedCount === 0,
  );
  await Promise.all(cold.map(({ id }) => ensureHydrated(id)));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function evict(index: number) {
  const state = useInboxStore.getState();
  state.discardForkStub(id(index));
  useInboxStore.setState({ sessions: state.sessions });
}

function ballast(bytes: number) {
  useInboxStore
    .getState()
    .setMessages("ballast", [message(bytes)], {}, "cache");
}

test("one warm pass starts all 60 small cold requests before any response", async () => {
  const restore = resetFixture();
  const indexes = Array.from({ length: 60 }, (_, i) => i + 1);
  const pending = Promise.withResolvers<{
    isDone: boolean;
    page: ReturnType<typeof message>[];
  }>();
  const asks: string[] = [];
  try {
    seed(indexes);
    await warm({
      query: (_fn, args) => {
        asks.push(args.conversation_id);
        return pending.promise;
      },
    });
    expect(asks).toHaveLength(60);
  } finally {
    pending.resolve({ isDone: true, page: [message(1024)] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const held = Object.keys(useInboxStore.getState().messages).length;
    restore();
    expect(held).toBe(60);
  }
});

test("a 25 MiB top transcript stops fetching across passes and the running loop", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(mib, 25 * mib);
  const clock = startTestClock();
  const indexes = Array.from({ length: 10 }, (_, i) => i);
  let stop: (() => void) | undefined;
  try {
    seed(indexes);
    stop = startWarmLoop(convex);
    await warm(convex);
    const afterFirstPass = asks.length;
    expect(afterFirstPass).toBe(10);
    expect(Object.keys(useInboxStore.getState().messages).length).toBeLessThan(
      14,
    );
    for (let i = 0; i < 5; i++) await warm(convex);
    for (const conversation of sizes(...indexes)) {
      expect(
        asks.filter((key) => key === conversation).length,
      ).toBeLessThanOrEqual(2);
    }
    const settled = asks.slice();
    for (let i = 0; i < 4; i++) {
      await clock.advance(750);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(asks).toEqual(settled);
  } finally {
    stop?.();
    clock.close();
    restore();
  }
});

test("three 15 MiB transcripts warm once and stay quiet after eviction", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(15 * mib);
  try {
    seed([1, 2, 3]);
    await warm(convex);
    expect(asks.slice().sort()).toEqual(sizes(1, 2, 3));
    expect(Object.keys(useInboxStore.getState().messages)).toHaveLength(1);
    expect(useInboxStore.getState().messageCacheBytes).toBeLessThan(16 * mib);
    for (let i = 0; i < 5; i++) await warm(convex);
    expect(asks).toHaveLength(3);
  } finally {
    restore();
  }
});

test("250 small transcripts warm without a delta storm on later passes", async () => {
  const restore = resetFixture();
  const cold: string[] = [];
  const deltas: string[] = [];
  const convex = {
    query: async (
      fn: Parameters<typeof getFunctionName>[0],
      args: { conversation_id: string },
    ) => {
      if (getFunctionName(fn) === "conversations:getNewMessages") {
        deltas.push(args.conversation_id);
        return { messages: [], has_more: false };
      }
      cold.push(args.conversation_id);
      return { page: [message(1024)], isDone: true };
    },
  };
  try {
    seed(Array.from({ length: 250 }, (_, i) => i + 1));
    for (let i = 0; i < 5; i++) await warm(convex);
    expect(cold).toHaveLength(250);
    expect(Object.keys(useInboxStore.getState().messages)).toHaveLength(250);
    await warm(convex);
    await warm(convex);
    expect(deltas).toEqual([]);
  } finally {
    restore();
  }
});

function forceBudgetEviction() {
  const state = useInboxStore.getState();
  state.setMessages("pressure-older", [message(20 * mib)], {}, "cache");
  state.setMessages("pressure-newer", [message(20 * mib)], {}, "cache");
  expect(useInboxStore.getState().messages["pressure-older"]).toBeUndefined();
  state.discardForkStub("pressure-newer");
}

test("a single message delta arrives near low water after eviction", async () => {
  const restore = resetFixture();
  try {
    forceBudgetEviction();
    seed([1]);
    const { convex } = fixture(1024);
    await warm(convex);
    ballast(Math.floor(MESSAGE_CACHE_BUDGET_BYTES * 0.75 * 0.99) - 2048);
    useInboxStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [id(1)]: { ...state.sessions[id(1)], message_count: 2 },
      },
    }));
    const calls: string[] = [];
    await warm({
      query: async (fn) => {
        calls.push(getFunctionName(fn));
        return { messages: [message(1024, 2)], has_more: false };
      },
    });
    expect(calls).toEqual(["conversations:getNewMessages"]);
    expect(
      useInboxStore.getState().messages[id(1)].map((row) => row.timestamp),
    ).toEqual([1, 2]);
  } finally {
    restore();
  }
});

test("after eviction only a new top session warms and it warms once", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(1024);
  try {
    forceBudgetEviction();
    seed(Array.from({ length: 12 }, (_, i) => i + 1));
    for (let i = 0; i < 2; i++) await warm(convex);
    expect(asks.slice().sort()).toEqual(
      sizes(...Array.from({ length: 10 }, (_, i) => i + 1)),
    );
    seed([0]);
    await warm(convex);
    evict(0);
    useInboxStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [id(0)]: { ...state.sessions[id(0)], message_count: 2 },
      },
    }));
    await warm(convex);
    expect(asks.slice(10)).toEqual([id(0)]);
  } finally {
    restore();
  }
});

test("account switch clears both the eviction flag and prior cold warms", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(1024);
  try {
    forceBudgetEviction();
    seed([1]);
    await warm(convex);
    clearProtectedInboxMemory();
    seed(
      Array.from({ length: 12 }, (_, i) => i + 2),
      "second-warm-budget-owner",
    );
    await warm(convex);
    expect(asks).toHaveLength(13);
    forceBudgetEviction();
    seed([1], "second-warm-budget-owner");
    await warm(convex);
    expect(asks.filter((key) => key === id(1))).toHaveLength(2);
  } finally {
    restore();
  }
});

test("the top history deepens before the first eviction and stops after it", async () => {
  const restore = resetFixture();
  const calls: string[] = [];
  const convex = {
    query: async (fn: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(fn);
      calls.push(name);
      if (name === "conversations:listMessages") {
        return { page: [message(1024, 3)], isDone: false };
      }
      return { messages: [message(1024, 2)], has_more_above: true };
    },
  };
  try {
    seed([1]);
    ballast(17 * mib);
    await warm(convex);
    await warm(convex);
    expect(calls).toEqual([
      "conversations:listMessages",
      "conversations:getAllMessages",
    ]);
    useInboxStore.getState().discardForkStub("ballast");
    forceBudgetEviction();
    await warm(convex);
    expect(calls).toHaveLength(2);
  } finally {
    restore();
  }
});

test("an old account's cold response cannot populate or unlock the new account's transcript", async () => {
  const restore = resetFixture();
  const former = Promise.withResolvers<{
    page: ReturnType<typeof message>[];
    isDone: boolean;
  }>();
  const current = Promise.withResolvers<{
    page: ReturnType<typeof message>[];
    isDone: boolean;
  }>();
  const currentCalls: string[] = [];
  const newClient = {
    query: (_fn: unknown, args: { conversation_id: string }) => {
      currentCalls.push(args.conversation_id);
      return current.promise;
    },
  };
  try {
    seed([251]);
    await warm({ query: () => former.promise });
    clearProtectedInboxMemory();
    seed([251], "second-warm-budget-owner");
    await warm(newClient);
    former.resolve({ page: [message(2048, 123)], isDone: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(useInboxStore.getState().messages[id(251)]).toBeUndefined();
    await warm(newClient);
    expect(currentCalls).toEqual([id(251)]);
    current.resolve({ page: [message(1024, 321)], isDone: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      useInboxStore.getState().messages[id(251)]?.map((row) => row.timestamp),
    ).toEqual([321]);
  } finally {
    former.resolve({ page: [], isDone: true });
    current.resolve({ page: [], isDone: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    restore();
  }
});

test.each([
  ["conversations:getNewMessages", 252],
  ["conversations:getAllMessages", 253],
  ["conversations:getConversation", 254],
] as const)(
  "an old account's %s result is ignored after reset",
  async (query, index) => {
    const restore = resetFixture();
    const response = Promise.withResolvers<unknown>();
    const calls: string[] = [];
    const key = id(index);
    try {
      seed([index]);
      if (query === "conversations:getConversation") {
        useInboxStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [key]: { ...state.sessions[key], standing_role_id: "test-role" },
          },
        }));
      } else {
        useInboxStore
          .getState()
          .setMessages(
            key,
            [message(1024, 2)],
            { hasMoreAbove: query === "conversations:getAllMessages" },
            "cache",
          );
      }
      await warm({
        query: (fn) => {
          calls.push(getFunctionName(fn));
          return response.promise;
        },
      });
      expect(calls).toEqual([query]);
      clearProtectedInboxMemory();
      seed([255], "second-warm-budget-owner");
      response.resolve({
        title: "former account transcript",
        messages: [message(1024)],
        has_more: false,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(useInboxStore.getState().messages[key]).toBeUndefined();
      expect(useInboxStore.getState().sessions[key]).toBeUndefined();
    } finally {
      response.resolve(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      restore();
    }
  },
);

test.each([
  ["conversations:getNewMessages", false],
  ["conversations:getAllMessages", true],
] as const)(
  "byte pressure keeps the transcript held by %s",
  async (query, hasMoreAbove) => {
    const restore = resetFixture();
    const response = Promise.withResolvers<unknown>();
    const calls: string[] = [];
    try {
      seed([1]);
      useInboxStore
        .getState()
        .setMessages(
          id(1),
          [message(1024, 2), message(1024, 3)],
          { hasMoreAbove },
          "cache",
        );
      await warm({
        query: (fn) => {
          calls.push(getFunctionName(fn));
          return response.promise;
        },
      });
      expect(calls).toEqual([query]);
      ballast(MESSAGE_CACHE_BUDGET_BYTES + 1024);
      expect(
        useInboxStore.getState().messages[id(1)]?.map((row) => row.timestamp),
      ).toEqual([2, 3]);
      useInboxStore.getState().discardForkStub("ballast");
      response.resolve({
        messages: [message(1024, hasMoreAbove ? 1 : 4)],
        has_more_above: hasMoreAbove,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        useInboxStore.getState().messages[id(1)]?.map((row) => row.timestamp),
      ).toEqual(hasMoreAbove ? [1, 2, 3] : [2, 3, 4]);
    } finally {
      response.resolve(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      restore();
    }
  },
);

test.each([
  ["conversations:getNewMessages", false],
  ["conversations:getAllMessages", true],
] as const)(
  "%s drops a late page when its transcript disappeared",
  async (query, hasMoreAbove) => {
    const restore = resetFixture();
    const response = Promise.withResolvers<unknown>();
    const write = spyOn(
      cacheStorage,
      "writeConversationMessages",
    ).mockImplementation(() => {});
    const calls: string[] = [];
    const convex = {
      query: (fn: Parameters<typeof getFunctionName>[0]) => {
        calls.push(getFunctionName(fn));
        return response.promise;
      },
    };
    try {
      seed([1]);
      useInboxStore
        .getState()
        .setMessages(id(1), [message(1024, 2)], { hasMoreAbove }, "cache");
      await warm(convex);
      expect(calls).toEqual([query]);
      evict(1);
      response.resolve({
        messages: [message(1024, hasMoreAbove ? 1 : 3)],
        has_more_above: false,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(useInboxStore.getState().messages[id(1)]).toBeUndefined();
      expect(useInboxStore.getState().pagination[id(1)]).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
      useInboxStore
        .getState()
        .setMessages(id(1), [message(1024, 2)], { hasMoreAbove }, "cache");
      await warm(convex);
      expect(calls).toEqual([query, query]);
    } finally {
      response.resolve(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      write.mockRestore();
      restore();
    }
  },
);

test("an account reset retries a previously attempted standing session row", async () => {
  const restore = resetFixture();
  const calls: string[] = [];
  const convex = {
    query: async (fn: Parameters<typeof getFunctionName>[0]) => {
      calls.push(getFunctionName(fn));
      return null;
    },
  };
  try {
    for (let pass = 0; pass < 2; pass++) {
      seed([1]);
      useInboxStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [id(1)]: { ...state.sessions[id(1)], standing_role_id: "test-role" },
        },
      }));
      await warm(convex);
      clearProtectedInboxMemory();
    }
    expect(calls).toEqual([
      "conversations:getConversation",
      "conversations:getConversation",
    ]);
  } finally {
    restore();
  }
});

test("an account reset retries a delta for the same server count", async () => {
  const restore = resetFixture();
  const calls: string[] = [];
  const convex = {
    query: async (fn: Parameters<typeof getFunctionName>[0]) => {
      calls.push(getFunctionName(fn));
      return { messages: [message(1024, 2)], has_more: false };
    },
  };
  try {
    seed([1]);
    await warm(fixture(1024).convex);
    clearProtectedInboxMemory();
    seed([1]);
    useInboxStore.getState().setMessages(id(1), [message(1024)], {}, "cache");
    await warm(convex);
    expect(calls).toEqual(["conversations:getNewMessages"]);
  } finally {
    restore();
  }
});

test.each(["hit", "miss"] as const)(
  "a pending disk %s after account reset does not warm the old transcript",
  async (result) => {
    const restore = resetFixture();
    const response = Promise.withResolvers<CachedConversation | null>();
    const load = spyOn(
      cacheStorage,
      "loadConversationMessages",
    ).mockImplementation(() => response.promise);
    const write = spyOn(cacheStorage, "writeConversationMessages");
    const query = {
      query: async () => ({ page: [message(1024, 3)], isDone: true }),
    };
    const queried = spyOn(query, "query");
    try {
      seed([1]);
      warmVisibleSessions(query);
      expect(load).toHaveBeenCalledWith(id(1));
      const hydration = ensureHydrated(id(1));
      clearProtectedInboxMemory();
      response.resolve(
        result === "miss"
          ? null
          : {
              messages: [message(1024, 2)],
              pagination: { initialized: true, hasMoreAbove: false },
              latestTimestamp: 2,
            },
      );
      await hydration;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(queried).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(useInboxStore.getState().messages[id(1)]).toBeUndefined();
    } finally {
      response.resolve(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      write.mockRestore();
      load.mockRestore();
      restore();
    }
  },
);

test("deleting a session while its cold snapshot is pending drops the response", async () => {
  const restore = resetFixture();
  const ready = Promise.withResolvers<unknown>();
  const write = spyOn(
    cacheStorage,
    "writeConversationMessages",
  ).mockImplementation(() => {});
  const calls: string[] = [];
  try {
    seed([1]);
    await warm({
      query: (fn) => {
        calls.push(getFunctionName(fn));
        return ready.promise;
      },
    });
    expect(calls).toEqual(["conversations:listMessages"]);
    useInboxStore.getState().deleteSession(id(1));
    ready.resolve({ page: [message(1024)], isDone: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(useInboxStore.getState().messages[id(1)]).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  } finally {
    ready.resolve(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    write.mockRestore();
    restore();
  }
});

test.each(["hit", "miss"] as const)(
  "deleting a session before a disk %s prevents its cold warm from continuing",
  async (result) => {
    const restore = resetFixture();
    const response = Promise.withResolvers<CachedConversation | null>();
    const load = spyOn(
      cacheStorage,
      "loadConversationMessages",
    ).mockImplementation(() => response.promise);
    const calls: string[] = [];
    try {
      seed([1]);
      warmVisibleSessions({
        query: async (fn) => {
          calls.push(getFunctionName(fn));
          return { page: [message(1024, 3)], isDone: true };
        },
      });
      expect(load).toHaveBeenCalledWith(id(1));
      const hydration = ensureHydrated(id(1));
      useInboxStore.getState().deleteSession(id(1));
      response.resolve(
        result === "miss"
          ? null
          : {
              messages: [message(1024, 2)],
              userMessages: [message(1024, 1)],
              pagination: { initialized: true, hasMoreAbove: false },
              latestTimestamp: 2,
            },
      );
      await hydration;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(useInboxStore.getState().messages[id(1)]).toBeUndefined();
      expect(useInboxStore.getState().userMessages[id(1)]).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      response.resolve(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      load.mockRestore();
      restore();
    }
  },
);
