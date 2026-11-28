import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { withCacheEvictions } from "../../cache-eviction";
import {
  _resetSnapshotLedger,
  hasSnapshotDrops,
  noteSnapshotSync,
} from "../../idb-collection-diff";
import { createLazySqliteStorage } from "../storage-bindings";
import { cleanupStaleEpochDirectories, openPoolOnce } from "./driver";
import {
  compareEpochOrder,
  epochChannelName,
  epochId,
  type CacheEpoch,
  type LockAdapter,
  type WorkerSpawner,
} from "./protocol";
import { dispatchWorkerMessage } from "./worker";
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
const hadWindow = "window" in globalThis;

afterEach(() => {
  _resetSnapshotLedger();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SQLite cache write direction and review fixes", () => {
  test("H1: openPoolOnce sets forceReinitIfPreviouslyFailed and unpauses paused VFS before opening DB", async () => {
    const events: string[] = [];
    let capturedOpts: Record<string, unknown> | null = null;
    let paused = true;

    const fakeSqlite = {
      async installOpfsSAHPoolVfs(opts: Record<string, unknown>) {
        capturedOpts = opts;
        events.push("install");
        return {
          isPaused: () => paused,
          async unpauseVfs() {
            paused = false;
            events.push("unpause");
          },
          pauseVfs() {
            paused = true;
          },
          async removeVfs() {},
          OpfsSAHPoolDb: class {
            constructor() {
              events.push(paused ? "open-while-paused" : "open");
            }
            exec() {}
            close() {}
          },
        };
      },
    } as unknown as Sqlite3Static;

    const opened = await openPoolOnce(fakeSqlite, {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    });
    expect(capturedOpts).toMatchObject({
      preserveOnInitFailure: true,
      forceReinitIfPreviouslyFailed: true,
    });
    expect(events).toEqual(["install", "unpause", "open"]);
    await opened.close();
  });

  test("H2: external lock loss clears knownWorkerId, sends discover, and reacquires without holder-hung", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-loss-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    const { spawner } = createDiskWorkerSpawner(dir, channelTransport);

    let releaseExternal!: () => void;
    let lockAcquisitionCount = 0;
    const locks: LockAdapter = {
      request(_name, _signal, onAcquired) {
        lockAcquisitionCount++;
        const first = lockAcquisitionCount === 1;
        return Promise.resolve()
          .then(() => {
            const held = onAcquired();
            if (first) {
              return new Promise<void>((resolve) => {
                releaseExternal = resolve;
              });
            }
            return held;
          })
          .then(() => undefined);
      },
    };

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
      const sid = "a".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      client.writePatches([patch("sessions")], { sessions: { [sid]: row } });
      await client.flushPersistence();

      await waitUntil(() => client.holdsLock(), 1000, "initial lock");
      releaseExternal();
      await waitUntil(
        () => lockAcquisitionCount >= 2 && client.holdsLock(),
        1000,
        "lock reacquired after external loss",
      );

      expect(await client.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
      expect(client.currentEpoch()?.generation).toBe(1);
    } finally {
      client.close();
    }
  });

  test("H3: unified buffer flushes rows, meta, transcript, and syncMeta last in one worker transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-single-tx-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");
    let activeDb: Database | null = null;
    const sentOps: string[] = [];

    const { spawner: rawSpawner } = createDiskWorkerSpawner(
      dir,
      channelTransport,
      {
        beforeOpen: (db) => {
          activeDb = db;
        },
      },
    );
    const spawner: WorkerSpawner = (ep, onMsg, onErr) => {
      const inner = rawSpawner(ep, onMsg, onErr);
      return {
        postMessage(msg: any) {
          if (msg?.type === "request") sentOps.push(msg.op);
          inner.postMessage(msg);
        },
        terminate: () => inner.terminate(),
      };
    };

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
      await client.loadCache(["sessions"]);
      sentOps.length = 0;

      const s1 = "1".repeat(32);
      const r1 = { _id: s1, updated_at: Date.now() };
      client.writePatches([patch("sessions"), patch("syncMeta")], {
        sessions: { [s1]: r1 },
        syncMeta: { cursor: 10 },
      });
      client.writeConversationMessages("c1", [{ _id: "m1", timestamp: 50 }], {
        hasMoreAbove: false,
      });
      await client.flushPersistence();

      expect(sentOps).toEqual(["flushBatch"]);
      expect(await client.loadCache(["sessions", "syncMeta"])).toEqual({
        sessions: { [s1]: r1 },
        syncMeta: { cursor: 10 },
      });

      activeDb!.exec(
        "CREATE TRIGGER fail_msg BEFORE INSERT ON message_rows BEGIN SELECT RAISE(ABORT, 'msg fail'); END",
      );
      const s2 = "2".repeat(32);
      client.writePatches([patch("sessions"), patch("syncMeta")], {
        sessions: { [s1]: r1, [s2]: { _id: s2, updated_at: Date.now() } },
        syncMeta: { cursor: 99 },
      });
      client.writeConversationMessages("c2", [{ _id: "m2", timestamp: 60 }], {
        hasMoreAbove: false,
      });
      await client.flushPersistence();

      expect(await client.loadCache(["syncMeta"])).toBeNull();
    } finally {
      client.close();
    }
  });

  test("H4: failed write preserves snapshotDrops and epoch rotation resets shadow state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-shadow-reset-"));
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
      const keepId = "a".repeat(32);
      const dropId = "b".repeat(32);
      const keepRow = { _id: keepId, updated_at: 100 };
      const dropRow = { _id: dropId, updated_at: 100 };

      client.writePatches([patch("sessions"), patch("liveInboxIdList")], {
        sessions: { [keepId]: keepRow, [dropId]: dropRow },
        liveInboxIdList: [keepId, dropId],
      });
      await client.flushPersistence();

      activeDb!.exec("PRAGMA query_only = ON");
      noteSnapshotSync("sessions", [keepId], [dropId]);
      client.writePatches([patch("sessions")], {
        sessions: { [keepId]: keepRow },
      });
      await client.flushPersistence();

      expect(hasSnapshotDrops("sessions")).toBe(true);
      await waitUntil(
        () => (epochStore.read()?.generation ?? 0) >= 2,
        1000,
        "rotated to generation 2",
      );

      client.writePatches([patch("sessions"), patch("liveInboxIdList")], {
        sessions: { [keepId]: keepRow },
        liveInboxIdList: [keepId],
      });
      await client.flushPersistence();

      expect(hasSnapshotDrops("sessions")).toBe(false);
      expect(await client.loadCache(["sessions", "liveInboxIdList"])).toEqual({
        sessions: { [keepId]: keepRow },
        liveInboxIdList: [keepId],
      });
    } finally {
      client.close();
    }
  });

  test("M5: compareEpochOrder orders accountEpoch before generation before schemaVersion on rollback", async () => {
    const preRollback: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 3,
      principal: "userA",
      updatedAt: 1,
    };
    const rollback: CacheEpoch = {
      schemaVersion: 114,
      accountEpoch: 2,
      generation: 1,
      principal: "userA",
      updatedAt: 2,
    };
    expect(compareEpochOrder(rollback, preRollback)).toBeGreaterThan(0);

    const removed: string[] = [];
    await cleanupStaleEpochDirectories(rollback, {
      getHeldLocks: async () => new Set<string>(),
      getRoot: async () => ({
        async *entries() {
          yield ["codecast-sqlite-v115-a1-g3", {}];
          yield ["codecast-sqlite-v114-a2-g1", {}];
        },
        async removeEntry(name) {
          removed.push(name);
        },
      }),
    });
    expect(removed).toEqual(["codecast-sqlite-v115-a1-g3"]);

    const subEpochStore = createFakeEpochStore(rollback);
    const dir = mkdtempSync(join(tmpdir(), "sqlite-rollback-sub-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const conn = createWorkerConnection({
      clientId: "rollback-sub",
      auth: createTestAuth("userA"),
      schemaVersion: 114,
      epochStore: subEpochStore,
      locks: createFakeLockAdapter(),
      channelTransport,
      spawnWorker: createDiskWorkerSpawner(dir, channelTransport).spawner,
      workerTimeoutMs: 500,
      now: () => Date.now(),
      createId: () => "id",
      onOpfsMissing: () => {},
    });
    try {
      conn.ensureActiveEpoch("userA", true);
      expect(conn.currentEpoch()?.schemaVersion).toBe(114);
      subEpochStore.write(preRollback);
      await new Promise((r) => setTimeout(r, 15));
      expect(conn.currentEpoch()?.accountEpoch).toBe(2);
    } finally {
      conn.close();
    }
  });

  test("M6, M8, M9, L13: synchronous pagehide postMessage, principal isolation, no write retry, and unbind on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-sync-send-"));
    tempDirs.push(dir);
    const channelTransport = createFakeChannelTransport();
    const locks = createFakeLockAdapter();
    const epochStore = createFakeEpochStore();
    const auth = createTestAuth("userA");

    const listeners = new Map<string, Set<() => void>>();
    const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
    const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, fn: () => void) {
          let set = listeners.get(type);
          if (!set) listeners.set(type, (set = new Set()));
          set.add(fn);
        },
        removeEventListener(type: string, fn: () => void) {
          listeners.get(type)?.delete(fn);
        },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible" },
    });

    try {
      const postedSync: string[] = [];
      const { spawner: rawSpawner } = createDiskWorkerSpawner(
        dir,
        channelTransport,
      );
      const handles: Array<{ terminate(): void }> = [];
      const spawner: WorkerSpawner = (ep, onMsg, onErr) => {
        const inner = rawSpawner(ep, onMsg, onErr);
        handles.push(inner);
        return {
          postMessage(msg: any) {
            if (msg?.type === "request") postedSync.push(msg.op);
            inner.postMessage(msg);
          },
          terminate: () => inner.terminate(),
        };
      };

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

      await client.loadCache(["sessions"]);
      expect(client.holdsLock()).toBe(true);
      postedSync.length = 0;

      const s1 = "1".repeat(32);
      client.writePatches([patch("sessions")], {
        sessions: { [s1]: { _id: s1, updated_at: 100 } },
      });
      for (const fn of listeners.get("pagehide") ?? []) fn();
      expect(postedSync).toEqual(["flushBatch"]);

      client.writePatches([patch("sessions")], {
        sessions: { [s1]: { _id: s1, updated_at: 200 } },
      });
      auth.setPrincipal("userB");
      await client.flushPersistence();

      expect(listeners.get("pagehide")?.size ?? 0).toBeGreaterThan(0);
      client.close();
      expect(listeners.get("pagehide")?.size ?? 0).toBe(0);

      auth.setPrincipal("userA");
      const connDir = mkdtempSync(join(tmpdir(), "sqlite-no-write-retry-"));
      tempDirs.push(connDir);
      const peerTransport = createFakeChannelTransport();
      const connLocks = createFakeLockAdapter();
      const peerStore = createFakeEpochStore();
      const holder = createSqliteWorkerClient({
        auth: createTestAuth("userA"),
        schemaVersion: 115,
        epochStore: peerStore,
        locks: connLocks,
        channelTransport: peerTransport,
        spawnWorker: createDiskWorkerSpawner(connDir, peerTransport).spawner,
        opfsSupported: () => true,
        journal: createFakeJournal(),
        workerTimeoutMs: 500,
      });
      await holder.loadCache(["sessions"]);

      let droppedFirst = false;
      const intercepted: typeof peerTransport = {
        open(name, onMsg) {
          const ep = peerTransport.open(name, onMsg);
          return {
            post(data: any) {
              if (
                data?.type === "request" &&
                data.op === "flushBatch" &&
                !droppedFirst
              ) {
                droppedFirst = true;
                holder.close();
                return;
              }
              ep.post(data);
            },
            close: () => ep.close(),
          };
        },
      };

      let writeReplays = 0;
      const peerConn = createWorkerConnection({
        clientId: "peer-no-retry",
        auth: createTestAuth("userA"),
        schemaVersion: 115,
        epochStore: peerStore,
        locks: connLocks,
        channelTransport: intercepted,
        spawnWorker: (ep, onMsg, onErr) => {
          const h = createDiskWorkerSpawner(connDir, peerTransport).spawner(
            ep,
            onMsg,
            onErr,
          );
          return {
            postMessage(msg: any) {
              if (msg?.type === "request" && msg.op === "flushBatch") {
                writeReplays++;
              }
              h.postMessage(msg);
            },
            terminate: () => h.terminate(),
          };
        },
        workerTimeoutMs: 500,
        now: () => Date.now(),
        createId: () => crypto.randomUUID(),
        onOpfsMissing: () => {},
      });

      const ep = peerConn.ensureActiveEpoch("userA", true)!;
      await expect(
        peerConn.send(ep, "userA", "flushBatch", {
          patches: [patch("liveInboxIdList")],
          state: { liveInboxIdList: ["x"] },
        }),
      ).rejects.toMatchObject({ code: "closed" });
      expect(writeReplays).toBe(0);
      peerConn.close();
      holder.close();
    } finally {
      if (prevWinDesc) Object.defineProperty(globalThis, "window", prevWinDesc);
      else if (!hadWindow) Reflect.deleteProperty(globalThis, "window");
      if (prevDocDesc)
        Object.defineProperty(globalThis, "document", prevDocDesc);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("L10, L11, L12, L14: worker queue recovery, evictions on replace, lazy loader retry, archive restore check, and host payload validation", async () => {
    const processed: string[] = [];
    dispatchWorkerMessage(null, async () => {
      processed.push("bad");
    });
    dispatchWorkerMessage({}, async () => {
      processed.push("bad2");
    });
    dispatchWorkerMessage({ type: "ping" }, async () => {
      throw new Error("boom");
    });
    dispatchWorkerMessage({ type: "ping" }, async () => {
      processed.push("recovered");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(processed).toEqual(["recovered"]);

    const dir = mkdtempSync(join(tmpdir(), "sqlite-evict-replace-"));
    tempDirs.push(dir);
    const transport = createFakeChannelTransport();
    const auth = createTestAuth("userA");
    const journal = createFakeJournal();
    const client = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore: createFakeEpochStore(),
      locks: createFakeLockAdapter(),
      channelTransport: transport,
      spawnWorker: createDiskWorkerSpawner(dir, transport).spawner,
      opfsSupported: () => true,
      journal,
      workerTimeoutMs: 500,
    });
    try {
      const keepDoc = { _id: "d-keep", workspace: "team:1" };
      const evictDoc = { _id: "d-evict", workspace: "team:1" };
      client.writePatches([patch("docDetails")], {
        docDetails: { "d-keep": keepDoc, "d-evict": evictDoc },
      });
      await client.flushPersistence();

      withCacheEvictions(
        [{ key: "docDetails", id: "d-evict", observed: evictDoc }],
        () => {
          client.writePatches([patch("docDetails")], {
            docDetails: { "d-keep": keepDoc },
          });
        },
      );
      await client.flushPersistence();

      expect(await client.loadCache(["docDetails"])).toEqual({
        docDetails: { "d-keep": keepDoc, "d-evict": evictDoc },
      });
    } finally {
      client.close();
    }

    let loadCalls = 0;
    const calls: string[] = [];
    const lazy = createLazySqliteStorage(
      async () => {
        loadCalls++;
        if (loadCalls === 1) throw new Error("transient load fail");
        return {
          getSqliteCacheStorage: () =>
            ({
              writePatches: () => calls.push("writePatches"),
              flushPersistence: async () => {},
            }) as any,
        };
      },
      {
        outboxAccountId: () => "userA",
        persistPendingMessageChanges: () => {},
        setHydrating: () => {},
      },
    );
    const storage = lazy();
    storage.writePatches([patch("sessions")], { sessions: {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(loadCalls).toBe(1);
    await storage.flushPersistence();
    expect(loadCalls).toBe(2);
    expect(calls).toEqual(["writePatches"]);

    const memClient = createSqliteWorkerClient({
      auth,
      schemaVersion: 115,
      epochStore: createFakeEpochStore(),
      locks: null,
      channelTransport: null,
      spawnWorker: createDiskWorkerSpawner(dir, transport).spawner,
      opfsSupported: () => false,
      journal,
      workerTimeoutMs: 500,
    });
    try {
      memClient.writePatches([patch("docDetails")], {
        docDetails: {
          "doc-restored": { _id: "doc-restored" },
          "doc-archived": { _id: "doc-archived" },
        },
      });
      await memClient.enqueueDispatch({
        id: "restore-1",
        action: "restoreArchivedDoc",
        args: ["doc-restored"],
        ts: 200,
        accountId: "userA",
      });
      expect(
        await memClient.deleteInvalidatedDocDetails?.(
          ["doc-restored", "doc-archived"],
          () => true,
          { accountId: "userA", dispatchedAt: 100 },
        ),
      ).toEqual(["doc-archived"]);
    } finally {
      memClient.close();
    }

    const hostTransport = createFakeChannelTransport();
    const hostEpoch: CacheEpoch = {
      schemaVersion: 115,
      accountEpoch: 1,
      generation: 1,
      principal: "userA",
      updatedAt: 1,
    };
    const hostDb = new Database(":memory:");
    const host = createSqliteWorkerHost({
      workerId: "w-val",
      epoch: hostEpoch,
      channelTransport: hostTransport,
      openDatabase: async () => ({
        driver: {
          exec: (sql) => hostDb.exec(sql),
          prepare: <Row>(sql: string) => {
            const q = hostDb.query<Row, any[]>(sql);
            return {
              get: (...p: any[]) => q.get(...p) ?? null,
              all: (...p: any[]) => q.all(...p),
              run: (...p: any[]) => q.run(...p),
              finalize: () => q.finalize(),
            };
          },
          transaction: (b) => hostDb.transaction(b),
        },
        close: () => hostDb.close(),
      }),
      postToOwner: () => {},
    });
    expect(await host.start()).toBe(true);
    const badReplies: any[] = [];
    const peerEp = hostTransport.open(
      `${epochChannelName(hostEpoch)}:to:val-client`,
      (msg) => badReplies.push(msg),
    );
    const targetEp = hostTransport.open(
      `${epochChannelName(hostEpoch)}:to:w-val`,
      () => {},
    );
    targetEp.post({
      type: "request",
      id: "bad-drops",
      replyTo: "val-client",
      epochId: epochId(hostEpoch),
      principal: "userA",
      op: "flushBatch",
      payload: {
        patches: [{ op: "replace", path: ["sessions"], value: {} }],
        state: {},
        snapshotDrops: { sessions: [123] },
      },
    });
    targetEp.post({
      type: "request",
      id: "bad-path",
      replyTo: "val-client",
      epochId: epochId(hostEpoch),
      principal: "userA",
      op: "writePatches",
      payload: {
        patches: [{ op: "replace", path: "not-array", value: {} }],
        state: {},
      },
    });
    await waitUntil(
      () => badReplies.length === 2,
      1000,
      "two validation errors",
    );
    expect(badReplies.map((r) => r.code)).toEqual(["internal", "internal"]);
    peerEp.close();
    targetEp.close();
    await host.close();
  });
});
