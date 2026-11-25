import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { createTestDom } from "../../test-helpers/testDom";
import { HYDRATION_CRITICAL_READ_KEYS } from "../clientSyncRegistry";
import type { CacheStorage } from "./storage";

const dom = createTestDom("https://codecast.test/inbox");
const { cacheStorage } = await import("../idb-cache");
const { bootInboxPersistence } = await import("../inbox-hydration");
afterAll(() => dom.close());

test.each(["resolved", "rejected"] as const)(
  "an async paint read from the old account is ignored when it %s",
  async (outcome) => {
    const paint = Promise.withResolvers<{
      lastFocusedConversationId: string;
    }>();
    const readStarted = Promise.withResolvers<void>();
    const read = spyOn(cacheStorage, "loadPaintCache").mockImplementation(
      () => {
        readStarted.resolve();
        return paint.promise;
      },
    );
    const critical = spyOn(cacheStorage, "loadCache").mockResolvedValue(null);
    const hydrating = spyOn(cacheStorage, "setHydrating").mockImplementation(
      () => {},
    );
    const setState = mock(() => {});
    let accountEpoch = 1;
    const state = {
      lastFocusedConversationId: null,
      _setIDBWrite() {},
      _setOutbox() {},
    };
    try {
      bootInboxPersistence(
        { getState: () => state, setState } as unknown as Parameters<
          typeof bootInboxPersistence
        >[0],
        () => accountEpoch,
        () => null,
        () => "feed",
        async () => false,
      );
      await readStarted.promise;
      accountEpoch++;
      if (outcome === "resolved")
        paint.resolve({ lastFocusedConversationId: "old-focus" });
      else paint.reject(new Error("The old account disconnected"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(setState).not.toHaveBeenCalled();
      expect(critical).not.toHaveBeenCalled();
      expect(hydrating.mock.calls).toEqual([[true]]);
    } finally {
      read.mockRestore();
      critical.mockRestore();
      hydrating.mockRestore();
    }
  },
);

test("an active account hydrates its critical cache after the paint read fails", async () => {
  const finished = Promise.withResolvers<void>();
  const paint = spyOn(cacheStorage, "loadPaintCache").mockRejectedValue(
    new Error("Paint read failed"),
  );
  const critical = spyOn(cacheStorage, "loadCache")
    .mockResolvedValueOnce({ lastFocusedConversationId: "cached-focus" })
    .mockResolvedValue(null);
  const hydrating = spyOn(cacheStorage, "setHydrating").mockImplementation(
    (active) => {
      if (!active) finished.resolve();
    },
  );
  const state = {
    tabs: [],
    lastFocusedConversationId: null,
    currentSessionId: "open-session",
    _setIDBWrite() {},
    _setOutbox() {},
  };
  const setState = mock(() => {});
  try {
    bootInboxPersistence(
      { getState: () => state, setState } as unknown as Parameters<
        typeof bootInboxPersistence
      >[0],
      () => 1,
      () => null,
      () => "feed",
      async () => false,
    );
    await finished.promise;
    expect(critical).toHaveBeenCalledWith(HYDRATION_CRITICAL_READ_KEYS);
    expect(setState).toHaveBeenCalledWith({
      lastFocusedConversationId: "cached-focus",
    });
  } finally {
    paint.mockRestore();
    critical.mockRestore();
    hydrating.mockRestore();
  }
});

test("callbacks registered during boot use the current storage methods", async () => {
  const original = { ...cacheStorage };
  const paint = spyOn(cacheStorage, "loadPaintCache").mockResolvedValue(null);
  const hydrating = spyOn(cacheStorage, "setHydrating").mockImplementation(
    () => {},
  );
  const methods = {
    writePatches: mock<CacheStorage["writePatches"]>(() => {}),
    enqueueDispatch: mock<CacheStorage["enqueueDispatch"]>(() =>
      Promise.resolve(),
    ),
    removeDispatch: mock<CacheStorage["removeDispatch"]>(() => {}),
    loadOutbox: mock<CacheStorage["loadOutbox"]>(() => Promise.resolve([])),
  };
  const state = {
    _setIDBWrite: mock((_write: CacheStorage["writePatches"]) => {}),
    _setOutbox: mock(
      (
        _enqueue: CacheStorage["enqueueDispatch"],
        _remove: CacheStorage["removeDispatch"],
        _load: CacheStorage["loadOutbox"],
      ) => {},
    ),
  };
  const entry = { id: "queued-action" } as Parameters<
    CacheStorage["enqueueDispatch"]
  >[0];
  let epoch = 1;
  try {
    Object.assign(cacheStorage, {
      writePatches: () => {},
      enqueueDispatch: async () => {},
      removeDispatch: () => {},
      loadOutbox: async () => [],
    });
    bootInboxPersistence(
      { getState: () => state, setState() {} } as unknown as Parameters<
        typeof bootInboxPersistence
      >[0],
      () => epoch,
      () => null,
      () => "feed",
      async () => false,
    );
    epoch++;
    Object.assign(cacheStorage, methods);

    const [write] = state._setIDBWrite.mock.calls[0];
    const [enqueue, remove, load] = state._setOutbox.mock.calls[0];
    await write([], state);
    await enqueue(entry);
    await remove(entry.id);
    await load();

    expect(methods.writePatches).toHaveBeenCalledWith([], state);
    expect(methods.enqueueDispatch).toHaveBeenCalledWith(entry);
    expect(methods.removeDispatch).toHaveBeenCalledWith(entry.id);
    expect(methods.loadOutbox).toHaveBeenCalledTimes(1);
  } finally {
    paint.mockRestore();
    hydrating.mockRestore();
    Object.assign(cacheStorage, original);
  }
});

test("a critical cache rejection from the old account leaves the new account alone", async () => {
  const readStarted = Promise.withResolvers<void>();
  const read = Promise.withResolvers<null>();
  const paint = spyOn(cacheStorage, "loadPaintCache").mockResolvedValue(null);
  const critical = spyOn(cacheStorage, "loadCache").mockImplementation(() => {
    readStarted.resolve();
    return read.promise;
  });
  const hydrating = spyOn(cacheStorage, "setHydrating").mockImplementation(
    () => {},
  );
  const setState = mock(() => {});
  let accountEpoch = 1;
  const state = {
    _setIDBWrite() {},
    _setOutbox() {},
  };
  try {
    bootInboxPersistence(
      { getState: () => state, setState } as unknown as Parameters<
        typeof bootInboxPersistence
      >[0],
      () => accountEpoch,
      () => null,
      () => "feed",
      async () => false,
    );
    await readStarted.promise;
    accountEpoch++;
    read.reject(new Error("The old account disconnected during critical boot"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(critical).toHaveBeenCalledWith(HYDRATION_CRITICAL_READ_KEYS);
    expect(setState).not.toHaveBeenCalled();
    expect(hydrating.mock.calls).toEqual([[true]]);
  } finally {
    paint.mockRestore();
    critical.mockRestore();
    hydrating.mockRestore();
  }
});
