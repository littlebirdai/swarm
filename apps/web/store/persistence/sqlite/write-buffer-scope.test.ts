import { afterEach, describe, expect, test } from "bun:test";
import { _resetSnapshotLedger } from "../../idb-collection-diff";
import type { EpochStore } from "./protocol";
import { createSqliteWorkerClient } from "./worker-client";
import {
  clientOptions,
  createWorkerTap,
  removeTempDirs,
  tapSpawner,
  tempDir,
} from "./__tests__/client-harness";
import {
  createDiskWorkerSpawner,
  createFakeChannelTransport,
  createFakeEpochStore,
  createFakeJournal,
  patch,
  waitUntil,
} from "./__tests__/worker-testkit";

afterEach(() => {
  _resetSnapshotLedger();
  removeTempDirs();
});

describe("SQLite window buffer scope", () => {
  test("a buffer written before the first epoch is dropped by a later purge", async () => {
    const dir = tempDir("sqlite-null-key-buffer-");
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(clientOptions(dir, { epochStore }));
    try {
      const sid = "n".repeat(32);
      client.writePatches([patch("sessions", sid), patch("syncMeta")], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
        syncMeta: { cursor: 42 },
      });
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
      const before = epochStore.read()!;
      epochStore.write({
        ...before,
        accountEpoch: before.accountEpoch + 1,
        generation: 1,
        updatedAt: before.updatedAt + 1,
      });
      await waitUntil(
        () => client.currentEpoch()?.accountEpoch === 2 && client.holdsLock(),
        1000,
        "follows the purge",
      );
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
      await client.flushPersistence();

      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
    } finally {
      client.close();
    }
  });

  test("a lost flush from before a purge writes nothing into the memory cache", async () => {
    const dir = tempDir("sqlite-purge-memory-");
    const channelTransport = createFakeChannelTransport();
    const stored = createFakeEpochStore();
    const writes = { fail: false };
    const epochStore: EpochStore = {
      read: () => stored.read(),
      write: (epoch) => (writes.fail ? false : stored.write(epoch)),
      subscribe: stored.subscribe,
    };
    const tap = createWorkerTap();
    let hold = false;
    tap.dropRequest = (_epoch, op) => hold && op === "flushBatch";
    const client = createSqliteWorkerClient(
      clientOptions(dir, {
        epochStore,
        channelTransport,
        spawnWorker: tapSpawner(
          createDiskWorkerSpawner(dir, channelTransport).spawner,
          tap,
        ),
      }),
    );
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => client.holdsLock(), 1000, "owner holds the lock");
      hold = true;
      const sid = "q".repeat(32);
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
      });
      const flushing = client.flushPersistence();
      await waitUntil(
        () => tap.events.includes("g1:dropped:flushBatch"),
        1000,
        "flush reaches the worker",
      );
      writes.fail = true;
      await client.purgeLocalCache({ reason: "sign-out" });
      await flushing;

      expect(client.isMemoryFallback()).toBe(true);
      expect(await client.loadCache(["sessions"])).toBeNull();
    } finally {
      client.close();
    }
  });

  test("a purge on a closed client keeps the shared journal", async () => {
    const dir = tempDir("sqlite-closed-journal-");
    const journal = createFakeJournal();
    const client = createSqliteWorkerClient(clientOptions(dir, { journal }));
    await client.loadCache(["sessions"]);
    await journal.enqueueDispatch({
      id: "unsent",
      action: "renameSession",
      args: [],
      ts: 1,
    });
    client.close();
    await client.purgeLocalCache({ reason: "sign-out" });

    expect(journal.outbox.map((entry) => entry.id)).toEqual(["unsent"]);
  });

  test("a window that leaves its epoch drops the buffer it holds", async () => {
    const dir = tempDir("sqlite-leave-buffer-");
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(clientOptions(dir, { epochStore }));
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => client.holdsLock(), 1000, "owner holds the lock");
      client.writeConversationMessages(
        "conversation",
        [{ _id: "m1", timestamp: 1, content: "Before" }],
        { hasMoreAbove: false },
      );
      const before = epochStore.read()!;
      epochStore.write({ ...before, principal: "userB", updatedAt: 2 });
      await waitUntil(() => !client.holdsLock(), 1000, "window leaves");

      const loaded = await client.loadConversationMessages("conversation");
      expect(loaded?.messages ?? []).toEqual([]);
    } finally {
      client.close();
    }
  });
});
