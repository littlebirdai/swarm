import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  clearProtectedInboxMemory,
  ensureHydrated,
  useInboxStore,
} from "../../store/inboxStore";
import {
  MESSAGE_CACHE_BUDGET_BYTES,
  MESSAGE_CACHE_PAGE_OVERHEAD,
  messageRowBytes,
  rememberWarmMessageCount,
  warmMessageCounts,
} from "../../store/store-eviction";
import { mapStorage } from "../../store/__tests__/fixtures/fakeAuthToken";
import { webBuilders } from "../../test-helpers/builders";
import { replaceGlobals } from "../../test-helpers/globals";
import { warmRowsFromState, warmVisibleSessions } from "../inbox-warm";

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

test("50 one MiB sessions retain the top rows and repeated passes only warm unseen top rows", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(mib);
  const indexes = Array.from({ length: 50 }, (_, i) => i + 1);
  try {
    seed(indexes);
    await warm(convex);
    expect(asks).toHaveLength(50);
    expect(
      indexes
        .slice(0, 10)
        .every((i) => useInboxStore.getState().messages[id(i)]),
    ).toBe(true);
    expect(Object.keys(useInboxStore.getState().messages).length).toBeLessThan(
      50,
    );
    evict(1);
    const missing = indexes.find(
      (i) => i > 10 && !useInboxStore.getState().messages[id(i)],
    )!;
    expect(missing).toBeDefined();
    seed(Array.from({ length: 30 }, (_, i) => i + 51));
    await warm(convex);
    await warm(convex);
    expect(asks).toHaveLength(50);
    seed([0]);
    await warm(convex);
    expect(asks.slice(50)).toEqual([id(0)]);
    expect(useInboxStore.getState().messages[id(0)]).toBeDefined();
  } finally {
    restore();
  }
});

test("an oversized top session warms once per server count and leaves other requests free", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(mib, 25 * mib);
  try {
    seed([0, 1, 2, 3]);
    await warm(convex);
    expect(asks.sort()).toEqual(sizes(0, 1, 2, 3));
    evict(0);
    ballast(17 * mib);
    await warm(convex);
    expect(asks.filter((key) => key === id(0))).toHaveLength(1);
    useInboxStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [id(0)]: { ...state.sessions[id(0)], message_count: 2 },
      },
    }));
    await warm(convex);
    expect(asks.filter((key) => key === id(0))).toHaveLength(2);
  } finally {
    restore();
  }
});

test("a single message delta arrives at 99 percent of the low-water mark", async () => {
  const restore = resetFixture();
  try {
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
      useInboxStore.getState().messages[id(1)].map((m) => m.timestamp),
    ).toEqual([1, 2]);
  } finally {
    restore();
  }
});

test("a history deepen leaves the next pass free to fetch the newer messages", async () => {
  const restore = resetFixture();
  try {
    seed([1]);
    useInboxStore
      .getState()
      .setMessages(id(1), [message(1024, 2)], { hasMoreAbove: true }, "cache");
    ballast(17 * mib);
    const calls: string[] = [];
    const convex = {
      query: async (fn: Parameters<typeof getFunctionName>[0]) => {
        const name = getFunctionName(fn);
        calls.push(name);
        if (name === "conversations:getAllMessages") {
          return { messages: [message(1024, 1)], has_more_above: true };
        }
        return { messages: [message(1024, 3)], has_more: false };
      },
    };
    await warm(convex);
    await warm(convex);
    expect(calls).toEqual([
      "conversations:getAllMessages",
      "conversations:getNewMessages",
    ]);
    expect(
      useInboxStore.getState().messages[id(1)].map((row) => row.timestamp),
    ).toEqual([1, 2, 3]);
  } finally {
    restore();
  }
});

test("relief below half allows an evicted transcript with the same count to warm again", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(1024);
  try {
    seed([1]);
    await warm(convex);
    evict(1);
    ballast(17 * mib);
    await warm(convex);
    expect(asks).toEqual(sizes(1));
    useInboxStore.getState().discardForkStub("ballast");
    await warm(convex);
    expect(asks).toEqual(sizes(1, 1));
  } finally {
    restore();
  }
});

test("a new account can warm a previously warmed id above half the budget", async () => {
  const restore = resetFixture();
  const { asks, convex } = fixture(1024);
  const pending = Promise.withResolvers<{
    isDone: boolean;
    page: ReturnType<typeof message>[];
  }>();
  const previousAccountCalls: string[] = [];
  try {
    seed([1]);
    await warm(convex);
    seed([2]);
    await warm({
      query: (_fn, args) => {
        previousAccountCalls.push(args.conversation_id);
        return pending.promise;
      },
    });
    expect(previousAccountCalls).toEqual(sizes(2));
    clearProtectedInboxMemory();
    seed([1], "second-warm-budget-owner");
    ballast(17 * mib);
    await warm(convex);
    expect(asks).toEqual(sizes(1, 1));
    expect(useInboxStore.getState().messages[id(1)]).toBeDefined();
  } finally {
    pending.resolve({ isDone: true, page: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    restore();
  }
});

test("at exactly half, history deepens once and only within the top ten", async () => {
  const restore = resetFixture();
  try {
    seed(Array.from({ length: 12 }, (_, i) => i + 1));
    for (let i = 1; i <= 12; i++) {
      useInboxStore
        .getState()
        .setMessages(
          id(i),
          [message(1024, 2)],
          { hasMoreAbove: true },
          "cache",
        );
    }
    const remaining =
      MESSAGE_CACHE_BUDGET_BYTES / 2 -
      useInboxStore.getState().messageCacheBytes -
      messageRowBytes(message(0)) -
      MESSAGE_CACHE_PAGE_OVERHEAD;
    ballast(remaining);
    expect(useInboxStore.getState().messageCacheBytes).toBe(
      MESSAGE_CACHE_BUDGET_BYTES / 2,
    );
    rememberWarmMessageCount(id(1), 1);
    const deepened: string[] = [];
    const convex = {
      query: async (fn: unknown, args: { conversation_id: string }) => {
        if (
          getFunctionName(fn as Parameters<typeof getFunctionName>[0]) ===
          "conversations:getAllMessages"
        ) {
          deepened.push(args.conversation_id);
          return { messages: [message(1024)], has_more_above: true };
        }
        return { messages: [], has_more: false };
      },
    };
    await warm(convex);
    await warm(convex);
    expect(deepened).toEqual(Array.from({ length: 9 }, (_, i) => id(i + 2)));
  } finally {
    restore();
  }
});

test("the warm count cache keeps its 200 most recently recorded ids", () => {
  const restore = resetFixture();
  try {
    for (let i = 1; i <= 200; i++) rememberWarmMessageCount(id(i), 1);
    rememberWarmMessageCount(id(1), 2);
    rememberWarmMessageCount(id(201), 1);
    expect(warmMessageCounts.size).toBe(200);
    expect(warmMessageCounts.get(id(1))).toBe(2);
    expect(warmMessageCounts.has(id(2))).toBe(false);
  } finally {
    restore();
  }
});
