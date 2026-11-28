import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { _resetSnapshotLedger } from "../../idb-collection-diff";
import {
  epochChannelName,
  epochDirectory,
  epochId,
  type CacheEpoch,
  type ChannelTransport,
  type EpochStore,
} from "./protocol";
import { createSqliteWorkerClient } from "./worker-client";
import {
  clientOptions,
  createWorkerTap,
  delay,
  releaseHeld,
  removeTempDirs,
  storeWithoutEvents,
  tapSpawner,
  tempDir,
} from "./__tests__/client-harness";
import {
  createDiskWorkerSpawner,
  createFakeChannelTransport,
  createFakeEpochStore,
  createFakeLockAdapter,
  createTestAuth,
  patch,
  waitUntil,
} from "./__tests__/worker-testkit";

afterEach(() => {
  _resetSnapshotLedger();
  removeTempDirs();
});

describe("SQLite worker message rules", () => {
  test("a rotation does not attach to an epoch of another schema version", async () => {
    const dir = tempDir("sqlite-rotate-schema-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = storeWithoutEvents();
    const tap = createWorkerTap();
    let failing = false;
    tap.failAnswers = () => failing;
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
      await waitUntil(() => client.holdsLock(), 1000, "owner holds gen 1");
      failing = true;
      tap.onReply = (_epoch, data) =>
        (data as { type?: string })?.type === "response" ? "hold" : undefined;
      const loading = client.loadCache(["sessions"]);
      await waitUntil(() => tap.held.length === 1, 1000, "answer held");
      tap.onReply = undefined;
      const current = epochStore.read()!;
      epochStore.write({ ...current, schemaVersion: 117, updatedAt: 2 });
      releaseHeld(tap);
      expect(await loading).toBeNull();
      await waitUntil(() => !client.holdsLock(), 1000, "gen 1 left");
      await delay(20);

      expect(tap.spawned.map((epoch) => epoch.schemaVersion)).toEqual([116]);
    } finally {
      client.close();
    }
  });

  test("a closing message from an older peer worker leaves a live write alone", async () => {
    const dir = tempDir("sqlite-stale-closing-");
    const transport = createFakeChannelTransport();
    const held: Array<() => void> = [];
    const hold = { flush: false };
    const channelTransport: ChannelTransport = {
      open: (name, onMessage) =>
        transport.open(name, (data) => {
          const request = data as { type?: string; op?: string };
          if (
            hold.flush &&
            request?.type === "request" &&
            request.op === "flushBatch"
          ) {
            held.push(() => onMessage(data));
            return;
          }
          onMessage(data);
        }),
    };
    const shared = {
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      channelTransport,
      auth: createTestAuth("userA"),
    };
    const spawnWorker = createDiskWorkerSpawner(dir, channelTransport).spawner;
    const owner = createSqliteWorkerClient(
      clientOptions(dir, { ...shared, spawnWorker }),
    );
    const peer = createSqliteWorkerClient(
      clientOptions(dir, { ...shared, spawnWorker }),
    );
    try {
      await owner.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => owner.holdsLock(), 1000, "owner holds the lock");
      await peer.loadCache(["sessions", "syncMeta"]);
      hold.flush = true;
      const sid = "l".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      peer.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: row },
      });
      const writing = peer.flushPersistence();
      await waitUntil(() => held.length === 1, 1000, "write reaches worker");
      const epoch = shared.epochStore.read()!;
      transport
        .open(epochChannelName(epoch), () => {})
        .post({
          type: "worker-closing",
          workerId: "w-old",
          epochId: epochId(epoch),
        });
      await delay(0);
      hold.flush = false;
      for (const deliver of held.splice(0)) deliver();
      await writing;

      expect(shared.epochStore.read()?.generation).toBe(1);
      expect(await peer.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
    } finally {
      owner.close();
      peer.close();
    }
  });

  test("a write lost to a replaced peer worker rotates before close can send the cursor", async () => {
    const dir = tempDir("sqlite-lost-before-close-");
    const transport = createFakeChannelTransport();
    const hook = { afterReady: null as (() => void) | null };
    const peerTransport: ChannelTransport = {
      open: (name, onMessage) =>
        transport.open(name, (data) => {
          onMessage(data);
          const message = data as { type?: string; workerId?: string };
          if (message?.type !== "worker-ready" || message.workerId !== "w-1")
            return;
          const run = hook.afterReady;
          hook.afterReady = null;
          run?.();
        }),
    };
    const shared = {
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      auth: createTestAuth("userA"),
    };
    const owner = createSqliteWorkerClient(
      clientOptions(dir, {
        ...shared,
        channelTransport: transport,
        spawnWorker: createDiskWorkerSpawner(dir, transport).spawner,
      }),
    );
    const peer = createSqliteWorkerClient(
      clientOptions(dir, {
        ...shared,
        channelTransport: peerTransport,
        spawnWorker: createDiskWorkerSpawner(dir, transport).spawner,
      }),
    );
    try {
      await owner.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => owner.holdsLock(), 1000, "owner holds the lock");
      await peer.loadCache(["sessions", "syncMeta"]);
      const first = shared.epochStore.read()!;
      const announce = transport.open(epochChannelName(first), () => {});
      announce.post({
        type: "worker-ready",
        workerId: "w-old",
        epochId: epochId(first),
        epoch: first,
      });
      await delay(0);
      const sid = "r".repeat(32);
      peer.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
      });
      void peer.flushPersistence();
      hook.afterReady = () => {
        peer.writePatches([patch("syncMeta")], { syncMeta: { cursor: 5 } });
        peer.close();
      };
      announce.post({
        type: "worker-ready",
        workerId: "w-1",
        epochId: epochId(first),
        epoch: first,
      });
      await waitUntil(() => hook.afterReady === null, 1000, "peer closed");
      await delay(50);

      const file = join(dir, epochDirectory(first).slice(1), "cache.sqlite3");
      expect(existsSync(file)).toBe(true);
      const db = new Database(file, { readonly: true });
      try {
        expect(
          db.query("SELECT value FROM meta WHERE key = 'syncMeta'").get(),
        ).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      owner.close();
      peer.close();
    }
  });

  test("an owner worker that closes itself starts the next generation", async () => {
    const dir = tempDir("sqlite-owner-closes-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const tap = createWorkerTap();
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
      await waitUntil(() => client.holdsLock(), 1000, "owner holds gen 1");
      const first = epochStore.read()!;
      tap.deliver.get(1)!({
        type: "worker-closing",
        workerId: "w-1",
        epochId: epochId(first),
      });
      await waitUntil(
        () => epochStore.read()?.generation === 2 && client.holdsLock(),
        1000,
        "owner moves to gen 2",
      );

      expect(tap.events).toContain("g1:terminate");
    } finally {
      client.close();
    }
  });

  test("a stale epoch record does not move the window to an older generation", async () => {
    const dir = tempDir("sqlite-older-record-");
    const epochStore = storeWithoutEvents();
    const client = createSqliteWorkerClient(clientOptions(dir, { epochStore }));
    try {
      await client.loadCache(["sessions"]);
      const first = epochStore.read()!;
      epochStore.write({ ...first, generation: 2, updatedAt: 2 });
      await client.loadCache(["sessions"]);
      expect(client.currentEpoch()?.generation).toBe(2);
      epochStore.write(first);
      await client.loadCache(["sessions"]);

      expect(client.currentEpoch()?.generation).toBe(2);
    } finally {
      client.close();
    }
  });

  test("the epoch record listener is never added without OPFS and is removed on disable", async () => {
    const dir = tempDir("sqlite-store-listener-");
    const listeners = new Set<(epoch: CacheEpoch | null) => void>();
    const stored = createFakeEpochStore();
    const epochStore: EpochStore = {
      read: () => stored.read(),
      write: (epoch) => stored.write(epoch),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const memoryOnly = createSqliteWorkerClient(
      clientOptions(dir, { epochStore, opfsSupported: () => false }),
    );
    expect(listeners.size).toBe(0);
    memoryOnly.close();

    const channelTransport = createFakeChannelTransport();
    const tap = createWorkerTap();
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
      expect(listeners.size).toBe(1);
      await client.loadCache(["sessions"]);
      const first = stored.read()!;
      tap.deliver.get(1)!({
        type: "worker-opfs-missing",
        workerId: "w-1",
        epochId: epochId(first),
        error: "Missing required OPFS APIs.",
      });
      await waitUntil(() => client.isMemoryFallback(), 1000, "memory");

      expect(listeners.size).toBe(0);
    } finally {
      client.close();
    }
  });

  test("an OPFS loss reported after close does not switch the closed client", async () => {
    const dir = tempDir("sqlite-disable-after-close-");
    const channelTransport = createFakeChannelTransport();
    const tap = createWorkerTap();
    const fallbacks: string[] = [];
    const client = createSqliteWorkerClient(
      clientOptions(dir, {
        channelTransport,
        spawnWorker: tapSpawner(
          createDiskWorkerSpawner(dir, channelTransport).spawner,
          tap,
        ),
        onFallbackToMemory: (reason) => fallbacks.push(reason),
      }),
    );
    await client.loadCache(["sessions"]);
    const deliver = tap.deliver.get(1)!;
    client.close();
    deliver({
      type: "worker-opfs-missing",
      workerId: "w-1",
      epochId: "v116-a1-g1",
      error: "Missing required OPFS APIs.",
    });
    await delay(0);

    expect(fallbacks).toEqual([]);
    expect(client.isMemoryFallback()).toBe(false);
  });
});
