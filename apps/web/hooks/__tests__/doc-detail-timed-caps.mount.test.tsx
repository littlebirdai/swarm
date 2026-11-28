import { afterEach, expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { _resetUndoStacks, performUndo } from "@platform/engine";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { hideInvalidatedDetails } from "../../store/doc-detail-authority";
import {
  canHydrateDetail,
  detailInvalidationRevision,
  resetDetailInvalidations,
  setDetailInvalidationReporter,
  subscribeDetailInvalidations,
} from "../../store/doc-detail-cache";
import { isDetailPinned } from "../../lib/detail-rows";
import { useDocDetail } from "../use-sync-docs";

const id = "j".repeat(32);
const row = { _id: id, title: "Doc", content: "Has a body", updated_at: 1 };

afterEach(() => {
  _resetUndoStacks();
  resetDetailInvalidations();
});

function Body() {
  const { detail } = useDocDetail(id);
  const body = detail?.content;
  return <p>{body ?? "No body"}</p>;
}

test("an unrelated invalidation cannot replay the query object after archive", async () => {
  const accepted = Promise.withResolvers<null>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, () => accepted.promise);
    },
  });
  try {
    expect(ui.container.textContent).toBe(row.content);
    await act(async () => {
      hideInvalidatedDetails(["x".repeat(32)]);
      void ui.store.getState().archiveDoc(id);
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe("No body");
    expect(ui.store.getState().pending[`docs:${id}`]).toBeUndefined();
    await act(async () => {
      ui.backend.set(api.taskMining.webGetDocDetail, {
        ...row,
        content: "A new push",
      });
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe("A new push");
    await act(async () => {
      ui.backend.set(api.taskMining.webGetDocDetail, {
        ...row,
        archived_at: 2,
      });
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe("No body");
  } finally {
    await act(async () => accepted.resolve(null));
    await ui.close();
  }
});

test("a changed feeder callback does not reapply an already consumed query object", async () => {
  const results = new Set<object>();
  function Reader() {
    const { detail, detailResult } = useDocDetail(id);
    useLayoutEffect(() => {
      if (detailResult) results.add(detailResult);
    }, [detailResult]);
    return <span>{detail?.content ?? "No body"}</span>;
  }
  const ui = await mountWeb(<Reader />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
  });
  try {
    expect(ui.container.textContent).toBe(row.content);
    expect(results.size).toBe(1);
    const initial = [...results][0];
    await ui.rerender(<Reader />);
    await act(async () => {
      ui.store.getState().dropDocDetail(id);
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe("No body");

    await ui.rerender(<Reader />);
    await act(async () => flushSyncPublishes());
    expect([...results]).toEqual([initial]);
    expect(ui.container.textContent).toBe("No body");
  } finally {
    await ui.close();
  }
});

test("after an accepted archive an authority refill lets later live pushes land", async () => {
  const confirmed = Promise.withResolvers<typeof row>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    setup(backend, store) {
      store.syncRecord("docs", id, {
        _id: id,
        title: row.title,
        updated_at: 1,
      });
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, () => null);
    },
  });
  try {
    setDetailInvalidationReporter(
      (evidence) => {
        hideInvalidatedDetails(evidence.ids);
        return true;
      },
      () => confirmed.promise,
    );
    await act(async () => {
      await ui.store.getState().archiveDoc(id);
    });
    expect(ui.container.textContent).toBe("No body");
    expect(canHydrateDetail(id)).toBe(false);
    expect(ui.store.getState().pending[`docs:${id}`]?.type).toBe("exclude");

    await act(async () =>
      confirmed.resolve({ ...row, content: "Confirmed live body" }),
    );
    await act(async () => flushSyncPublishes());
    expect(canHydrateDetail(id)).toBe(true);
    expect(ui.container.textContent).toBe("Confirmed live body");
    await act(async () => {
      ui.backend.set(api.taskMining.webGetDocDetail, {
        ...row,
        content: "A later edit",
      });
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe("A later edit");
  } finally {
    await ui.close();
  }
});

test("a direct restore refills the detail and lets later live pushes land", async () => {
  let serverRestored = false;
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    setup(backend, store) {
      store.syncRecord("docs", id, {
        _id: id,
        title: row.title,
        updated_at: 1,
      });
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, ({ action }) => {
        if (action === "restoreArchivedDoc") serverRestored = true;
        return null;
      });
    },
  });
  const restored = Promise.withResolvers<typeof row>();
  try {
    setDetailInvalidationReporter(
      (evidence) => {
        hideInvalidatedDetails(evidence.ids);
        return true;
      },
      () => (serverRestored ? restored.promise : Promise.resolve(null)),
    );
    await act(async () => {
      await ui.store.getState().archiveDoc(id);
    });
    expect(canHydrateDetail(id)).toBe(false);
    expect(ui.container.textContent).toBe("No body");
    expect(ui.store.getState().pending[`docs:${id}`]?.type).toBe("exclude");

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
        content: "Updated after restore",
      }),
    );
    await act(async () => flushSyncPublishes());
    expect(ui.container.textContent).toBe("Updated after restore");
    await act(async () =>
      ui.store
        .getState()
        .syncRecord("docs", id, { _id: id, title: row.title, updated_at: 2 }),
    );
    expect(ui.store.getState().docs[id]?.title).toBe(row.title);
    expect(ui.store.getState().pending[`docs:${id}`]?.type).not.toBe("exclude");
  } finally {
    await ui.close();
  }
});

test.each([false, true])(
  "a refused archive revalidates the open body (has list row: %s)",
  async (hasListRow) => {
    const archive = Promise.withResolvers<null>();
    const ui = await mountWeb(<Body />, {
      authenticated: true,
      dispatch: true,
      expectedConsoleErrors: [
        /^\[CONVEX M\(dispatch:dispatch\)\] Error: Uncaught Error: Not authorized$/,
        /^\[sync\] dispatch failed after retries: archiveDoc/,
      ],
      setup(backend, store) {
        if (hasListRow)
          store.syncRecord("docs", id, {
            _id: id,
            title: row.title,
            updated_at: 1,
          });
        backend.set(api.taskMining.webGetDocDetail, row);
        backend.mutation(api.dispatch.dispatch, () => archive.promise);
      },
    });
    try {
      setDetailInvalidationReporter(undefined, async () => ({
        ...row,
        content: "Revalidated body",
      }));
      await act(async () => {
        void ui.store.getState().archiveDoc(id);
      });
      const archiveLock = ui.store.getState().pending[`docs:${id}`];
      if (hasListRow) expect(archiveLock?.type).toBe("exclude");
      else expect(archiveLock).toBeUndefined();
      expect(ui.container.textContent).toBe("No body");
      await act(async () => {
        archive.reject(new Error("Uncaught Error: Not authorized"));
        flushSyncPublishes();
      });
      await act(async () => flushSyncPublishes());
      expect(ui.store.getState().pending[`docs:${id}`]).toBeUndefined();
      expect(ui.container.textContent).toBe("Revalidated body");
      if (hasListRow)
        expect(ui.store.getState().docs[id]?.title).toBe(row.title);
    } finally {
      await ui.close();
    }
  },
);

test("an archive refusal without a fresh reader leaves later live pushes usable", async () => {
  const archive = Promise.withResolvers<null>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    expectedConsoleErrors: [
      /^\[CONVEX M\(dispatch:dispatch\)\] Error: Uncaught Error: Not authorized$/,
      /^\[sync\] dispatch failed after retries: archiveDoc/,
    ],
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, () => archive.promise);
    },
  });
  try {
    await act(async () => {
      void ui.store.getState().archiveDoc(id);
    });
    expect(ui.container.textContent).toBe("No body");
    await act(async () =>
      archive.reject(new Error("Uncaught Error: Not authorized")),
    );
    await act(async () => {
      ui.backend.set(api.taskMining.webGetDocDetail, {
        ...row,
        content: "Fresh live edit",
      });
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe("Fresh live edit");
    expect(canHydrateDetail(id)).toBe(true);
  } finally {
    await ui.close();
  }
});

test.each([true, false])(
  "a mounted document pins its detail until it unmounts (authenticated: %s)",
  async (authenticated) => {
    const ui = await mountWeb(<Body />, {
      authenticated,
      setup(backend) {
        backend.set(api.taskMining.webGetDocDetail, row);
      },
    });
    ui.store.getState().syncRecord("docDetails", id, row);
    await act(async () => flushSyncPublishes());
    expect(ui.container.textContent).toBe(row.content);
    expect(isDetailPinned("docDetails", id)).toBe(true);
    await ui.rerender(null);
    expect(isDetailPinned("docDetails", id)).toBe(false);
  },
);

test("a permanent refusal of an overtaken archive does not refill while a newer archive is pending", async () => {
  const archive1 = Promise.withResolvers<null>();
  const restore = Promise.withResolvers<null>();
  const archive2 = Promise.withResolvers<null>();
  let archives = 0;
  let reads = 0;
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    expectedConsoleErrors: [
      /^\[CONVEX M\(dispatch:dispatch\)\] Error: Uncaught Error: Not authorized$/,
      /^\[sync\] dispatch failed after retries: archiveDoc/,
    ],
    setup(backend, store) {
      store.syncRecord("docs", id, {
        _id: id,
        title: row.title,
        updated_at: 1,
      });
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, ({ action }) => {
        if (action === "restoreArchivedDoc") return restore.promise;
        archives++;
        return archives === 1 ? archive1.promise : archive2.promise;
      });
    },
  });
  try {
    setDetailInvalidationReporter(undefined, async () => {
      reads++;
      return row;
    });
    expect(ui.container.textContent).toBe(row.content);
    await act(async () => {
      void ui.store.getState().archiveDoc(id);
    });
    expect(ui.store.getState().pending[`docs:${id}`]?.type).toBe("exclude");
    expect(ui.container.textContent).toBe("No body");
    await act(async () => {
      expect(performUndo()).toBe(true);
      flushSyncPublishes();
    });
    expect(ui.container.textContent).toBe(row.content);
    await act(async () => {
      void ui.store.getState().archiveDoc(id);
    });
    expect(ui.store.getState().pending[`docs:${id}`]?.type).toBe("exclude");
    expect(ui.container.textContent).toBe("No body");
    await act(async () => {
      archive1.reject(new Error("Uncaught Error: Not authorized"));
      flushSyncPublishes();
    });
    await act(async () => flushSyncPublishes());
    expect(ui.store.getState().pending[`docs:${id}`]?.type).toBe("exclude");
    expect(ui.store.getState().docDetails[id]).toBeUndefined();
    expect(ui.container.textContent).toBe("No body");
    expect(reads).toBe(0);
  } finally {
    await act(async () => {
      restore.resolve(null);
      archive2.resolve(null);
    });
    await ui.close();
  }
});

test("a single permanent archive refusal invalidates and reads fresh once for a mounted reader", async () => {
  const archive = Promise.withResolvers<null>();
  let reads = 0;
  let invalidations = 0;
  let lastRevision = detailInvalidationRevision(id);
  const unsubscribe = subscribeDetailInvalidations(() => {
    const revision = detailInvalidationRevision(id);
    if (revision > lastRevision) {
      lastRevision = revision;
      invalidations++;
    }
  });
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    expectedConsoleErrors: [
      /^\[CONVEX M\(dispatch:dispatch\)\] Error: Uncaught Error: Not authorized$/,
      /^\[sync\] dispatch failed after retries: archiveDoc/,
    ],
    setup(backend, store) {
      store.syncRecord("docs", id, {
        _id: id,
        title: row.title,
        updated_at: 1,
      });
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, () => archive.promise);
    },
  });
  try {
    setDetailInvalidationReporter(undefined, async () => {
      reads++;
      return { ...row, content: "Revalidated once" };
    });
    await act(async () => {
      void ui.store.getState().archiveDoc(id);
    });
    expect(ui.container.textContent).toBe("No body");
    await act(async () => {
      archive.reject(new Error("Uncaught Error: Not authorized"));
      flushSyncPublishes();
    });
    await act(async () => flushSyncPublishes());
    expect(invalidations).toBe(1);
    expect(reads).toBe(1);
    expect(ui.container.textContent).toBe("Revalidated once");
  } finally {
    unsubscribe();
    await ui.close();
  }
});

test("a non-subscribing useDocDetail caller does not strand hydration after a dropped archive", async () => {
  const archive = Promise.withResolvers<null>();
  function PassiveBody() {
    const { detail } = useDocDetail(id, false);
    return <p>{detail?.content ?? "No body"}</p>;
  }
  const ui = await mountWeb(<PassiveBody />, {
    authenticated: true,
    dispatch: true,
    expectedConsoleErrors: [
      /^\[CONVEX M\(dispatch:dispatch\)\] Error: Uncaught Error: Not authorized$/,
      /^\[sync\] dispatch failed after retries: archiveDoc/,
    ],
    setup(backend, store) {
      store.syncRecord("docs", id, {
        _id: id,
        title: row.title,
        updated_at: 1,
      });
      store.syncRecord("docDetails", id, row);
      backend.mutation(api.dispatch.dispatch, () => archive.promise);
    },
  });
  try {
    setDetailInvalidationReporter(undefined, async () => row);
    expect(ui.container.textContent).toBe(row.content);
    await act(async () => {
      void ui.store.getState().archiveDoc(id);
    });
    expect(ui.container.textContent).toBe("No body");
    await act(async () => {
      archive.reject(new Error("Uncaught Error: Not authorized"));
      flushSyncPublishes();
    });
    await act(async () => flushSyncPublishes());
    expect(ui.store.getState().pending[`docs:${id}`]).toBeUndefined();
    expect(canHydrateDetail(id)).toBe(true);
  } finally {
    await ui.close();
  }
});
