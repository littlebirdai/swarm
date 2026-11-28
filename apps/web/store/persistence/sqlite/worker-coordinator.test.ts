import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _reopenForTests, db as dexie } from "../db";
import type { JournalBridge } from "./journal-bridge";
import {
  epochId,
  markEpochFailed,
  resolveTargetEpoch,
  type CacheEpoch,
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SQLite cache worker coordinator", () => {
  test("lock handover preserves persisted cache across holder close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-handover-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    const spawned: string[] = [];
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport, {
      onSpawn: (ep) => spawned.push(epochId(ep)),
    });

    const clientA = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });
    const clientB = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      const sid = "a".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      await clientA.loadCache(["sessions"]);
      clientA.writePatches([patch("sessions"), patch("syncMeta")], {
        sessions: { [sid]: row },
        syncMeta: { s: { cursor: 7 } },
      });
      await clientA.flushPersistence();

      expect(clientA.holdsLock()).toBe(true);
      expect(clientB.holdsLock()).toBe(false);

      const fromPeer = await clientB.loadCache(["sessions", "syncMeta"]);
      expect(fromPeer).toEqual({
        sessions: { [sid]: row },
        syncMeta: { s: { cursor: 7 } },
      });
      expect(spawned).toHaveLength(1);
      expect(clientB.holdsLock()).toBe(false);

      clientA.close();
      await waitUntil(() => clientB.holdsLock(), 1000, "clientB lock handover");
      expect(spawned).toHaveLength(2);
      expect(spawned[0]).toBe(spawned[1]);

      const afterHandover = await clientB.loadCache(["sessions", "syncMeta"]);
      expect(afterHandover).toEqual({
        sessions: { [sid]: row },
        syncMeta: { s: { cursor: 7 } },
      });
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  test("peer reads and writes go through addressed BroadcastChannel without spawning a second worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-peer-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    let peerSpawned = 0;
    const { spawner: ownerSpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
    );

    const clientA = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: ownerSpawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });
    const clientB = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: () => {
        peerSpawned++;
        throw new Error("Peer should not spawn worker while lock is held");
      },
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      await clientA.loadCache(["sessions"]);
      const sid = "b".repeat(32);
      const row = { _id: sid, updated_at: Date.now(), title: "from-peer" };
      clientB.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await clientB.flushPersistence();

      expect(peerSpawned).toBe(0);
      expect(await clientA.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  test("hung holder times out, falls back to null, and starts the next epoch with an empty file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-hung-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");

    let hangHost = false;
    const { spawner: flakySpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
      { hang: () => hangHost },
    );
    const { spawner: healthySpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
    );

    const clientA = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: flakySpawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 5000,
    });
    const clientB = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: healthySpawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 50,
    });

    try {
      hangHost = true;
      const hungRead = clientA.loadCache(["sessions"]).catch(() => null);
      await waitUntil(() => clientA.holdsLock(), 1000, "clientA acquires lock");
      const firstEpoch = epochStore.read()!;
      expect(firstEpoch.generation).toBe(1);

      const fallbackRead = await clientB.loadCache(["sessions"]);
      expect(fallbackRead).toBeNull();

      await waitUntil(
        () => (epochStore.read()?.generation ?? 0) >= 2 && clientB.holdsLock(),
        1000,
        "clientB starts generation 2 after hung holder",
      );
      expect(epochStore.read()!.generation).toBeGreaterThanOrEqual(2);

      const sid = "c".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      clientB.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await clientB.flushPersistence();
      expect(await clientB.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
      clientA.close();
      await hungRead;
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  test("worker no-answer timeout falls back to null on read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-timeout-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");

    let dropRpc = false;
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport, {
      hangRpc: () => dropRpc,
    });
    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 50,
    });

    try {
      await client.loadCache(["sessions"]);
      expect(client.holdsLock()).toBe(true);
      dropRpc = true;
      const start = Date.now();
      const result = await client.loadConversationMessages("conv-1");
      expect(result).toBeNull();
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      client.close();
    }
  });

  test("write-failed rotates to a new epoch with an empty file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-write-failed-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");

    let activeDb: Database | null = null;
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport, {
      beforeOpen: (db) => {
        activeDb = db;
      },
    });

    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      const sid = "d".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      await client.loadCache(["sessions"]);
      client.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await client.flushPersistence();
      const genBefore = epochStore.read()!.generation;

      activeDb!.exec("PRAGMA query_only = ON");
      client.writePatches([patch("sessions"), patch("syncMeta")], {
        sessions: { [sid]: { ...row, title: "fail" } },
        syncMeta: { s: { cursor: 99 } },
      });
      await client.flushPersistence();

      await waitUntil(
        () =>
          (epochStore.read()?.generation ?? 0) > genBefore &&
          client.holdsLock(),
        1000,
        "new epoch after write-failed",
      );
      expect(await client.loadCache(["sessions"])).toBeNull();

      const freshRow = { _id: sid, updated_at: Date.now(), title: "recovered" };
      client.writePatches([patch("sessions")], {
        sessions: { [sid]: freshRow },
      });
      await client.flushPersistence();
      expect(await client.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: freshRow },
      });
    } finally {
      client.close();
    }
  });

  test("blocked owner on disk causes a new holder to start the next epoch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-blocked-disk-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const initial: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    };
    const epochStore = createFakeEpochStore(initial);
    const auth = createTestAuth("userA");

    let seeded = false;
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport, {
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
    });

    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      expect(await client.loadCache(["sessions"])).toBeNull();
      await waitUntil(
        () => (epochStore.read()?.generation ?? 0) >= 2 && client.holdsLock(),
        1000,
        "epoch rotated on blocked cacheOwner",
      );
      expect(epochStore.read()!.generation).toBe(2);
    } finally {
      client.close();
    }
  });

  test("owner mismatch in stored file refuses to serve foreign rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-owner-mismatch-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const authA = createTestAuth("userA");
    const authB = createTestAuth("userB");
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport);

    const clientA = createSqliteWorkerClient({
      auth: authA,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });
    const clientB = createSqliteWorkerClient({
      auth: authB,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      const sid = "e".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      await clientA.loadCache(["sessions"]);
      clientA.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await clientA.flushPersistence();

      const epochOfA = epochStore.read()!;
      const forgedSameFileStore = createFakeEpochStore({
        ...epochOfA,
        principal: "userB",
      });
      clientA.close();

      const snooper = createSqliteWorkerClient({
        auth: authB,
        schemaVersion: 115,
        epochStore: forgedSameFileStore,
        locks,
        channelTransport,
        spawnWorker: spawner,
        opfsSupported: () => true,
        journal: createFakeJournal(),
        workerTimeoutMs: 500,
      });
      try {
        expect(await snooper.loadCache(["sessions"])).toBeNull();
      } finally {
        snooper.close();
      }

      expect(await clientB.loadCache(["sessions"])).toBeNull();

      const clientA2 = createSqliteWorkerClient({
        auth: authA,
        schemaVersion: 115,
        epochStore: createFakeEpochStore(epochOfA),
        locks,
        channelTransport,
        spawnWorker: spawner,
        opfsSupported: () => true,
        journal: createFakeJournal(),
        workerTimeoutMs: 500,
      });
      try {
        expect(await clientA2.loadCache(["sessions"])).toMatchObject({
          sessions: { [sid]: row },
        });
      } finally {
        clientA2.close();
      }
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  test("sign-out, upgrade, and rollback start a new epoch immediately without waiting", () => {
    const base: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 4,
      generation: 3,
      principal: "userA",
      updatedAt: 100,
    };

    const signOut = resolveTargetEpoch({
      stored: base,
      schemaVersion: 115,
      principal: null,
      tokenState: "absent",
      now: 200,
    });
    expect(signOut).toEqual({
      action: "create",
      reason: "sign-out",
      epoch: {
        schemaVersion: 115,
        accountEpoch: 5,
        generation: 1,
        principal: null,
        updatedAt: 200,
      },
    });

    const upgrade = resolveTargetEpoch({
      stored: base,
      schemaVersion: 116,
      principal: "userA",
      tokenState: "named",
      now: 300,
    });
    expect(upgrade).toEqual({
      action: "create",
      reason: "upgrade",
      epoch: {
        schemaVersion: 116,
        accountEpoch: 5,
        generation: 1,
        principal: "userA",
        updatedAt: 300,
      },
    });

    const rollback = resolveTargetEpoch({
      stored: { ...base, schemaVersion: 116 },
      schemaVersion: 115,
      principal: "userA",
      tokenState: "named",
      now: 400,
    });
    expect(rollback).toEqual({
      action: "create",
      reason: "rollback",
      epoch: {
        schemaVersion: 115,
        accountEpoch: 5,
        generation: 1,
        principal: "userA",
        updatedAt: 400,
      },
    });

    const unreadable = resolveTargetEpoch({
      stored: base,
      schemaVersion: 115,
      principal: null,
      tokenState: "unparsable",
      now: 500,
    });
    expect(unreadable.action).toBe("hold");
    expect(unreadable.epoch).toBeNull();

    const failedReuse = resolveTargetEpoch({
      stored: markEpochFailed(base, "write-failed", 450),
      schemaVersion: 115,
      principal: "userA",
      tokenState: "named",
      now: 500,
    });
    expect(failedReuse).toEqual({
      action: "create",
      reason: "write-failed",
      epoch: {
        schemaVersion: 115,
        accountEpoch: 4,
        generation: 4,
        principal: "userA",
        updatedAt: 500,
      },
    });
  });

  test("sign-out purge advances epoch without waiting on a hung holder lock", async () => {
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore({
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    });
    const auth = createTestAuth("userA");

    const blockerAbort = new AbortController();
    void locks.request(
      "codecast-sqlite-lock:v115:a1:g1",
      blockerAbort.signal,
      () => new Promise<void>(() => {}),
    );

    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: () => {
        throw new Error("Should not spawn worker for held lock");
      },
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      const start = Date.now();
      await client.purgeLocalCache({ reason: "sign-out" });
      expect(Date.now() - start).toBeLessThan(200);
      expect(epochStore.read()).toMatchObject({
        schemaVersion: 115,
        accountEpoch: 2,
        generation: 1,
        principal: null,
      });
    } finally {
      blockerAbort.abort();
      client.close();
    }
  });

  test("when OPFS is missing, cache stays in memory and journal stays in IndexedDB", async () => {
    await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
    const auth = createTestAuth("userA");
    let spawned = 0;
    const journal: JournalBridge = {
      enqueueDispatch: async (entry) => {
        await dexie.dispatchOutbox.put({ ...entry, accountId: "userA" });
      },
      removeDispatch: async (id) => {
        await dexie.dispatchOutbox.delete(id);
      },
      loadOutbox: async () => dexie.dispatchOutbox.toArray(),
      outboxAccountId: () => "userA",
      persistPendingMessageChanges: () => {},
      loadJournalKeys: async (keys) => {
        const wanted = keys ? new Set(keys) : null;
        if (!wanted || wanted.has("pending")) {
          const rows = await dexie.pendingEntries.toArray();
          if (rows.length > 0) {
            return {
              pending: Object.fromEntries(
                rows.map(({ key, value }) => [key, value]),
              ),
            };
          }
        }
        return {};
      },
      writePendingEntries: async (patches, pending) => {
        if (!patches.some(({ path }) => path[0] === "pending")) return;
        const puts = Object.entries(pending ?? {}).map(([key, value]) => ({
          key,
          value,
        }));
        if (puts.length) await dexie.pendingEntries.bulkPut(puts);
      },
      purgeJournal: async () => {
        await dexie.pendingEntries.clear();
        await dexie.dispatchOutbox.clear();
      },
    };
    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore: createFakeEpochStore(),
      locks: null,
      channelTransport: null,
      spawnWorker: () => {
        spawned++;
        throw new Error("No worker expected when OPFS is missing");
      },
      opfsSupported: () => false,
      journal,
    });

    try {
      expect(client.isMemoryFallback()).toBe(true);
      expect(spawned).toBe(0);

      const sid = "f".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      client.writePatches([patch("sessions"), patch("pending")], {
        sessions: { [sid]: row },
        pending: { [`sessions:${sid}`]: { type: "exclude" } },
      });
      client.writeConversationMessages(
        "conv-mem",
        [{ _id: "m1", timestamp: 10 }],
        {
          hasMoreAbove: false,
        },
      );
      await client.enqueueDispatch({
        id: "outbox-1",
        action: "sendMessage",
        args: ["conv-mem", "hi"],
        ts: 1,
        accountId: "userA",
      });
      await client.flushPersistence();

      expect(await client.loadCache(["sessions", "pending"])).toEqual({
        sessions: { [sid]: row },
        pending: { [`sessions:${sid}`]: { type: "exclude" } },
      });
      expect(await client.loadConversationMessages("conv-mem")).toMatchObject({
        messages: [{ _id: "m1", timestamp: 10 }],
      });
      expect(await dexie.pendingEntries.get(`sessions:${sid}`)).toEqual({
        key: `sessions:${sid}`,
        value: { type: "exclude" },
      });
      expect(await client.loadOutbox()).toHaveLength(1);
    } finally {
      client.close();
      dexie.close();
    }
  });

  test("worker reporting OPFS missing falls back to memory cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-opfs-fallback-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport, {
      failOpfs: () => true,
    });
    const reasons: string[] = [];

    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
      onFallbackToMemory: (reason) => reasons.push(reason),
    });

    try {
      expect(await client.loadCache(["sessions"])).toBeNull();
      await waitUntil(
        () => client.isMemoryFallback(),
        1000,
        "OPFS missing triggers memory fallback",
      );
      expect(reasons.length).toBeGreaterThan(0);

      const sid = "1".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      client.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await client.flushPersistence();
      expect(await client.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
    } finally {
      client.close();
    }
  });
});
