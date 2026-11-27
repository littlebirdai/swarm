import { expect, mock, spyOn, test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";
import { TEST_PRINCIPAL } from "./signedInPrincipal";

export async function registerArchiveFallbackCases({
  bootCache,
  waitFor,
}: {
  bootCache: () => Promise<void>;
  waitFor: (condition: () => boolean) => Promise<void>;
}): Promise<void> {
  const { makeDispatchBinding } = await import("../../../lib/dispatch-binding");
  const { cacheStorage } = await import("../../idb-cache");
  const { useInboxStore } = await import("../../inboxStore");
  const { resetDetailInvalidations, setDetailInvalidationReporter } =
    await import("../../doc-detail-cache");
  const { db, COLLECTION_TABLES } = await import("../../persistence/db");
  const { loadCache } = await import("../../persistence/boot-loader");
  const state = () => useInboxStore.getState();
  const id = "z".repeat(32);
  const detail = { _id: id, content: "Cached body", updated_at: 1 };
  const archived = { ...detail, archived_at: 2 };

  function prepareFallback() {
    const before = process.env.VITE_CACHE_EVICTION_METADATA;
    process.env.VITE_CACHE_EVICTION_METADATA = "1";
    const restoreGlobals = replaceGlobals({ navigator: {} });
    resetDetailInvalidations();
    return () => {
      restoreGlobals();
      resetDetailInvalidations();
      if (before === undefined) delete process.env.VITE_CACHE_EVICTION_METADATA;
      else process.env.VITE_CACHE_EVICTION_METADATA = before;
    };
  }

  test("archive replay removes the cached body before retiring the outbox entry", async () => {
    const restore = prepareFallback();
    try {
      setDetailInvalidationReporter(undefined, async () => archived);
      await COLLECTION_TABLES.docDetails.put(detail);
      await db.dispatchOutbox.put({
        id: "archive-replay",
        accountId: TEST_PRINCIPAL,
        action: "archiveDoc",
        args: [id],
        patches: undefined,
        result: null,
        ts: Date.now(),
      });
      await bootCache();
      const store = state() as ReturnType<typeof state> & {
        _hasBootOutboxDrained: () => boolean;
      };
      store._setDispatch(
        makeDispatchBinding(async ({ action, args }) => {
          expect(action).toBe("archiveDoc");
          expect(args).toEqual([id]);
          return null;
        }),
      );
      await waitFor(store._hasBootOutboxDrained);
      expect(await db.dispatchOutbox.count()).toBe(0);
      expect(await COLLECTION_TABLES.docDetails.get(id)).toBeUndefined();
      expect(
        (await loadCache(["docDetails"]))?.docDetails?.[id],
      ).toBeUndefined();
    } finally {
      state()._setDispatch(null);
      restore();
    }
  });

  test.each([
    "follower",
    "panel",
    "joining",
    "live",
    "restored",
    "restore queued",
    "account changed",
  ] as const)(
    "archive fallback preserves the cached body (%s)",
    async (mode) => {
      const restore = prepareFallback();
      const owner = spyOn(cacheStorage, "outboxAccountId");
      const oldResponse = Promise.withResolvers<void>();
      const verifying = Promise.withResolvers<void>();
      const dispatch = makeDispatchBinding(async () => null);
      let reads = 0;
      const verify = mock(async () => {
        if (mode === "restored" && reads++ === 0) {
          verifying.resolve();
          await oldResponse.promise;
          return archived;
        }
        if (mode === "account changed") owner.mockReturnValue("other-account");
        if (mode === "restored") return null;
        return mode === "live" ? detail : archived;
      });
      try {
        await COLLECTION_TABLES.docDetails.put(detail);
        setDetailInvalidationReporter(undefined, verify);
        if (mode === "follower")
          useInboxStore.setState({ syncRole: "follower" });
        if (mode === "panel")
          Object.defineProperty(window, "__CODECAST_ELECTRON__", {
            configurable: true,
            value: { isPaletteWindow: true },
          });
        if (mode === "joining")
          Object.defineProperty(navigator, "locks", {
            value: { request() {} },
          });
        if (mode === "restore queued")
          await db.dispatchOutbox.put({
            id: "restore",
            action: "restoreArchivedDoc",
            args: [id],
            accountId: TEST_PRINCIPAL,
            patches: undefined,
            result: null,
            ts: 2,
          });
        const archive = dispatch(
          "archiveDoc",
          [id],
          undefined,
          undefined,
          undefined,
          {
            outbox: {
              id: "archive",
              accountId: TEST_PRINCIPAL,
              queuedAt: 1,
              ageMs: 0,
            },
          },
        );
        if (mode === "restored") {
          await verifying.promise;
          await dispatch("restoreArchivedDoc", [id]);
          oldResponse.resolve();
        }
        await archive;
        if (mode === "follower" || mode === "panel" || mode === "joining")
          expect(verify).not.toHaveBeenCalled();
        else expect(verify).toHaveBeenCalled();
        expect(await COLLECTION_TABLES.docDetails.get(id)).toEqual(detail);
      } finally {
        oldResponse.resolve();
        owner.mockRestore();
        Reflect.deleteProperty(window, "__CODECAST_ELECTRON__");
        restore();
      }
    },
  );
}
