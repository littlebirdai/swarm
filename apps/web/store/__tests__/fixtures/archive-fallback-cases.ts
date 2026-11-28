import type { ReplicationMessage } from "@platform/engine";
import { expect, mock, test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";
import { TEST_PRINCIPAL } from "./signedInPrincipal";

export async function registerArchiveFallbackCases({
  seedCollection,
  readCachedDetail,
  bootCache,
  waitFor,
  holdHostLock,
}: {
  seedCollection: (
    key: string,
    rows: Array<{ _id: string } & Record<string, unknown>>,
  ) => Promise<void>;
  readCachedDetail: (id: string) => Promise<unknown>;
  bootCache: () => Promise<void>;
  waitFor: (condition: () => boolean) => Promise<void>;
  holdHostLock: () => () => void;
}): Promise<void> {
  const { makeDispatchBinding } = await import("../../../lib/dispatch-binding");
  const { cacheStorage } = await import("../../idb-cache");
  const { useInboxStore } = await import("../../inboxStore");
  const { resetDetailInvalidations, setDetailInvalidationReporter } =
    await import("../../doc-detail-cache");
  const { db } = await import("../../persistence/db");
  const { startSyncReplication, stopSyncReplication } =
    await import("../../sync-replication");
  const { replicationChannelName, replicationTransport } =
    await import("../../storage-transport");
  const state = () => useInboxStore.getState();
  const id = "z".repeat(32);
  const detail = { _id: id, content: "Cached body", updated_at: Date.now() };
  const archivedDoc = {
    _id: id,
    updated_at: detail.updated_at,
    archived_at: detail.updated_at,
  };
  const archived = { ...detail, ...archivedDoc };

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
      await seedCollection("docDetails", [detail]);
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
      expect(await readCachedDetail(id)).toEqual(detail);
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
      expect(await readCachedDetail(id)).toBeUndefined();
      expect(
        (await cacheStorage.loadCache(["docDetails"]))?.docDetails?.[id],
      ).toBeUndefined();
    } finally {
      state()._setDispatch(null);
      restore();
    }
  });

  test.each(["before election", "after election"] as const)(
    "an archive replay before the lock is granted is cleaned by the host (%s)",
    async (when) => {
      const restore = prepareFallback();
      const grantLock = holdHostLock();
      const peer = replicationTransport(
        replicationChannelName(TEST_PRINCIPAL),
        "archive-observer",
      );
      const messages: ReplicationMessage[] = [];
      const unsubscribe = peer.channel.onMessage((message) =>
        messages.push(message),
      );
      const verify = mock(async (_id: string) => archived);
      try {
        await seedCollection("docDetails", [detail]);
        await db.dispatchOutbox.put({
          id: "archive-before-election",
          accountId: TEST_PRINCIPAL,
          action: "archiveDoc",
          args: [id],
          patches: undefined,
          result: null,
          ts: Date.now(),
        });
        await bootCache();
        startSyncReplication({
          eligible: true,
          principalId: TEST_PRINCIPAL,
          detailAuthority: {
            detail: verify,
            async page() {
              throw new Error("The archive echo should not need a crawl");
            },
          },
        });
        const store = state() as ReturnType<typeof state> & {
          _hasBootOutboxDrained: () => boolean;
        };
        store._setDispatch(
          makeDispatchBinding(async ({ action }) => {
            expect(action).toBe("archiveDoc");
            return null;
          }),
        );
        await waitFor(store._hasBootOutboxDrained);
        expect(await db.dispatchOutbox.count()).toBe(0);
        expect(await readCachedDetail(id)).toEqual(detail);
        expect(verify).not.toHaveBeenCalled();
        if (when === "before election")
          state().syncRecord("docs", id, archivedDoc);
        grantLock();
        const status = () =>
          (
            window as Window & {
              __syncReplication?: () => { holdsLock: boolean };
            }
          ).__syncReplication?.();
        await waitFor(() => status()?.holdsLock === true);
        if (when === "after election")
          state().syncTable("docs", [archivedDoc], { isDelta: true });
        await waitFor(() =>
          messages.some(
            (message) =>
              message.type === "update" &&
              message.updates.some(
                (update) =>
                  update.key === "docDetails" &&
                  update.kind === "authoritativeRemoval" &&
                  update.ids.includes(id),
              ),
          ),
        );
        expect(verify.mock.calls).toEqual([[id]]);
        expect(state().docDetails[id]).toBeUndefined();
        expect(await readCachedDetail(id)).toBeUndefined();
      } finally {
        state()._setDispatch(null);
        stopSyncReplication();
        unsubscribe();
        peer.close();
        restore();
      }
    },
  );
}
