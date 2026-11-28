import { expect, jest, test } from "bun:test";
import type { ReplicationMessage } from "@platform/engine";
import type { InboxStoreState } from "../../inboxStore";
import type { COLLECTION_TABLES } from "../../persistence/db";
import type * as Transport from "../../storage-transport";
import type * as Replication from "../../sync-replication";
import { TEST_PRINCIPAL } from "./signedInPrincipal";

export function registerTimedDocReplicationCases({
  window,
  state,
  sessionId,
  table,
  bootCache,
  drainWrites,
  waitFor,
  holdHostLock,
  startSyncReplication,
  stopSyncReplication,
  replicationTransport,
  replicationChannelName,
  startMutationLog,
  readMutations,
}: {
  window: Window;
  state: () => Pick<InboxStoreState, "docDetails" | "syncRole" | "syncTable">;
  sessionId: (n: number) => string;
  table: (typeof COLLECTION_TABLES)["docDetails"];
  bootCache: () => Promise<void>;
  drainWrites: () => Promise<void>;
  waitFor: (condition: () => boolean) => Promise<void>;
  holdHostLock: () => () => void;
  startSyncReplication: typeof Replication.startSyncReplication;
  stopSyncReplication: typeof Replication.stopSyncReplication;
  replicationTransport: typeof Transport.replicationTransport;
  replicationChannelName: typeof Transport.replicationChannelName;
  startMutationLog: () => void;
  readMutations: () => readonly { table: string }[] | undefined;
}) {
  test.each(["host", "follower"] as const)(
    "timed document caps evict only in memory for a %s",
    async (role) => {
      const { persistedDocDetailWorkspace } =
        await import("../../doc-detail-disk");
      const { lastPersisted } =
        await import("../../persistence/collection-writer");
      const { resetDetailInvalidations } =
        await import("../../doc-detail-cache");
      resetDetailInvalidations();
      const doc = window.document;
      Object.defineProperty(doc, "hidden", {
        configurable: true,
        value: false,
      });
      const releaseLock = holdHostLock();
      const old = {
        _id: sessionId(1),
        workspace: "team:alpha",
        content: "Evicted at boot",
        updated_at: 1,
      };
      const current = {
        ...old,
        _id: sessionId(2),
        content: "Evicted by the timer",
        updated_at: Date.now(),
      };
      const peerId = "timed-cap-peer";
      const peer = replicationTransport(
        replicationChannelName(TEST_PRINCIPAL),
        peerId,
      );
      const messages: ReplicationMessage[] = [];
      peer.channel.onMessage((message) => messages.push(message));
      const status = () =>
        (
          window as Window & {
            __syncReplication: () => Replication.SyncReplicationStatus;
          }
        ).__syncReplication();
      try {
        await table.bulkPut([old, current]);
        await bootCache();
        expect(state().docDetails[current._id]).toBeUndefined();
        const { loadCache } = await import("../../persistence/boot-loader");
        const cached = await loadCache(["docDetails"]);
        state().syncTable(
          "docDetails",
          Object.values(cached?.docDetails ?? {}),
          {
            isDelta: true,
          },
        );
        expect(state().docDetails[old._id]).toBeUndefined();
        expect(persistedDocDetailWorkspace(old._id)).toBe(old.workspace);
        expect(state().docDetails[current._id]?.content).toBe(current.content);
        jest.useFakeTimers();
        jest.setSystemTime(current.updated_at + 31 * 86_400_000);
        startMutationLog();
        startSyncReplication({
          eligible: role === "host",
          principalId: TEST_PRINCIPAL,
          detailAuthority: {
            async detail() {
              return current;
            },
            async page() {
              return { page: [old, current], isDone: true, continueCursor: "" };
            },
          },
        });
        if (role === "host") {
          releaseLock();
          await waitFor(() => status().elected);
        } else {
          await waitFor(() =>
            messages.some((message) => message.type === "hello"),
          );
          const snapshot = {
            type: "snapshot" as const,
            to: status().selfId,
            hostId: peerId,
            seq: 0,
            entries: { docDetails: { [current._id]: current } },
            detailInvalidation: { version: 1, compatible: true },
          };
          peer.channel.post(snapshot);
          await waitFor(() => status().synced);
        }
        expect(state().syncRole).toBe(role);
        expect(state().docDetails[current._id]).toBeDefined();
        jest.advanceTimersByTime(1000);
        expect(state().docDetails[current._id]).toBeUndefined();
        jest.useRealTimers();
        await drainWrites();
        expect(await table.toArray()).toEqual([old, current]);
        expect(lastPersisted.get("docDetails")?.get(current._id)).toEqual({
          _id: current._id,
          workspace: current.workspace,
        });
        expect(
          readMutations()?.filter(
            (mutation) => mutation.table === "docDetails",
          ),
        ).toEqual([]);
        expect(
          messages
            .flatMap((message) =>
              message.type === "mut" || message.type === "update"
                ? message.updates
                : [],
            )
            .flatMap((update) =>
              update.key === "docDetails" ? (update.removes ?? []) : [],
            ),
        ).toEqual([]);
      } finally {
        jest.useRealTimers();
        stopSyncReplication();
        peer.close();
        Reflect.deleteProperty(doc, "hidden");
        resetDetailInvalidations();
      }
    },
  );
}
