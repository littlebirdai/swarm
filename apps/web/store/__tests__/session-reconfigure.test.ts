import { afterEach, expect, spyOn, test } from "bun:test";
import type { OutboxEntry } from "@platform/engine";
import { webBuilders } from "../../test-helpers/builders";
import { __createInboxStoreForTests } from "../inboxStore";
import { followerActionTee, setFollowerTee } from "../sync-replication";

const sessionId = "c".repeat(32);
const refusal = new Error("Uncaught ConvexError: Only the runner can move it");
const timeout = new Error("Your request timed out");
const { session } = webBuilders("session-reconfigure.test.ts");
const serverRow = session.build({
  _id: sessionId,
  owner_device_id: "laptop",
  project_path: "/laptop/project",
  git_root: "/laptop/project",
});

const stores: ReturnType<typeof __createInboxStoreForTests>[] = [];

afterEach(() => {
  for (const store of stores.splice(0))
    store.getState()._clearRuntimeBindings();
});

function setup(entries = new Map<string, OutboxEntry>()) {
  const store = __createInboxStoreForTests();
  stores.push(store);
  store.getState().syncTable("sessions", [serverRow]);
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
    pick: () => {
      const row = store.getState().sessions[sessionId];
      return { deviceId: row.owner_device_id, projectPath: row.project_path };
    },
    echo: (deviceId: string, projectPath: string) =>
      store.getState().syncTable("sessions", [
        {
          ...serverRow,
          owner_device_id: deviceId,
          project_path: projectPath,
          git_root: projectPath,
        },
      ]),
    move: (deviceId: string, projectPath = "/checkout") =>
      store.getState().convCommand(sessionId, "reconfigureSession", {
        target_device_id: deviceId,
        project_path: projectPath,
      }),
  };
}

test("a server refusal restores the machine and project", async () => {
  const { store, move, pick, entries } = setup();
  const response = Promise.withResolvers<void>();
  let rawConversationPatch: unknown;
  store.getState()._setDispatch((_action, _args, patches) => {
    rawConversationPatch = patches?.conversations?.[sessionId];
    return response.promise;
  });

  const request = move("studio", "/studio/project");
  expect(rawConversationPatch).toBeUndefined();
  expect(pick()).toMatchObject({
    deviceId: "studio",
    projectPath: "/studio/project",
  });
  response.reject(refusal);
  await expect(request).rejects.toThrow(refusal.message);
  expect(pick()).toEqual({
    deviceId: "laptop",
    projectPath: "/laptop/project",
  });
  expect(entries.size).toBe(0);
});

test("the host rolls back a follower's refused placement fields", async () => {
  const follower = setup();
  const host = setup();
  const response = Promise.withResolvers<void>();
  follower.store.getState()._setDispatch(() => response.promise);
  setFollowerTee(
    follower.store.getState(),
    followerActionTee(
      {
        post(message) {
          if (message.type !== "mut") return;
          for (const update of message.updates) {
            if (update.fields)
              host.store
                .getState()
                .applyReplicatedFields(
                  update.key,
                  update.fields,
                  update.ts,
                  update.release,
                );
          }
        },
        onMessage: () => () => {},
      },
      "follower",
    ),
  );
  try {
    const request = follower.move("studio", "/studio");
    expect(host.pick()).toEqual({ deviceId: "studio", projectPath: "/studio" });
    response.reject(refusal);
    await expect(request).rejects.toThrow(refusal.message);
    expect(host.pick()).toEqual({
      deviceId: "laptop",
      projectPath: "/laptop/project",
    });
    expect(Object.keys(host.store.getState().pending)).toEqual([]);
  } finally {
    setFollowerTee(follower.store.getState(), null);
  }
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
    expect(pick()).toEqual({ deviceId: "studio", projectPath: "/checkout" });
  } finally {
    timer.mockRestore();
  }
});

test("a replayed refusal rolls back the pick restored from the durable pending map", async () => {
  const first = setup();
  await expect(first.move("studio")).rejects.toThrow();
  expect(first.entries.size).toBe(1);
  const { pending, sessions } = structuredClone({
    pending: first.store.getState().pending,
    sessions: first.store.getState().sessions,
  });
  first.store.getState()._clearRuntimeBindings();

  const reloaded = setup(first.entries);
  reloaded.store.setState({ pending, sessions });
  expect(reloaded.pick()).toEqual({
    deviceId: "studio",
    projectPath: "/checkout",
  });
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
  expect(reloaded.pick()).toEqual({
    deviceId: "laptop",
    projectPath: "/laptop/project",
  });
  expect(first.entries.size).toBe(0);
});

test("an authoritative echo observed before a refusal wins the rollback", async () => {
  const { store, move, pick, echo } = setup();
  const response = Promise.withResolvers<void>();
  store.getState()._setDispatch(() => response.promise);
  const request = move("studio", "/studio");
  echo("fallback", "/server");
  expect(pick()).toEqual({ deviceId: "studio", projectPath: "/studio" });
  response.reject(refusal);
  await expect(request).rejects.toThrow(refusal.message);
  expect(pick()).toEqual({ deviceId: "fallback", projectPath: "/server" });
});

test("refusing a newer move does not restore the prior accepted move's locks", async () => {
  const { store, move, pick, echo } = setup();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  store
    .getState()
    ._setDispatch((_action, args) =>
      args[2].project_path === "/first" ? first.promise : second.promise,
    );

  const accept = move("studio", "/first");
  const reject = move("other", "/second");
  first.resolve();
  await accept;
  echo("studio", "/first");
  expect(pick()).toEqual({ deviceId: "other", projectPath: "/second" });
  second.reject(refusal);
  await expect(reject).rejects.toThrow(refusal.message);
  expect(pick()).toEqual({ deviceId: "studio", projectPath: "/first" });
  expect(Object.keys(store.getState().pending)).toEqual([]);
  echo("fallback", "/server");
  expect(pick()).toEqual({ deviceId: "fallback", projectPath: "/server" });
});

test("a stub pick is carried through rekey on the session row", () => {
  const { store } = setup();
  const stubId = "stub-project-move";
  const realId = "d".repeat(32);
  store
    .getState()
    .seedSession({ ...serverRow, _id: stubId, session_id: stubId });
  store.getState().setSessionTargetDevice(stubId, "studio");
  (store.getState() as any)._rekeySession(stubId, realId);
  expect(store.getState().sessions[stubId]).toBeUndefined();
  expect(store.getState().sessions[realId]?.target_device_id).toBe("studio");
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
  const accept = move("newer", "/second");
  first.reject(refusal);
  await expect(reject).rejects.toThrow(refusal.message);
  expect(pick()).toMatchObject({ deviceId: "newer", projectPath: "/second" });
  second.resolve();
  await accept;
  expect(pick()).toEqual({ deviceId: "newer", projectPath: "/second" });
});
