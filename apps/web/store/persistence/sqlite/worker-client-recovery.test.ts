import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetSnapshotLedger } from "../../idb-collection-diff";
import type {
  CacheEpoch,
  EpochStore,
  LockAdapter,
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

function releasableLocks(): {
  locks: LockAdapter;
  acquisitions: () => number;
  releaseFirst: () => void;
} {
  let count = 0;
  let releaseFirst = () => {};
  return {
    acquisitions: () => count,
    releaseFirst: () => releaseFirst(),
    locks: {
      request(_name, signal, onAcquired) {
        if (signal.aborted) return Promise.resolve();
        count++;
        const first = count === 1;
        return Promise.resolve()
          .then(() => {
            const held = onAcquired();
            if (!first) return held;
            return new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          })
          .then(() => undefined);
      },
    },
  };
}

function swallowFirstRequest(
  inner: WorkerSpawner,
  op: string,
): {
  spawner: WorkerSpawner;
  swallowed: () => boolean;
} {
  let swallowed = false;
  return {
    swallowed: () => swallowed,
    spawner: (epoch, onMessage, onError) => {
      const worker = inner(epoch, onMessage, onError);
      return {
        postMessage(message: unknown) {
          const request = message as { type?: string; op?: string };
          if (!swallowed && request?.type === "request" && request.op === op) {
            swallowed = true;
            return;
          }
          worker.postMessage(message);
        },
        terminate: () => worker.terminate(),
      };
    },
  };
}

describe("SQLite worker client recovery", () => {
  test("a flush lost to lock loss starts the next generation and holds the sync cursor", async () => {
    const dir = tempDir("sqlite-lost-flush-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const { locks, acquisitions, releaseFirst } = releasableLocks();
    const disk = createDiskWorkerSpawner(dir, channelTransport);
    const { spawner, swallowed } = swallowFirstRequest(
      disk.spawner,
      "flushBatch",
    );
    const client = createSqliteWorkerClient({
      auth: createTestAuth("userA"),
      schemaVersion: 116,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    });

    try {
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
      const s1 = "1".repeat(32);
      const s2 = "2".repeat(32);
      const r1 = { _id: s1, updated_at: Date.now() };
      const r2 = { _id: s2, updated_at: Date.now() };

      client.writePatches([patch("sessions", s1), patch("syncMeta")], {
        sessions: { [s1]: r1 },
        syncMeta: { cursor: 1 },
      });
      const lost = client.flushPersistence();
      await waitUntil(swallowed, 1000, "first flush reaches the worker");
      releaseFirst();
      await lost;
      await waitUntil(
        () => acquisitions() >= 2 && client.holdsLock(),
        1000,
        "lock taken again",
      );
      expect(await client.loadCache(["sessions"])).toBeNull();
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();

      client.writePatches([patch("sessions", s2), patch("syncMeta")], {
        sessions: { [s1]: r1, [s2]: r2 },
        syncMeta: { cursor: 2 },
      });
      await client.flushPersistence();

      expect(epochStore.read()?.generation).toBe(2);
      expect(client.currentEpoch()?.generation).toBe(2);
      expect(await client.loadCache(["sessions", "syncMeta"])).toEqual({
        sessions: { [s2]: r2 },
      });
    } finally {
      client.close();
    }
  });

  test("only a load that reads the sync cursor lets the window write it", async () => {
    const dir = tempDir("sqlite-cursor-bind-");
    const channelTransport = createFakeChannelTransport();
    const client = createSqliteWorkerClient({
      auth: createTestAuth("userA"),
      schemaVersion: 116,
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: createDiskWorkerSpawner(dir, channelTransport).spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    });

    try {
      expect(await client.loadCache(["sessions"])).toBeNull();
      client.writePatches([patch("syncMeta")], { syncMeta: { cursor: 1 } });
      await client.flushPersistence();
      expect(await client.loadCache(["syncMeta"])).toBeNull();

      client.writePatches([patch("syncMeta")], { syncMeta: { cursor: 2 } });
      await client.flushPersistence();
      expect(await client.loadCache(["syncMeta"])).toEqual({
        syncMeta: { cursor: 2 },
      });
    } finally {
      client.close();
    }
  });

  test("a doc detail delete lost to lock loss starts the next generation", async () => {
    const dir = tempDir("sqlite-lost-delete-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const { locks, acquisitions, releaseFirst } = releasableLocks();
    const disk = createDiskWorkerSpawner(dir, channelTransport);
    const { spawner, swallowed } = swallowFirstRequest(
      disk.spawner,
      "deleteDocDetails",
    );
    const client = createSqliteWorkerClient({
      auth: createTestAuth("userA"),
      schemaVersion: 116,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    });

    try {
      await client.loadCache(["docDetails"]);
      const doc = { _id: "doc-revoked", workspace: "team:t", content: "Body" };
      client.writePatches([patch("docDetails", doc._id)], {
        docDetails: { [doc._id]: doc },
      });
      await client.flushPersistence();
      expect(await client.loadCache(["docDetails"])).toEqual({
        docDetails: { [doc._id]: doc },
      });

      const deleting = client.deleteInvalidatedDocDetails?.(
        [doc._id],
        () => true,
      );
      await waitUntil(swallowed, 1000, "delete reaches the worker");
      releaseFirst();
      expect(await deleting).toEqual([]);
      await waitUntil(
        () => acquisitions() >= 2 && client.holdsLock(),
        1000,
        "lock taken again",
      );

      expect(epochStore.read()?.generation).toBe(2);
      expect(await client.loadCache(["docDetails"])).toBeNull();
    } finally {
      client.close();
    }
  });

  test("an idle owner that closes lets a peer write finish on the same file", async () => {
    const dir = tempDir("sqlite-owner-close-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const locks = createFakeLockAdapter();
    const auth = createTestAuth("userA");
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport);
    const options = {
      auth,
      schemaVersion: 116,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    };
    const owner = createSqliteWorkerClient(options);
    const peer = createSqliteWorkerClient(options);

    try {
      await owner.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => owner.holdsLock(), 1000, "owner holds the lock");
      expect(await peer.loadCache(["sessions", "syncMeta"])).toBeNull();
      const sid = "p".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      peer.writePatches([patch("sessions", sid), patch("syncMeta")], {
        sessions: { [sid]: row },
        syncMeta: { cursor: 7 },
      });
      const writing = peer.flushPersistence();
      await new Promise((resolve) => setTimeout(resolve, 0));
      owner.close();
      await writing;
      await waitUntil(() => peer.holdsLock(), 1000, "peer takes the lock");

      expect(epochStore.read()?.generation).toBe(1);
      expect(await peer.loadCache(["sessions", "syncMeta"])).toEqual({
        sessions: { [sid]: row },
        syncMeta: { cursor: 7 },
      });
    } finally {
      owner.close();
      peer.close();
    }
  });

  test("a flush cut off by an account switch writes nothing into the next account's memory cache", async () => {
    const dir = tempDir("sqlite-switch-fallback-");
    const channelTransport = createFakeChannelTransport();
    const auth = createTestAuth("userA");
    const disk = createDiskWorkerSpawner(dir, channelTransport);
    let reportToOwner: ((data: unknown) => void) | null = null;
    let heldFlush: { epochId: string } | null = null;
    const spawner: WorkerSpawner = (epoch, onMessage, onError) => {
      const worker = disk.spawner(epoch, onMessage, onError);
      reportToOwner = onMessage;
      return {
        postMessage(message: unknown) {
          const request = message as {
            type?: string;
            op?: string;
            epochId: string;
          };
          if (request?.type === "request" && request.op === "flushBatch") {
            heldFlush = request;
            return;
          }
          worker.postMessage(message);
        },
        terminate: () => worker.terminate(),
      };
    };
    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 116,
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    });

    try {
      await client.loadCache(["sessions"]);
      const rows = [{ _id: "m1", timestamp: 1, content: "Account A text" }];
      client.writeConversationMessages("conversation", rows, {
        hasMoreAbove: false,
      });
      const flushing = client.flushPersistence();
      await waitUntil(() => heldFlush !== null, 1000, "flush dispatched");

      auth.setPrincipal("userB");
      reportToOwner!({
        type: "worker-opfs-missing",
        epochId: heldFlush!.epochId,
        workerId: "w-1",
        error: "Missing required OPFS APIs.",
      });
      await flushing;

      expect(client.isMemoryFallback()).toBe(true);
      expect(await client.loadConversationMessages("conversation")).toBeNull();
    } finally {
      client.close();
    }
  });

  test("a doc detail deleted while its write is buffered stays deleted", async () => {
    const dir = tempDir("sqlite-doc-delete-");
    const channelTransport = createFakeChannelTransport();
    const client = createSqliteWorkerClient({
      auth: createTestAuth("userA"),
      schemaVersion: 116,
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: createDiskWorkerSpawner(dir, channelTransport).spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    });

    try {
      await client.loadCache(["docDetails"]);
      const kept = { _id: "doc-kept", workspace: "team:t", content: "Kept" };
      const gone = { _id: "doc-gone", workspace: "team:t", content: "Gone" };
      client.writePatches([patch("docDetails", "doc-gone")], {
        docDetails: { [gone._id]: gone },
      });
      expect(
        await client.deleteInvalidatedDocDetails?.(["doc-gone"], () => true),
      ).toEqual(["doc-gone"]);
      client.writePatches([patch("docDetails")], {
        docDetails: { [kept._id]: kept, [gone._id]: gone },
      });
      expect(
        await client.deleteInvalidatedDocDetails?.(["doc-gone"], () => true),
      ).toEqual(["doc-gone"]);
      await client.flushPersistence();

      expect(await client.loadCache(["docDetails"])).toEqual({
        docDetails: { [kept._id]: kept },
      });
    } finally {
      client.close();
    }
  });

  test("a rotation saves the next generation when the epoch record is missing", async () => {
    const dir = tempDir("sqlite-missing-epoch-");
    const channelTransport = createFakeChannelTransport();
    const stored = createFakeEpochStore();
    let hideNextRead = false;
    const epochStore: EpochStore = {
      read() {
        if (hideNextRead) {
          hideNextRead = false;
          return null;
        }
        return stored.read();
      },
      write: (epoch: CacheEpoch) => stored.write(epoch),
      subscribe: stored.subscribe,
    };
    let activeDb: Database | null = null;
    const client = createSqliteWorkerClient({
      auth: createTestAuth("userA"),
      schemaVersion: 116,
      epochStore,
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
        beforeOpen: (db) => {
          activeDb = db;
        },
      }).spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 2000,
    });

    try {
      await client.loadCache(["sessions"]);
      expect(stored.read()?.generation).toBe(1);
      activeDb!.exec("PRAGMA query_only = ON");
      const sid = "a".repeat(32);
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
      });
      const flushing = client.flushPersistence();
      hideNextRead = true;
      await flushing;
      await waitUntil(
        () => client.currentEpoch()?.generation === 2 && client.holdsLock(),
        1000,
        "rotated to generation 2",
      );

      expect(stored.read()?.generation).toBe(2);
    } finally {
      client.close();
    }
  });
});
