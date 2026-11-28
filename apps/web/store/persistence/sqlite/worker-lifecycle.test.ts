import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetSnapshotLedger } from "../../idb-collection-diff";
import { createSqliteCache } from "./cache-storage";
import type {
  CacheEpoch,
  ChannelTransport,
  EpochStore,
  WorkerSpawner,
} from "./protocol";
import { createSqliteWorkerClient } from "./worker-client";
import {
  createDiskWorkerSpawner,
  createFakeChannelTransport,
  createFakeEpochStore,
  createFakeJournal,
  createFakeLockAdapter,
  createTestAuth,
  patch,
  waitUntil,
} from "./__tests__/worker-testkit";

const tempDirs: string[] = [];

afterEach(() => {
  _resetSnapshotLedger();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function clientOptions(
  dir: string,
  overrides: {
    epochStore?: EpochStore;
    channelTransport?: ChannelTransport;
    spawnWorker?: WorkerSpawner;
    workerTimeoutMs?: number;
  } = {},
) {
  const channelTransport =
    overrides.channelTransport ?? createFakeChannelTransport();
  return {
    auth: createTestAuth("userA"),
    schemaVersion: 116,
    epochStore: overrides.epochStore ?? createFakeEpochStore(),
    locks: createFakeLockAdapter(),
    channelTransport,
    spawnWorker:
      overrides.spawnWorker ??
      createDiskWorkerSpawner(dir, channelTransport).spawner,
    opfsSupported: () => true,
    journal: createFakeJournal(),
    workerTimeoutMs: overrides.workerTimeoutMs ?? 2000,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SQLite worker lifecycle", () => {
  test("an idle owner that moves to a newer generation keeps the new one working", async () => {
    const dir = tempDir("sqlite-switch-generation-");
    const stored = createFakeEpochStore();
    const epochStore: EpochStore = {
      read: () => stored.read(),
      write: (epoch) => stored.write(epoch),
    };
    const client = createSqliteWorkerClient(clientOptions(dir, { epochStore }));

    try {
      await client.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => client.holdsLock(), 1000, "owner holds gen 1");
      const first = epochStore.read()!;
      epochStore.write({
        ...first,
        generation: 2,
        updatedAt: first.updatedAt + 1,
      });
      expect(await client.loadCache(["sessions"])).toBeNull();
      await waitUntil(
        () => client.currentEpoch()?.generation === 2 && client.holdsLock(),
        1000,
        "owner holds gen 2",
      );
      await delay(250);

      const sid = "s".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: row },
      });
      await client.flushPersistence();

      expect(await client.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
      expect(epochStore.read()?.generation).toBe(2);
      expect(client.holdsLock()).toBe(true);
    } finally {
      client.close();
    }
  });

  test("close settles a request that waits for the worker and rotates nothing", async () => {
    const dir = tempDir("sqlite-close-waiter-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(
      clientOptions(dir, {
        epochStore,
        channelTransport,
        spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
          hang: () => true,
        }).spawner,
        workerTimeoutMs: 1500,
      }),
    );

    const started = Date.now();
    const loading = client.loadCache(["sessions"]);
    await waitUntil(() => client.holdsLock(), 1000, "owner holds the lock");
    client.close();

    expect(await loading).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    await delay(50);
    expect(epochStore.read()?.generation).toBe(1);
  });

  test("a first load that rotates retries once and binds the sync cursor", async () => {
    const dir = tempDir("sqlite-rotate-retry-");
    const channelTransport = createFakeChannelTransport();
    const initial: CacheEpoch = {
      schemaVersion: 116,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    };
    const epochStore = createFakeEpochStore(initial);
    let seeded = false;
    const client = createSqliteWorkerClient(
      clientOptions(dir, {
        epochStore,
        channelTransport,
        spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
          beforeOpen: (db) => {
            if (seeded) return;
            seeded = true;
            db.exec(`
              CREATE TABLE migrations (version INTEGER PRIMARY KEY);
              CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
              CREATE TABLE collection_rows (collection TEXT NOT NULL, id TEXT NOT NULL, timestamp REAL, value TEXT NOT NULL, PRIMARY KEY (collection, id));
              CREATE TABLE conversation_meta (id TEXT NOT NULL PRIMARY KEY, pagination TEXT, latest_timestamp REAL, user_messages TEXT, touched_at INTEGER NOT NULL);
              CREATE TABLE message_rows (conversation_id TEXT NOT NULL, message_key TEXT NOT NULL, position REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (conversation_id, message_key));
              INSERT INTO migrations VALUES (1);
              INSERT INTO meta VALUES ('cacheOwner', '${JSON.stringify({ principal: "userA", at: 1, reason: "write-failed", blocked: true })}');
            `);
          },
        }).spawner,
      }),
    );

    try {
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
      expect(epochStore.read()?.generation).toBe(2);
      client.writePatches([patch("syncMeta")], { syncMeta: { cursor: 3 } });
      await client.flushPersistence();

      expect(await client.loadCache(["syncMeta"])).toEqual({
        syncMeta: { cursor: 3 },
      });
    } finally {
      client.close();
    }
  });

  test("a saved owner check is not reused after the owner read throws", async () => {
    const db = new Database(":memory:");
    try {
      const cache = createSqliteCache(db, createTestAuth("userA"));
      expect(await cache.loadCache(["sessions"])).toBeNull();
      cache.setHydrating(false);
      const sid = "o".repeat(32);
      cache.writePatches([patch("sessions", sid), patch("currentUser")], {
        currentUser: { _id: "userA" },
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
      });
      expect(cache.ownerState()).toEqual({
        named: ["userA", "userA"],
        blocked: false,
      });
      db.exec("UPDATE meta SET value = '{' WHERE key = 'cacheOwner'");

      expect(() => cache.ownerState()).toThrow();
      expect(await cache.loadCache(["sessions"])).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a worker that cannot read the file owner fails the read closed", async () => {
    const dir = tempDir("sqlite-owner-unreadable-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    let firstDb: Database | null = null;
    const client = createSqliteWorkerClient(
      clientOptions(dir, {
        epochStore,
        channelTransport,
        spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
          beforeOpen: (db) => {
            firstDb ??= db;
          },
        }).spawner,
      }),
    );

    try {
      await client.loadCache(["sessions"]);
      firstDb!.exec("UPDATE meta SET value = '{' WHERE key = 'cacheOwner'");

      expect(await client.loadCache(["sessions"])).toBeNull();
      await waitUntil(
        () => (epochStore.read()?.generation ?? 0) === 2,
        1000,
        "unreadable owner starts the next generation",
      );
    } finally {
      client.close();
    }
  });

  test("a closing message from another worker does not end the owner's drain", async () => {
    const dir = tempDir("sqlite-foreign-closing-");
    const transport = createFakeChannelTransport();
    const onPeerWrite = { run: null as (() => void) | null };
    const channelTransport: ChannelTransport = {
      open(name, onMessage) {
        return transport.open(name, (data) => {
          onMessage(data);
          const request = data as { type?: string; op?: string };
          if (request?.type !== "request" || request.op !== "flushBatch")
            return;
          const run = onPeerWrite.run;
          onPeerWrite.run = null;
          run?.();
        });
      },
    };
    const epochStore = createFakeEpochStore();
    const locks = createFakeLockAdapter();
    const disk = createDiskWorkerSpawner(dir, channelTransport);
    const ownerMessages = { send: null as ((data: unknown) => void) | null };
    const spawnWorker: WorkerSpawner = (epoch, onMessage, onError) => {
      ownerMessages.send ??= onMessage;
      return disk.spawner(epoch, onMessage, onError);
    };
    const options = {
      ...clientOptions(dir, { epochStore, channelTransport, spawnWorker }),
      locks,
    };
    const owner = createSqliteWorkerClient(options);
    const peer = createSqliteWorkerClient(options);

    try {
      await owner.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => owner.holdsLock(), 1000, "owner holds the lock");
      await peer.loadCache(["sessions", "syncMeta"]);
      const sid = "f".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      peer.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: row },
      });
      onPeerWrite.run = () => {
        owner.close();
        ownerMessages.send!({
          type: "worker-closing",
          workerId: "another-worker",
          epochId: "v116-a1-g1",
        });
      };
      await peer.flushPersistence();
      await waitUntil(() => peer.holdsLock(), 1000, "peer takes the lock");

      expect(epochStore.read()?.generation).toBe(1);
      expect(await peer.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
    } finally {
      owner.close();
      peer.close();
    }
  });
});
