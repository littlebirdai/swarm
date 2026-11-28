import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetSnapshotLedger } from "../../idb-collection-diff";
import type { CacheEpoch, EpochStore, WorkerSpawner } from "./protocol";
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS collection_rows (collection TEXT NOT NULL, id TEXT NOT NULL, timestamp REAL, value TEXT NOT NULL, PRIMARY KEY (collection, id));
  CREATE TABLE IF NOT EXISTS conversation_meta (id TEXT NOT NULL PRIMARY KEY, pagination TEXT, latest_timestamp REAL, user_messages TEXT, touched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS message_rows (conversation_id TEXT NOT NULL, message_key TEXT NOT NULL, position REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (conversation_id, message_key));
  INSERT OR IGNORE INTO migrations VALUES (1);
`;

function storeWithoutEvents(): EpochStore {
  const stored = createFakeEpochStore();
  return { read: () => stored.read(), write: (epoch) => stored.write(epoch) };
}

function nextGeneration(store: EpochStore) {
  const current = store.read()!;
  store.write({
    ...current,
    generation: current.generation + 1,
    updatedAt: current.updatedAt + 1,
  });
}

function holdingSpawner(inner: WorkerSpawner) {
  const control = {
    holdOp: null as string | null,
    heldId: null as string | null,
    held: [] as unknown[],
    deliver: null as ((data: unknown) => void) | null,
    swallowAll: false,
    release() {
      const messages = control.held.splice(0);
      for (const message of messages) control.deliver?.(message);
    },
  };
  const spawner: WorkerSpawner = (epoch, onMessage, onError) => {
    const deliver = (data: unknown) => {
      const reply = data as { type?: string; id?: string };
      if (reply?.type === "response" && reply.id === control.heldId) {
        control.held.push(data);
        return;
      }
      onMessage(data);
    };
    control.deliver = onMessage;
    const worker = inner(epoch, deliver, onError);
    return {
      postMessage(message: unknown) {
        if (control.swallowAll) return;
        const request = message as { type?: string; op?: string; id?: string };
        if (request?.type === "request" && request.op === control.holdOp) {
          control.heldId = request.id ?? null;
          control.holdOp = null;
        }
        worker.postMessage(message);
      },
      terminate: () => worker.terminate(),
    };
  };
  return { spawner, control };
}

function options(
  dir: string,
  overrides: Partial<Parameters<typeof createSqliteWorkerClient>[0]> = {},
) {
  const channelTransport =
    overrides.channelTransport ?? createFakeChannelTransport();
  return {
    auth: createTestAuth("userA"),
    schemaVersion: 116,
    epochStore: createFakeEpochStore(),
    locks: createFakeLockAdapter(),
    channelTransport,
    spawnWorker: createDiskWorkerSpawner(dir, channelTransport).spawner,
    opfsSupported: () => true,
    journal: createFakeJournal(),
    workerTimeoutMs: 2000,
    ...overrides,
  };
}

describe("SQLite epoch scope", () => {
  test("a buffered row survives a switch to a newer generation", async () => {
    const dir = tempDir("sqlite-switch-buffer-");
    const epochStore = storeWithoutEvents();
    const client = createSqliteWorkerClient(options(dir, { epochStore }));
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => client.holdsLock(), 1000, "owner holds gen 1");
      const sid = "b".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: row },
      });
      nextGeneration(epochStore);
      expect(await client.loadCache(["sessions"])).toBeNull();
      await client.flushPersistence();
      await delay(200);

      expect(epochStore.read()?.generation).toBe(2);
      expect(client.currentEpoch()?.generation).toBe(2);
      expect(await client.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
    } finally {
      client.close();
    }
  });

  test("a late answer from an older generation is not returned or remembered", async () => {
    const dir = tempDir("sqlite-late-answer-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = storeWithoutEvents();
    const { spawner, control } = holdingSpawner(
      createDiskWorkerSpawner(dir, channelTransport).spawner,
    );
    const client = createSqliteWorkerClient(
      options(dir, { epochStore, channelTransport, spawnWorker: spawner }),
    );
    try {
      await client.loadCache(["docDetails", "syncMeta"]);
      const doc = { _id: "doc-late", workspace: "team:old", content: "Old" };
      client.writePatches([patch("docDetails", doc._id)], {
        docDetails: { [doc._id]: doc },
      });
      await client.flushPersistence();

      control.holdOp = "loadCache";
      const late = client.loadCache(["docDetails"]);
      await waitUntil(() => control.held.length === 1, 1000, "answer held");
      nextGeneration(epochStore);
      expect(await client.readCachedDocDetails?.()).toEqual([]);
      control.release();

      expect(await late).toBeNull();
      expect(client.currentEpoch()?.generation).toBe(2);
      expect(client.persistedDocDetailWorkspace?.(doc._id)).toBeUndefined();
    } finally {
      client.close();
    }
  });

  test("a late answer after close is not remembered", async () => {
    const dir = tempDir("sqlite-closed-answer-");
    const channelTransport = createFakeChannelTransport();
    const { spawner, control } = holdingSpawner(
      createDiskWorkerSpawner(dir, channelTransport).spawner,
    );
    const shared = {
      channelTransport,
      spawnWorker: spawner,
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
    };
    const client = createSqliteWorkerClient(options(dir, shared));
    await client.loadCache(["docDetails", "syncMeta"]);
    const doc = { _id: "doc-closed", workspace: "team:gone", content: "Gone" };
    client.writePatches([patch("docDetails", doc._id)], {
      docDetails: { [doc._id]: doc },
    });
    await client.flushPersistence();
    client.close();
    const reopened = createSqliteWorkerClient(options(dir, shared));
    try {
      control.holdOp = "loadCache";
      const late = reopened.loadCache(["docDetails"]);
      await waitUntil(() => control.held.length === 1, 1000, "answer held");
      reopened.close();
      control.release();

      expect(await late).toBeNull();
      expect(reopened.persistedDocDetailWorkspace?.(doc._id)).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  test("an owner file that can never be read falls back to memory after a few rotations", async () => {
    const dir = tempDir("sqlite-owner-loop-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    let spawns = 0;
    const client = createSqliteWorkerClient(
      options(dir, {
        epochStore,
        channelTransport,
        spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
          onSpawn: () => {
            spawns++;
          },
          beforeOpen: (db) => {
            db.exec(SCHEMA);
            db.exec("INSERT OR REPLACE INTO meta VALUES ('cacheOwner', '{')");
          },
        }).spawner,
      }),
    );
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => client.isMemoryFallback(), 2000, "memory");
      await delay(100);

      expect(spawns).toBeLessThanOrEqual(5);
      expect(epochStore.read()!.generation).toBeLessThanOrEqual(5);
    } finally {
      client.close();
    }
  });

  test("a new account whose first load rotates still saves its cursor", async () => {
    const dir = tempDir("sqlite-account-retry-");
    const channelTransport = createFakeChannelTransport();
    const auth = createTestAuth("userA");
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(
      options(dir, {
        auth,
        epochStore,
        channelTransport,
        spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
          beforeOpen: (db, epoch: CacheEpoch) => {
            if (epoch.principal !== "userB" || epoch.generation !== 1) return;
            db.exec(SCHEMA);
            db.exec(
              `INSERT OR REPLACE INTO meta VALUES ('cacheOwner', '${JSON.stringify({ principal: "userB", at: 1, reason: "write-failed", blocked: true })}')`,
            );
          },
        }).spawner,
      }),
    );
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      auth.setPrincipal("userB");
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
      expect(client.currentEpoch()?.principal).toBe("userB");
      expect(client.currentEpoch()?.generation).toBe(2);
      client.writePatches([patch("syncMeta")], { syncMeta: { cursor: 9 } });
      await client.flushPersistence();

      expect(await client.loadCache(["syncMeta"])).toEqual({
        syncMeta: { cursor: 9 },
      });
    } finally {
      client.close();
    }
  });

  test("a request that times out during a drain after close rotates nothing", async () => {
    const dir = tempDir("sqlite-drain-timeout-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const { spawner, control } = holdingSpawner(
      createDiskWorkerSpawner(dir, channelTransport).spawner,
    );
    const client = createSqliteWorkerClient(
      options(dir, {
        epochStore,
        channelTransport,
        spawnWorker: spawner,
        workerTimeoutMs: 50,
      }),
    );
    await client.loadCache(["sessions"]);
    await waitUntil(() => client.holdsLock(), 1000, "owner holds the lock");
    control.swallowAll = true;
    const hung = client.loadConversationMessages("conversation");
    await delay(5);
    client.close();

    expect(await hung).toBeNull();
    await delay(250);
    expect(epochStore.read()?.generation).toBe(1);
  });

  test("a write sent at close is answered during the drain", async () => {
    const dir = tempDir("sqlite-drain-answer-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const locks = createFakeLockAdapter();
    const shared = { epochStore, locks, channelTransport };
    const client = createSqliteWorkerClient(options(dir, shared));
    await client.loadCache(["sessions", "syncMeta"]);
    await waitUntil(() => client.holdsLock(), 1000, "owner holds the lock");
    const sid = "d".repeat(32);
    const row = { _id: sid, updated_at: Date.now() };
    client.writePatches([patch("sessions", sid)], {
      sessions: { [sid]: row },
    });
    const started = Date.now();
    client.close();
    await client.flushPersistence();
    expect(Date.now() - started).toBeLessThan(1000);

    const next = createSqliteWorkerClient(options(dir, shared));
    try {
      expect(await next.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
      expect(epochStore.read()?.generation).toBe(1);
    } finally {
      next.close();
    }
  });
});
