import type { ReplicationMessage } from "@platform/engine";
import { expect, mock, spyOn, test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";
import { AUTH_JWT_STORAGE_KEY, issueFakeToken } from "./fakeAuthToken";
import { TEST_PRINCIPAL } from "./signedInPrincipal";

export async function registerArchiveFallbackCases({
  bootCache,
  waitFor,
  holdHostLock,
}: {
  bootCache: () => Promise<void>;
  waitFor: (condition: () => boolean) => Promise<void>;
  holdHostLock: () => () => void;
}): Promise<void> {
  const { makeDispatchBinding } = await import("../../../lib/dispatch-binding");
  const { cacheStorage } = await import("../../idb-cache");
  const { useInboxStore } = await import("../../inboxStore");
  const { resetDetailInvalidations, setDetailInvalidationReporter } =
    await import("../../doc-detail-cache");
  const { db, COLLECTION_TABLES } = await import("../../persistence/db");
  const { loadCache } = await import("../../persistence/boot-loader");
  const { authPrincipal } = await import("../../../lib/authPrincipal");
  const { startSyncReplication, stopSyncReplication } =
    await import("../../sync-replication");
  const { replicationChannelName, replicationTransport, transportAvailable } =
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
    const restoreGlobals = replaceGlobals({ navigator: {} });
    resetDetailInvalidations();
    return () => {
      restoreGlobals();
      resetDetailInvalidations();
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
      expect(await COLLECTION_TABLES.docDetails.get(id)).toEqual(detail);
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
        await COLLECTION_TABLES.docDetails.put(detail);
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
        expect(await COLLECTION_TABLES.docDetails.get(id)).toEqual(detail);
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
        expect(await COLLECTION_TABLES.docDetails.get(id)).toBeUndefined();
      } finally {
        state()._setDispatch(null);
        stopSyncReplication();
        unsubscribe();
        peer.close();
        restore();
      }
    },
  );

  test.each([
    "follower",
    "panel",
    "joining",
    "live",
    "restored",
    "restore queued",
    "account changed",
    "jwt switched",
  ] as const)(
    "archive fallback preserves the cached body (%s)",
    async (mode) => {
      const restore = prepareFallback();
      const owner = spyOn(cacheStorage, "outboxAccountId");
      const token = localStorage.getItem(AUTH_JWT_STORAGE_KEY);
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
        if (mode === "jwt switched") {
          localStorage.setItem(
            AUTH_JWT_STORAGE_KEY,
            issueFakeToken("other-account"),
          );
          expect(authPrincipal.snapshot()).toBe(TEST_PRINCIPAL);
          expect(authPrincipal.current()).toBe("other-account");
        }
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
        if (
          mode === "follower" ||
          mode === "panel" ||
          mode === "joining" ||
          mode === "jwt switched"
        )
          expect(verify).not.toHaveBeenCalled();
        else expect(verify).toHaveBeenCalled();
        expect(await COLLECTION_TABLES.docDetails.get(id)).toEqual(detail);
      } finally {
        oldResponse.resolve();
        owner.mockRestore();
        if (token === null) localStorage.removeItem(AUTH_JWT_STORAGE_KEY);
        else localStorage.setItem(AUTH_JWT_STORAGE_KEY, token);
        Reflect.deleteProperty(window, "__CODECAST_ELECTRON__");
        restore();
      }
    },
  );

  test("local replication with no transport cleans a settled archive", async () => {
    const restore = prepareFallback();
    const verify = mock(async (_id: string) => archived);
    try {
      expect(transportAvailable()).toBe(false);
      await COLLECTION_TABLES.docDetails.put(detail);
      await bootCache();
      expect(await COLLECTION_TABLES.docDetails.get(id)).toEqual(detail);
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
      state().syncTable("docs", [archivedDoc], { isDelta: true });
      const deadline = Bun.nanoseconds() + 2_000_000_000;
      while (
        (await COLLECTION_TABLES.docDetails.get(id)) !== undefined &&
        Bun.nanoseconds() < deadline
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(verify.mock.calls).toEqual([[id]]);
      expect(state().docDetails[id]).toBeUndefined();
      expect(await COLLECTION_TABLES.docDetails.get(id)).toBeUndefined();
    } finally {
      stopSyncReplication();
      restore();
    }
  });
}
