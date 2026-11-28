import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSnapshotDrops,
  hasSnapshotDrops,
  noteSnapshotSync,
} from "../../idb-collection-diff";
import { _hydrating } from "../hydration";
import {
  cleanupStaleEpochDirectories,
  isOpfsContentionOrQuotaError,
  isOpfsMissingError,
} from "./driver";
import {
  addressedChannelName,
  compareEpochOrder,
  epochChannelName,
  epochId,
  epochLockName,
  parseEpochDirectoryName,
  type CacheEpoch,
  type ChannelTransport,
  type LockAdapter,
  type WorkerSpawner,
} from "./protocol";
import type { SqliteDriver } from "./schema";
import { createSqliteWorkerClient } from "./worker-client";
import { createWorkerConnection } from "./worker-connection";
import { createSqliteWorkerHost } from "./worker-host";
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

describe("SQLite cache worker hardening", () => {
  test("cleanupStaleEpochDirectories preserves held and newer epochs and deletes older unheld ones", async () => {
    const removed: string[] = [];
    const current: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 2,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    };
    const heldEpoch = { schemaVersion: 115, accountEpoch: 1, generation: 2 };
    const staleEpoch = { schemaVersion: 115, accountEpoch: 1, generation: 1 };
    const newerEpoch = { schemaVersion: 115, accountEpoch: 2, generation: 2 };
    const dirNames = [
      "codecast-sqlite-v115-a1-g1",
      "codecast-sqlite-v115-a1-g2",
      "codecast-sqlite-v115-a2-g1",
      "codecast-sqlite-v115-a2-g2",
      "other-unrelated-dir",
    ];
    await cleanupStaleEpochDirectories(current, {
      getHeldLocks: async () =>
        new Set([
          epochLockName({
            ...heldEpoch,
            principal: null,
            updatedAt: 0,
          }),
        ]),
      getRoot: async () => ({
        async *entries() {
          for (const name of dirNames) yield [name, {}];
        },
        async removeEntry(name) {
          removed.push(name);
        },
      }),
    });

    expect(removed).toEqual(["codecast-sqlite-v115-a1-g1"]);
    expect(parseEpochDirectoryName("codecast-sqlite-v115-a1-g1")).toEqual(
      staleEpoch,
    );
    expect(compareEpochOrder(newerEpoch, current)).toBeGreaterThan(0);
  });

  test("host.start returns false on openDatabase error", async () => {
    const transport = createFakeChannelTransport();
    const announcements: unknown[] = [];
    const host = createSqliteWorkerHost({
      workerId: "w-fail",
      epoch: {
        schemaVersion: 115,
        accountEpoch: 1,
        generation: 1,
        principal: "userA",
        updatedAt: 1,
      },
      channelTransport: transport,
      openDatabase: async () => {
        throw new Error("Missing required OPFS APIs.");
      },
      postToOwner: (msg) => announcements.push(msg),
    });

    expect(await host.start()).toBe(false);
    expect(
      announcements.some((m: any) => m.type === "worker-opfs-missing"),
    ).toBe(true);
  });

  test("abrupt worker terminate without worker-closing retries peer RPC on replacement holder without rotating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-abrupt-kill-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    const handles: Array<{ terminate(): void }> = [];
    let reqCount = 0;

    const base = createDiskWorkerSpawner(dir, channelTransport);

    const spawner: WorkerSpawner = (ep, onMsg, onErr) => {
      const inner = base.spawner(ep, onMsg, onErr);
      handles.push(inner);
      return inner;
    };

    const clientA = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 600,
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
      workerTimeoutMs: 600,
    });

    try {
      const sid = "f".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      clientA.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await clientA.flushPersistence();

      await waitUntil(() => clientA.holdsLock(), 1000, "clientA lock");
      expect(await clientB.loadCache(["sessions"])).toMatchObject({
        sessions: { [sid]: row },
      });

      const slowChannel: ChannelTransport = {
        open(name, onMsg) {
          const ep = channelTransport.open(name, onMsg);
          return {
            post(data: any) {
              if (data?.type === "request" && reqCount++ === 0) {
                setTimeout(() => {
                  handles[0]?.terminate();
                  clientA.close();
                }, 15);
                return;
              }
              ep.post(data);
            },
            close() {
              ep.close();
            },
          };
        },
      };

      const clientC = createSqliteWorkerClient({
        auth,
        schemaVersion: 115,
        epochStore,
        locks,
        channelTransport: slowChannel,
        spawnWorker: spawner,
        opfsSupported: () => true,
        journal: createFakeJournal(),
        workerTimeoutMs: 1200,
      });
      try {
        await clientC.loadCache(["sessions"]);
        const loaded = await clientC.loadCache(["sessions"]);
        expect(loaded).toMatchObject({ sessions: { [sid]: row } });
        expect(clientC.currentEpoch()?.generation).toBe(1);
      } finally {
        clientC.close();
      }
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  test("teardownEpoch terminates owned worker before releasing lock and classifies contention errors safely", async () => {
    const events: string[] = [];
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");

    expect(
      isOpfsContentionOrQuotaError(
        new DOMException("busy", "NoModificationAllowedError"),
      ),
    ).toBe(true);
    expect(
      isOpfsMissingError(
        new DOMException("OPFS SAH handle busy", "NoModificationAllowedError"),
      ),
    ).toBe(false);
    expect(
      isOpfsMissingError(new DOMException("full", "QuotaExceededError")),
    ).toBe(false);
    expect(isOpfsMissingError(new Error("Missing required OPFS APIs."))).toBe(
      true,
    );

    const locks: LockAdapter = {
      request(_name, _signal, onAcquired) {
        return Promise.resolve()
          .then(() => onAcquired())
          .finally(() => {
            events.push("lock-released");
          });
      },
    };
    const spawner: WorkerSpawner = (epoch, onMessage) => ({
      postMessage(msg: any) {
        if (msg.type === "init") {
          events.push("worker-init");
          onMessage({
            type: "worker-ready",
            workerId: "w-order",
            epochId: epochId(epoch),
            epoch,
          });
        }
      },
      terminate() {
        events.push("worker-terminated");
      },
    });

    const conn = createWorkerConnection({
      clientId: "c1",
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport,
      spawnWorker: spawner,
      workerTimeoutMs: 500,
      now: () => Date.now(),
      createId: () => "id-1",
      onOpfsMissing: () => {},
    });

    conn.ensureActiveEpoch("userA", true);
    await waitUntil(
      () => events.includes("worker-init"),
      1000,
      "worker initialized",
    );
    conn.close();
    await waitUntil(
      () => events.includes("lock-released"),
      1000,
      "lock released",
    );
    expect(events.indexOf("worker-terminated")).toBeLessThan(
      events.indexOf("lock-released"),
    );

    const dir = mkdtempSync(join(tmpdir(), "sqlite-contention-"));
    tempDirs.push(dir);
    let injectedOnce = false;
    const { spawner: contentionSpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
      {
        failOpenError: () => {
          if (!injectedOnce) {
            injectedOnce = true;
            return new DOMException(
              "OPFS handle locked",
              "NoModificationAllowedError",
            );
          }
          return null;
        },
      },
    );
    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: contentionSpawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });
    try {
      expect(await client.loadCache(["sessions"])).toBeNull();
      expect(client.isMemoryFallback()).toBe(false);
      expect(client.currentEpoch()?.generation).toBeGreaterThanOrEqual(2);
    } finally {
      client.close();
    }
  });

  test("host validates requests, rejects forged ops and wrong principals, caps peerOutboxes, and finalizes statements", async () => {
    const transport = createFakeChannelTransport();
    const epoch: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    };
    const eId = epochId(epoch);
    const baseChannel = epochChannelName(epoch);
    const workerId = "w-sec";
    let finalized = false;
    let openChannels = 0;

    const trackedTransport: ChannelTransport = {
      open(name, onMessage) {
        openChannels++;
        const ep = transport.open(name, onMessage);
        return {
          post: (data) => ep.post(data),
          close: () => {
            openChannels--;
            ep.close();
          },
        };
      },
    };

    const { Database } = await import("bun:sqlite");
    const rawDb = new Database(":memory:");
    const driver: SqliteDriver = {
      exec: (sql) => rawDb.exec(sql),
      prepare<Row>(sql: string) {
        const q = rawDb.query<Row, any[]>(sql);
        const trackMeta = sql.includes("SELECT value FROM meta WHERE key = ?");
        return {
          get: (...params) => q.get(...params) ?? null,
          all: (...params) => q.all(...params),
          run: (...params) => q.run(...params),
          finalize() {
            if (trackMeta) finalized = true;
            q.finalize();
          },
        };
      },
      transaction: (body) => rawDb.transaction(body),
    };

    const host = createSqliteWorkerHost({
      workerId,
      epoch,
      channelTransport: trackedTransport,
      openDatabase: async () => ({
        driver,
        close: () => rawDb.close(),
      }),
      postToOwner: () => {},
    });

    expect(await host.start()).toBe(true);

    const replies: any[] = [];
    const peerReplyChannel = trackedTransport.open(
      addressedChannelName(baseChannel, "attacker"),
      (data) => replies.push(data),
    );
    const workerInbox = trackedTransport.open(
      addressedChannelName(baseChannel, workerId),
      () => {},
    );

    workerInbox.post({
      type: "request",
      id: "r0",
      replyTo: "attacker",
      epochId: "v115-a0-g0",
      principal: "userA",
      op: "ping",
      payload: {},
    });
    workerInbox.post({
      type: "request",
      id: "r1",
      replyTo: "attacker",
      epochId: eId,
      principal: "userB",
      op: "purgeLocalCache",
      payload: {},
    });
    workerInbox.post({
      type: "request",
      id: "r2",
      replyTo: "attacker",
      epochId: eId,
      principal: "userA",
      op: "bogusOp",
      payload: {},
    });
    workerInbox.post({
      type: "request",
      id: "r3",
      replyTo: "attacker",
      epochId: eId,
      principal: "userA",
      op: "loadConversationMessages",
      payload: { bad: 123 },
    });

    await waitUntil(() => replies.length === 4, 1000, "four error replies");
    expect(replies.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(replies.map((r) => r.code)).toEqual([
      "epoch-mismatch",
      "internal",
      "internal",
      "internal",
    ]);

    for (let i = 0; i < 20; i++) {
      workerInbox.post({
        type: "request",
        id: `cap-${i}`,
        replyTo: `peer-${i}`,
        epochId: eId,
        principal: "userA",
        op: "ping",
        payload: {},
      });
    }
    await waitUntil(() => openChannels <= 21, 1000, "peer outboxes capped");
    expect(openChannels).toBeLessThanOrEqual(21);

    peerReplyChannel.close();
    workerInbox.close();
    await host.close();
    expect(finalized).toBe(true);
  });

  test("channel worker-ready cannot mark ownedWorkerReady and postMessage throw rejects immediately", async () => {
    const transport = createFakeChannelTransport();
    const epoch: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    };
    const epochStore = createFakeEpochStore(epoch);
    const auth = createTestAuth("userA");
    const locks = createFakeLockAdapter();
    let postedToOwnerWorker = 0;

    const conn = createWorkerConnection({
      clientId: "owner-client",
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport: transport,
      spawnWorker: () => ({
        postMessage(msg: any) {
          if (msg.type === "request") postedToOwnerWorker++;
        },
        terminate() {},
      }),
      workerTimeoutMs: 60,
      now: () => Date.now(),
      createId: () => "req-spoof",
      onOpfsMissing: () => {},
    });

    const active = conn.ensureActiveEpoch("userA", true)!;
    await waitUntil(() => conn.holdsLock(), 1000, "owner holds lock");

    const spoofer = transport.open(epochChannelName(active), () => {});
    spoofer.post({
      type: "worker-ready",
      workerId: "fake-worker",
      epochId: epochId(active),
      epoch: active,
    });

    await expect(conn.send(active, "userA", "ping", {})).rejects.toMatchObject({
      code: "timeout",
    });
    expect(postedToOwnerWorker).toBe(0);
    spoofer.close();
    conn.close();

    const startTime = Date.now();
    const throwConn = createWorkerConnection({
      clientId: "throw-client",
      auth,
      schemaVersion: 115,
      epochStore: createFakeEpochStore(epoch),
      locks: createFakeLockAdapter(),
      channelTransport: transport,
      spawnWorker: (ep, onMsg) => ({
        postMessage(msg: any) {
          if (msg.type === "init") {
            queueMicrotask(() =>
              onMsg({
                type: "worker-ready",
                workerId: "w-throw",
                epochId: epochId(ep),
                epoch: ep,
              }),
            );
            return;
          }
          throw new Error("worker postMessage broken");
        },
        terminate() {},
      }),
      workerTimeoutMs: 5000,
      now: () => Date.now(),
      createId: () => "req-throw",
      onOpfsMissing: () => {},
    });
    const epThrow = throwConn.ensureActiveEpoch("userA", true)!;
    await expect(
      throwConn.send(epThrow, "userA", "ping", {}),
    ).rejects.toMatchObject({
      code: "closed",
    });
    expect(Date.now() - startTime).toBeLessThan(500);
    throwConn.close();
  });

  test("coalesces transcript and meta writes, preserves snapshotDrops on failed write, and falls back when epochStore.write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-coalesce-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    const { spawner: rawSpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
    );
    let rpcCount = 0;
    const spawner: WorkerSpawner = (ep, onMsg, onErr) => {
      const inner = rawSpawner(ep, onMsg, onErr);
      return {
        postMessage(msg: any) {
          if (msg?.type === "request") rpcCount++;
          inner.postMessage(msg);
        },
        terminate: () => inner.terminate(),
      };
    };

    const countedTransport: ChannelTransport = {
      open(name, onMsg) {
        const ep = channelTransport.open(name, onMsg);
        return {
          post(data: any) {
            if (data?.type === "request") rpcCount++;
            ep.post(data);
          },
          close: () => ep.close(),
        };
      },
    };

    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore,
      locks,
      channelTransport: countedTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });

    try {
      expect(await client.loadCache(["sessions"])).toBeNull();
      client.setHydrating(true);
      expect(_hydrating).toBe(true);
      client.setHydrating(false);
      expect(_hydrating).toBe(false);

      const rpcsBeforeMessages = rpcCount;
      client.writeConversationMessages("c1", [{ _id: "m1", timestamp: 1 }], {
        hasMoreAbove: false,
      });
      client.writeConversationMessages("c1", [{ _id: "m2", timestamp: 2 }], {
        hasMoreAbove: false,
      });
      expect(rpcCount).toBe(rpcsBeforeMessages);
      expect(await client.loadConversationMessages("c1")).toMatchObject({
        messages: [{ _id: "m2", timestamp: 2 }],
      });
      await client.flushPersistence();
      expect(rpcCount).toBe(rpcsBeforeMessages + 1);

      const rpcsBeforeMeta = rpcCount;
      for (let i = 0; i < 4; i++) {
        client.writePatches(
          [{ op: "replace", path: ["liveInboxIdList"], value: [`s-${i}`] }],
          { liveInboxIdList: [`s-${i}`] },
        );
      }
      expect(rpcCount).toBe(rpcsBeforeMeta);
      await client.flushPersistence();
      expect(rpcCount).toBe(rpcsBeforeMeta + 1);

      noteSnapshotSync("sessions", [], ["s1"]);
      expect(hasSnapshotDrops("sessions")).toBe(true);
      client.writePatches([patch("sessions")], { sessions: {} });
      await client.flushPersistence();
      expect(hasSnapshotDrops("sessions")).toBe(false);

      client.writePatches([patch("docDetails")], {
        docDetails: {
          d1: { _id: "d1", workspace: "team:1" },
          d2: { _id: "d2", workspace: "team:1" },
        },
      });
      await client.flushPersistence();
      expect(
        await client.deleteInvalidatedDocDetails?.(["d1"], () => true),
      ).toEqual(["d1"]);
      expect(await client.loadCache(["docDetails"])).toEqual({
        docDetails: { d2: { _id: "d2", workspace: "team:1" } },
      });
    } finally {
      client.close();
    }

    const failingEpochStore = createFakeEpochStore();
    const { spawner: hangSpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
      { hangRpc: () => true },
    );
    const failDropClient = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore: failingEpochStore,
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: hangSpawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 50,
    });
    try {
      await failDropClient.loadCache(["sessions"]);
      noteSnapshotSync("sessions", [], ["s2"]);
      failDropClient.writePatches([patch("sessions")], { sessions: {} });
      await failDropClient.flushPersistence();
      expect(hasSnapshotDrops("sessions")).toBe(true);
      clearSnapshotDrops("sessions");
    } finally {
      failDropClient.close();
    }

    const newerEpoch: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 2,
      principal: "userA",
      updatedAt: 2,
    };
    const subEpochStore = createFakeEpochStore(newerEpoch);
    const subConn = createWorkerConnection({
      clientId: "sub-client",
      auth,
      schemaVersion: 115,
      epochStore: subEpochStore,
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: createDiskWorkerSpawner(dir, channelTransport).spawner,
      workerTimeoutMs: 500,
      now: () => Date.now(),
      createId: () => "sub-id",
      onOpfsMissing: () => {},
    });
    try {
      subConn.ensureActiveEpoch("userA", true);
      expect(subConn.currentEpoch()?.generation).toBe(2);
      subEpochStore.write({
        ...newerEpoch,
        generation: 1,
        updatedAt: 1,
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(subConn.currentEpoch()?.generation).toBe(2);
    } finally {
      subConn.close();
    }

    const fallbackClient = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore: {
        read: () => null,
        write: () => false,
      },
      locks,
      channelTransport,
      spawnWorker: spawner,
      opfsSupported: () => true,
      journal: createFakeJournal(),
      workerTimeoutMs: 500,
    });
    try {
      expect(await fallbackClient.loadCache(["sessions"])).toBeNull();
      expect(fallbackClient.isMemoryFallback()).toBe(true);
    } finally {
      fallbackClient.close();
    }
  });
});
