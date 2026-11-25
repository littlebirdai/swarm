import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  clearProtectedInboxMemory,
  ensureHydrated,
  useInboxStore,
} from "../../store/inboxStore";
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
