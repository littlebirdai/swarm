import { afterEach, expect, spyOn, test } from "bun:test";
import type { OutboxEntry } from "@platform/engine";
import { __createInboxStoreForTests } from "../inboxStore";

const sessionId = "c".repeat(32);
const refusal = new Error("Uncaught ConvexError: Only the runner can move it");
const timeout = new Error("Your request timed out");

const stores: ReturnType<typeof __createInboxStoreForTests>[] = [];

afterEach(() => {
  for (const store of stores.splice(0))
    store.getState()._clearRuntimeBindings();
});

function setup(entries = new Map<string, OutboxEntry>()) {
  const store = __createInboxStoreForTests();
  stores.push(store);
  const removed = Promise.withResolvers<void>();
  store.getState()._setOutbox(
    async (entry) => {
      entries.set(entry.id, structuredClone(entry));
    },
    async (id) => {
      entries.delete(id);
      removed.resolve();
    },
    async () => [...entries.values()],
  );
  return {
    store,
    entries,
    retired: removed.promise,
    pick: () => store.getState().sessionReconfigures[sessionId],
    move: (deviceId: string, projectPath = "/checkout") =>
      store.getState().convCommand(sessionId, "reconfigureSession", {
        target_device_id: deviceId,
        project_path: projectPath,
      }),
  };
}

test("a server refusal restores the machine and project", async () => {
  const { store, move, pick, entries } = setup();
  store.getState()._setDispatch(async () => null);
  await move("laptop", "/laptop/project");

  const response = Promise.withResolvers<void>();
  store.getState()._setDispatch(() => response.promise);

  const request = move("studio", "/studio/project");
  expect(pick()).toMatchObject({
    deviceId: "studio",
    projectPath: "/studio/project",
  });
  response.reject(refusal);
  await expect(request).rejects.toThrow(refusal.message);
  expect(pick()).toEqual({ deviceId: "laptop" });
  expect(entries.size).toBe(0);
});

test("a transient error leaves the pick queued until a retry succeeds", async () => {
  const setTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    (fn, delay, ...args) =>
      setTimer(
        fn,
        [1000, 2000, 4000].includes(delay ?? 0) ? 0 : delay,
        ...args,
      ),
  );
  try {
    const { store, move, pick, entries, retired } = setup();
    let online = false;
    store.getState()._setDispatch(async () => {
      if (!online) throw timeout;
    });
    await expect(move("studio")).rejects.toThrow(timeout.message);
    expect(entries.size).toBe(1);
    expect(pick()).toMatchObject({
      deviceId: "studio",
      projectPath: "/checkout",
    });
    online = true;
    store.getState()._drainOutbox();
    await retired;
    expect(entries.size).toBe(0);
    expect(pick()).toMatchObject({ deviceId: "studio" });
  } finally {
    timer.mockRestore();
  }
});

test("a replayed refusal rolls back the pick restored from the durable pending map", async () => {
  const first = setup();
  await expect(first.move("studio")).rejects.toThrow();
  expect(first.entries.size).toBe(1);
  const pending = structuredClone(first.store.getState().pending);
  first.store.getState()._clearRuntimeBindings();

  const reloaded = setup(first.entries);
  reloaded.store.setState({ pending });
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  reloaded.store.getState()._setDispatch(() => {
    started.resolve();
    return response.promise;
  });
  await started.promise;
  expect(reloaded.pick()).toMatchObject({
    deviceId: "studio",
    projectPath: "/checkout",
  });
  response.reject(refusal);
  await reloaded.retired;
  expect(reloaded.pick()).toBeUndefined();
  expect(first.entries.size).toBe(0);
});

test("a stale pending lock alone cannot restore an already refused pick", async () => {
  const first = setup();
  await expect(first.move("studio")).rejects.toThrow();
  const pending = structuredClone(first.store.getState().pending);
  first.store.getState()._clearRuntimeBindings();

  const reloaded = setup(first.entries);
  reloaded.store.getState()._setDispatch(async () => {
    throw refusal;
  });
  await reloaded.retired;
  reloaded.store.setState({ pending });
  expect(reloaded.pick()).toBeUndefined();
});

test("a refusal for the first move leaves the newer successful pick in place", async () => {
  const { store, move, pick } = setup();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  store
    .getState()
    ._setDispatch((_action, args) =>
      args[2].project_path === "/first" ? first.promise : second.promise,
    );

  const reject = move("studio", "/first");
  const accept = move("studio", "/second");
  first.reject(refusal);
  await expect(reject).rejects.toThrow(refusal.message);
  expect(pick()).toMatchObject({ deviceId: "studio", projectPath: "/second" });
  second.resolve();
  await accept;
  expect(pick()).toMatchObject({ deviceId: "studio" });
});
