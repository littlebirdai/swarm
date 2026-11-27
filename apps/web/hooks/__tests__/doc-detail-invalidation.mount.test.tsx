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
import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
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
import { useSyncDocDetail } from "../use-sync-docs";

const flag = "VITE_CACHE_EVICTION_METADATA";
const original = process.env[flag];
const id = "j".repeat(32);
const row = { _id: id, title: "Doc", content: "Has a body", updated_at: 1 };

afterEach(() => {
  resetDetailInvalidations();
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
});

function Body() {
  useSyncDocDetail(id);
  const body = useInboxStore((state) => state.docDetails[id]?.content);
  return <p>{body ?? "No body"}</p>;
}

test("resolved access loss reports authority even when a detail was already evicted", async () => {
  process.env[flag] = "1";
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
  process.env[flag] = "1";
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
  process.env[flag] = "1";
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
  process.env[flag] = "1";
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
  process.env[flag] = "1";
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
    process.env[flag] = "1";
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

test.each(["cold", "warm"] as const)(
  "a %s document reader paints from available disk state before the server answers",
  async (cache) => {
    const enabled = process.env.VITE_DEFERRED_CACHE_BOOT === "1";
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
      if (cache === "warm") {
        await db.table("docDetails").put({ ...row, _cachedAt: Date.now() });
        if (!enabled) ui.store.getState().syncRecord("docDetails", id, row);
      }
      await ui.rerender(<Body />);
      if (enabled) await act(async () => read.promise);
      expect(
        input.mock.calls.filter(
          ([keys]) => keys?.length === 1 && keys[0] === "docDetails",
        ),
      ).toHaveLength(enabled ? 1 : 0);
      expect(ui.container.textContent).toBe(
        cache === "warm" ? row.content : "No body",
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
      db.close();
      restore();
      await ui.close();
    }
  },
);

test("a late deferred cache read cannot restore a refused document", async () => {
  delete process.env[flag];
  const enabled = process.env.VITE_DEFERRED_CACHE_BOOT === "1";
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
    await ui.rerender(<Body />);
    expect(
      input.mock.calls.filter(
        ([keys]) => keys?.length === 1 && keys[0] === "docDetails",
      ),
    ).toHaveLength(enabled ? 1 : 0);
    await act(async () => {
      ui.backend.set(api.taskMining.webGetDocDetail, null);
      flushSyncPublishes();
    });
    await act(async () => disk.resolve({ docDetails: { [id]: row } }));
    expect(ui.container.textContent).toBe("No body");
  } finally {
    input.mockRestore();
    await ui.close();
  }
});
