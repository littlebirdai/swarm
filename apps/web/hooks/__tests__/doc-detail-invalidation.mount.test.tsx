import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  AUTH_JWT_STORAGE_KEY,
  issueFakeToken,
} from "../../store/__tests__/fixtures/fakeAuthToken";
import { authPrincipal } from "../../lib/authPrincipal";
import { cacheStorage } from "../../store/idb-cache";
import { _reopenForTests, db } from "../../store/persistence/db";
import { writeOwnerStamp } from "../../store/persistence/ownership";
import { replaceGlobals } from "../../test-helpers/globals";
import { pending } from "../../test-helpers/testConvex";
import { performUndo, withoutUndo } from "../../store/undoStack";
import { afterEach, expect, jest, mock, spyOn, test } from "bun:test";
import {
  MAX_OUTBOX_BOOT_ATTEMPTS,
  OUTBOX_MAX_REPLAY_AGE_MS,
  type OutboxEntry,
} from "@platform/engine";
import {
  applyDispatchFailure,
  makeDispatchBinding,
} from "../../lib/dispatch-binding";
import { act } from "react";
import { StagePinTile } from "../../components/calls/StagePinTile";
import { ScopeCharterTab } from "../../components/org/scope/ScopeTabs";
import type { OrgRole } from "../../components/org/orgTypes";
import { useMySends } from "../useMySends";
import { useDeferredCache } from "../use-deferred-cache";
import {
  replicationChannelName,
  replicationTransport,
} from "../../store/storage-transport";
import { startSyncReplication } from "../../store/sync-replication";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { hideInvalidatedDetails } from "../../store/doc-detail-authority";
import {
  canHydrateDetail,
  resetDetailInvalidations,
  setDetailInvalidationReporter,
} from "../../store/doc-detail-cache";
import { useSyncDocDetail, useSyncDocsPaginated } from "../use-sync-docs";

const id = "j".repeat(32);
const row = { _id: id, title: "Doc", content: "Has a body", updated_at: 1 };

afterEach(() => {
  authPrincipal.check();
  resetDetailInvalidations();
});

function Body() {
  useSyncDocDetail(id);
  const body = useInboxStore((state) => state.docDetails[id]?.content);
  return <p>{body ?? "No body"}</p>;
}

test("resolved access loss reports authority even when a detail was already evicted", async () => {
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
  });
  const reports: unknown[] = [];
  setDetailInvalidationReporter((evidence) => {
    reports.push(evidence);
    hideInvalidatedDetails(evidence.ids);
    return true;
  });
  await act(async () => {
    ui.store.getState().dropDocDetail(id);
    ui.backend.set(api.taskMining.webGetDocDetail, null);
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("No body");
  expect(reports).toEqual([{ cause: "access", ids: [id] }]);
});

test("a gap hides the body until a current authority read refills it", async () => {
  const current = Promise.withResolvers<typeof row>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
  });
  let reads = 0;
  setDetailInvalidationReporter(
    () => true,
    () => {
      reads++;
      return current.promise;
    },
  );
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe(row.content);
  await act(async () => {
    hideInvalidatedDetails();
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("No body");
  await act(async () => {
    ui.backend.set(api.taskMining.webGetDocDetail, {
      ...row,
      content: "An older queued answer",
    });
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("No body");
  await act(async () =>
    current.resolve({ ...row, content: "Current authorized result" }),
  );
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe("Current authorized result");
  expect(canHydrateDetail(id)).toBe(true);
  await act(async () =>
    ui.backend.set(api.taskMining.webGetDocDetail, {
      ...row,
      content: "Later live body",
    }),
  );
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe("Later live body");
  expect(reads).toBe(1);
});

test("an optimistic archive reports authority only after dispatch confirms it", async () => {
  const accepted = Promise.withResolvers<null>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, ({ action }) => {
        expect(action).toBe("archiveDoc");
        return accepted.promise;
      });
    },
  });
  const reports: unknown[] = [];
  setDetailInvalidationReporter((evidence) => {
    reports.push(evidence);
    return true;
  });
  await act(async () => {
    void ui.store.getState().archiveDoc(id);
  });
  expect(ui.container.textContent).toBe("No body");
  expect(reports).toEqual([]);
  await act(async () => accepted.resolve(null));
  expect(reports).toEqual([{ ids: [id], cause: "archive" }]);
});

test("a confirmed archive undo reauthorizes the body for hydration and subsequent live pushes", async () => {
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, () => null);
    },
  });
  const restored = Promise.withResolvers<typeof row>();
  setDetailInvalidationReporter(
    (evidence) => {
      hideInvalidatedDetails(evidence.ids);
      return true;
    },
    () => restored.promise,
  );
  await act(async () => {
    void ui.store.getState().archiveDoc(id);
  });
  expect(canHydrateDetail(id)).toBe(false);
  await act(async () => {
    void ui.store.getState().restoreArchivedDoc(id);
  });
  await act(async () => restored.resolve({ ...row, content: "Restored" }));
  await act(async () => flushSyncPublishes());
  expect(canHydrateDetail(id)).toBe(true);
  expect(ui.container.textContent).toBe("Restored");
  await act(async () =>
    ui.backend.set(api.taskMining.webGetDocDetail, {
      ...row,
      content: "Updated after undo",
    }),
  );
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe("Updated after undo");
});

test("a declined invalidation uses the untagged legacy store drop", async () => {
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
  });
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe(row.content);
  setDetailInvalidationReporter(() => false);
  await act(async () => ui.backend.set(api.taskMining.webGetDocDetail, null));
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe("No body");
  expect(canHydrateDetail(id)).toBe(true);
});

test.each(["stale", "archived"] as const)(
  "hydration stays blocked when the authority read is %s",
  async (answer) => {
    const ui = await mountWeb(<Body />, {
      authenticated: true,
      setup(backend) {
        backend.set(api.taskMining.webGetDocDetail, row);
      },
    });
    const first = Promise.withResolvers<
      typeof row & { archived_at?: number }
    >();
    const later = Promise.withResolvers<typeof row | null>();
    const reads: string[] = [];
    setDetailInvalidationReporter(
      () => true,
      (id) => {
        reads.push(id);
        return reads.length === 1 ? first.promise : later.promise;
      },
    );
    await act(async () => hideInvalidatedDetails());
    expect(reads).toEqual([id]);
    if (answer === "stale") {
      await act(async () => hideInvalidatedDetails([id]));
      expect(reads).toEqual([id, id]);
    }
    try {
      await act(async () =>
        first.resolve(answer === "archived" ? { ...row, archived_at: 2 } : row),
      );
      await act(async () => flushSyncPublishes());
      expect(canHydrateDetail(id)).toBe(false);
      expect(ui.container.textContent).toBe("No body");
    } finally {
      await act(async () => later.resolve(null));
    }
  },
);

test.each(["cold", "warm", "old"] as const)(
  "a %s document reader paints from available disk state before the server answers",
  async (cache) => {
    const oldPinned = cache === "old";
    const owner = `cached-doc-${cache}`;
    const ui = await mountWeb(null, {
      authenticated: true,
      setup(backend) {
        localStorage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken(owner));
        backend.set(api.taskMining.webGetDocDetail, pending);
      },
    });
    const restore = replaceGlobals({
      dispatchEvent: ui.dom.window.dispatchEvent.bind(ui.dom.window),
    });
    const read = Promise.withResolvers<void>();
    const originalLoad = cacheStorage.loadCache;
    const input = spyOn(cacheStorage, "loadCache").mockImplementation(
      async (keys, context) => {
        const rows = await originalLoad(keys, context);
        if (keys?.length === 1 && keys[0] === "docDetails") read.resolve();
        return rows;
      },
    );
    try {
      authPrincipal.check();
      expect(await authPrincipal.resolve()).toBe(owner);
      await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
      await db.meta.put({ key: "currentUser", value: { _id: owner } });
      await writeOwnerStamp(owner, "test-fixture");
      if (cache !== "cold")
        await db.table("docDetails").put({
          ...row,
          _cachedAt: cache === "old" ? row.updated_at : Date.now(),
        });
      await ui.rerender(<Body />);
      await act(async () => read.promise);
      expect(
        input.mock.calls.filter(
          ([keys]) => keys?.length === 1 && keys[0] === "docDetails",
        ),
      ).toHaveLength(1);
      expect(ui.container.textContent).toBe(
        cache === "warm" || oldPinned ? row.content : "No body",
      );
      await act(async () => {
        ui.backend.set(api.taskMining.webGetDocDetail, {
          ...row,
          content: "Live body",
        });
        flushSyncPublishes();
      });
      expect(ui.container.textContent).toBe("Live body");
    } finally {
      input.mockRestore();
      restore();
      await ui.close();
      authPrincipal.check();
      await cacheStorage.loadCache(["pending"]);
      db.close();
    }
  },
);

test("a late deferred cache read cannot restore a refused document", async () => {
  const disk = Promise.withResolvers<Record<string, unknown>>();
  const input = spyOn(cacheStorage, "loadCache").mockImplementation(
    async (keys) =>
      keys?.length === 1 && keys[0] === "docDetails" ? disk.promise : null,
  );
  const ui = await mountWeb(null, {
    authenticated: true,
    setup(backend) {
      localStorage.setItem(
        AUTH_JWT_STORAGE_KEY,
        issueFakeToken("deferred-denied"),
      );
      backend.set(api.taskMining.webGetDocDetail, pending);
    },
  });
  try {
    authPrincipal.check();
    expect(await authPrincipal.resolve()).toBe("deferred-denied");
    const report = mock(() => true);
    setDetailInvalidationReporter(report);
    await ui.rerender(<Body />);
    expect(
      input.mock.calls.filter(
        ([keys]) => keys?.length === 1 && keys[0] === "docDetails",
      ),
    ).toHaveLength(1);
    await act(async () => {
      ui.backend.set(api.taskMining.webGetDocDetail, null);
      flushSyncPublishes();
    });
    expect(report).toHaveBeenCalledTimes(1);
    await act(async () => disk.resolve({ docDetails: { [id]: row } }));
    expect(ui.container.textContent).toBe("No body");
  } finally {
    input.mockRestore();
    await ui.close();
  }
});

async function mountDeferred(
  owner: string,
  boot?: Parameters<typeof mountWeb>[1],
) {
  const ui = await mountWeb(null, {
    ...boot,
    authenticated: true,
    setup(backend, store) {
      localStorage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken(owner));
      backend.set(api.taskMining.webGetDocDetail, pending);
      backend.set(api.docSync.getPresence, []);
      backend.set(api.assistant.incidents.thinkingAvailable, pending);
      boot?.setup?.(backend, store);
    },
  });
  authPrincipal.check();
  expect(await authPrincipal.resolve()).toBe(owner);
  return ui;
}

function Sends() {
  const { rows, ready } = useMySends();
  return (
    <p>
      {ready
        ? rows.map((send) => send.text).join(",") || "Empty sends"
        : "Loading sends"}
    </p>
  );
}

const stage = (
  <StagePinTile
    share={{
      key: id,
      identity: id,
      name: "Doc",
      kind: "pin",
      pin: {
        _id: id,
        ref: id,
        kind: "doc",
        doc_id: id,
        title: "Doc",
        readable: true,
      },
    }}
  />
);
const charter = (
  <ScopeCharterTab
    role={{ charter_doc_id: id } as OrgRole}
    charter=""
    backHref="/"
    canEdit
    onUpdateCharter={() => {}}
  />
);

test.each(["stage", "charter", "sends"] as const)(
  "the %s reader keeps its loading state until its deferred rows arrive",
  async (reader) => {
    const disk = Promise.withResolvers<Record<string, unknown>>();
    const key = reader === "sends" ? "mySends" : "docDetails";
    const input = spyOn(cacheStorage, "loadCache").mockImplementation(
      async (keys) =>
        keys?.length === 1 && keys[0] === key ? disk.promise : null,
    );
    const ui = await mountDeferred(`deferred-wait-${reader}`, {
      setup(backend, store) {
        const { content: _content, ...thin } = row;
        store.syncRecord("docs", id, thin);
        backend.set(api.userSends.mine, { rows: [], nextBefore: null });
      },
    });
    try {
      await ui.rerender(
        reader === "stage" ? stage : reader === "charter" ? charter : <Sends />,
      );
      if (reader === "sends") {
        expect(ui.container.textContent).toBe("Loading sends");
      } else {
        const selector =
          reader === "stage"
            ? '[role="status"][aria-label="Loading"]'
            : '[aria-busy="true"]';
        expect(ui.container.querySelector(selector)).not.toBeNull();
        expect(!!ui.container.querySelector(".doc-editor")).toBe(false);
        expect(
          ui.backend.queryRequests.some(
            ({ name }) => name === "docSync:getPresence",
          ),
        ).toBe(false);
      }
      await act(async () =>
        disk.resolve(
          reader === "sends"
            ? {
                mySends: {
                  example: {
                    _id: "example",
                    timestamp: 10,
                    text: "Held send",
                  },
                },
              }
            : { docDetails: { [id]: row } },
        ),
      );
      if (reader === "sends")
        expect(ui.container.textContent).toBe("Held send");
      else if (reader === "stage") {
        expect(ui.container.querySelector(".doc-editor")).not.toBeNull();
        expect(ui.store.getState().docDetails[id]?.content).toBe(row.content);
      } else expect(ui.container.textContent).toContain(row.content);
    } finally {
      input.mockRestore();
      await ui.close();
    }
  },
);

function Prefetch() {
  useSyncDocsPaginated({ workspace: "personal" });
  return null;
}

test("doc body prefetch waits for cached bodies and fetches only the missing ones", async () => {
  const disk = Promise.withResolvers<Record<string, unknown>>();
  const missing = "k".repeat(32);
  const input = spyOn(cacheStorage, "loadCache").mockImplementation(
    async (keys) =>
      keys?.length === 1 && keys[0] === "docDetails" ? disk.promise : null,
  );
  const ui = await mountDeferred("deferred-prefetch", {
    setup(backend) {
      const { content: _content, ...thin } = row;
      backend.set(api.docs.webListPaginated, {
        page: [thin, { ...thin, _id: missing }],
        continueCursor: "",
        isDone: true,
      });
      backend.set(api.docs.webGetBodies, { bodies: [] });
    },
  });
  const bodyQueries = () =>
    ui.backend.queryRequests.filter(
      (request) => request.name === "docs:webGetBodies",
    );
  try {
    ui.store.setState({
      clientStateInitialized: true,
      currentUser: { _id: "deferred-prefetch" },
      syncLogScopeStamps: { "user:deferred-prefetch": 0 },
    });
    await ui.rerender(<Prefetch />);
    expect(input.mock.calls.some(([keys]) => keys?.[0] === "docDetails")).toBe(
      true,
    );
    expect(bodyQueries()).toEqual([]);
    await act(async () => disk.resolve({ docDetails: { [id]: row } }));
    expect(bodyQueries().map(({ args }) => args)).toEqual([{ ids: [missing] }]);
  } finally {
    input.mockRestore();
    await ui.close();
  }
});

test.each(["archive", "pin", "update", "archive and undo"] as const)(
  "a local %s wins over the deferred document snapshot",
  async (action) => {
    const disk = Promise.withResolvers<Record<string, unknown>>();
    const input = spyOn(cacheStorage, "loadCache").mockImplementation(
      async (keys) =>
        keys?.length === 1 && keys[0] === "docDetails" ? disk.promise : null,
    );
    const ui = await mountDeferred(`deferred-${action}`, {
      setup(_backend, store) {
        const { content: _content, ...thin } = row;
        if (action !== "archive") store.syncRecord("docs", id, thin);
        store._setDispatch(async () => null);
      },
    });
    try {
      await ui.rerender(<Body />);
      await act(async () => {
        const store = ui.store.getState();
        if (action === "archive" || action === "archive and undo") {
          if (action === "archive and undo")
            await store.updateDoc(id, {
              content: "Edited body",
              title: "Edited title",
            });
          await store.archiveDoc(id);
          expect(ui.store.getState().docs[id]).toBeUndefined();
          if (action === "archive and undo") expect(performUndo()).toBe(true);
        }
        if (action === "pin") await store.pinDoc(id, true);
        if (action === "update")
          await store.updateDoc(id, { content: "Edited body" });
        expect(store.docDetails[id]).toBeUndefined();
      });
      await act(async () => disk.resolve({ docDetails: { [id]: row } }));
      const detail = ui.store.getState().docDetails[id];
      if (action === "archive") expect(detail).toBeUndefined();
      if (action === "pin")
        expect(detail).toMatchObject({ pinned: true, content: row.content });
      if (action === "update") expect(detail?.content).toBe("Edited body");
      if (action === "archive and undo")
        expect(detail).toMatchObject({
          content: "Edited body",
          title: "Edited title",
        });
    } finally {
      input.mockRestore();
      await ui.close();
    }
  },
);

function DeferredProbe() {
  const ready = useDeferredCache("docDetails");
  return <p>{ready ? "Ready" : "Waiting"}</p>;
}

test("an empty deferred table is read once across repeated mounts", async () => {
  const input = spyOn(cacheStorage, "loadCache").mockResolvedValue(null);
  const ui = await mountDeferred("deferred-empty");
  try {
    for (let count = 0; count < 2; count++) {
      await ui.rerender(<DeferredProbe />);
      expect(ui.container.textContent).toBe("Ready");
      await ui.rerender(null);
    }
    expect(
      input.mock.calls.filter(([keys]) => keys?.[0] === "docDetails"),
    ).toHaveLength(1);
  } finally {
    input.mockRestore();
    await ui.close();
  }
});

test.each([false, true])(
  "a follower cannot reload a document absent from the host snapshot (disk read already started: %s)",
  async (started) => {
    const owner = "deferred-follower";
    const peer = replicationTransport(replicationChannelName(owner), "host");
    const disk = Promise.withResolvers<Record<string, unknown>>();
    const input = spyOn(cacheStorage, "loadCache").mockImplementation(
      async (keys) =>
        keys?.length === 1 && keys[0] === "docDetails" ? disk.promise : null,
    );
    const ui = await mountDeferred(owner);
    const restore = replaceGlobals({ navigator: { locks: { request() {} } } });
    const joined = Promise.withResolvers<void>();
    const liveId = "k".repeat(32);
    peer.channel.onMessage((message) => {
      if (message.type !== "hello") return;
      peer.channel.post({
        type: "snapshot",
        to: message.from,
        hostId: "host",
        seq: 1,
        entries: { docDetails: { [liveId]: { ...row, _id: liveId } } },
      });
    });
    let stop = () => {};
    const unsubscribe = ui.store.subscribe((state) => {
      if (state.syncRole === "follower") joined.resolve();
    });
    try {
      if (started) await ui.rerender(<Body />);
      await act(async () => {
        stop = startSyncReplication({ eligible: false, principalId: owner });
      });
      if (!started) await ui.rerender(<Body />);
      await act(async () => joined.promise);
      await act(async () => disk.resolve({ docDetails: { [id]: row } }));
      await act(async () => flushSyncPublishes());
      expect(ui.store.getState().docDetails[id]).toBeUndefined();
      expect(ui.store.getState().docDetails[liveId]).toBeDefined();
      expect(ui.container.textContent).toBe("No body");
      expect(
        input.mock.calls.filter(([keys]) => keys?.[0] === "docDetails"),
      ).toHaveLength(started ? 1 : 0);
    } finally {
      unsubscribe();
      await ui.rerender(null);
      stop();
      restore();
      peer.close();
      input.mockRestore();
      await ui.close();
    }
  },
);

test.each([
  "give up",
  "age out",
  "unwired",
  "live refusal",
  "replay refusal",
  "no reader",
] as const)("a dropped archive refreshes the open body (%s)", async (mode) => {
  const refusal = mode === "live refusal" || mode === "replay refusal";
  const unwired = mode === "unwired" || mode === "no reader";
  const ui = await mountWeb(mode === "no reader" ? null : <Body />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
    expectedConsoleErrors:
      mode === "give up"
        ? [
            /dispatch failed after retries: archiveDoc/,
            /dispatch failed after retries: archiveDoc/,
          ]
        : mode === "age out"
          ? [/dropping .* parked "archiveDoc"/]
          : refusal
            ? [/dispatch failed after retries: archiveDoc/]
            : [],
  });
  const state = ui.store.getState();
  const queue = new Map<string, OutboxEntry>();
  const store = state as typeof state & {
    _setOutbox: (
      enqueue: ((entry: OutboxEntry) => void) | null,
      remove: ((id: string) => void) | null,
      load: (() => Promise<OutboxEntry[]>) | null,
    ) => void;
  };
  const retired = Promise.withResolvers<void>();
  const send = makeDispatchBinding(async () => {
    throw new Error(
      refusal ? "Uncaught Error: Not authorized" : "connection down",
    );
  });
  try {
    setDetailInvalidationReporter(undefined, async () => row);
    store._setDispatch(null);
    if (unwired) store._setOutbox(null, null, null);
    else {
      store._setOutbox(
        (entry) => {
          queue.set(
            entry.id,
            mode === "age out"
              ? {
                  ...entry,
                  queuedAt: undefined,
                  ts: Date.now() - OUTBOX_MAX_REPLAY_AGE_MS - 1,
                }
              : { ...entry, attempts: MAX_OUTBOX_BOOT_ATTEMPTS - 1 },
          );
        },
        (id) => {
          queue.delete(id);
          retired.resolve();
        },
        async () => [...queue.values()],
      );
    }
    store._setDispatchError(applyDispatchFailure);
    if (mode === "live refusal") store._setDispatch(send);
    await act(async () => {
      state.syncRecord("docs", id, row);
      withoutUndo(() => {
        void state.archiveDoc(id);
      });
      expect(ui.store.getState().docDetails[id]).toBeUndefined();
    });
    if (!unwired && mode !== "live refusal") {
      expect(ui.container.textContent).toBe("No body");
      jest.useFakeTimers();
      await act(async () => {
        store._setDispatch(send);
      });
      if (mode === "give up")
        for (const delay of [1000, 2000, 4000])
          await act(async () => {
            jest.advanceTimersByTime(delay);
          });
    }
    if (!unwired) await act(async () => retired.promise);
    await act(async () => flushSyncPublishes());
    expect(ui.store.getState().docs[id]?.title).toBe(row.title);
    expect(ui.store.getState().pending[`docs:${id}`]).toBeUndefined();
    if (mode === "no reader") expect(canHydrateDetail(id)).toBe(true);
    else expect(ui.container.textContent).toBe(row.content);
  } finally {
    jest.useRealTimers();
    store._setDispatch(null);
    store._setDispatchError(() => {});
    store._setOutbox(null, null, null);
  }
});
