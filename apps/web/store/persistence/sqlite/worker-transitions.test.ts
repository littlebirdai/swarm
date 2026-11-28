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

const BLOCKED_OWNER = (principal: string) => `
  CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS collection_rows (collection TEXT NOT NULL, id TEXT NOT NULL, timestamp REAL, value TEXT NOT NULL, PRIMARY KEY (collection, id));
  CREATE TABLE IF NOT EXISTS conversation_meta (id TEXT NOT NULL PRIMARY KEY, pagination TEXT, latest_timestamp REAL, user_messages TEXT, touched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS message_rows (conversation_id TEXT NOT NULL, message_key TEXT NOT NULL, position REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (conversation_id, message_key));
  INSERT OR IGNORE INTO migrations VALUES (1);
  INSERT OR REPLACE INTO meta VALUES ('cacheOwner', '${JSON.stringify({ principal, at: 1, reason: "write-failed", blocked: true })}');
`;

type Tap = {
  dropRequest?: (epoch: CacheEpoch, op: string) => boolean;
  failAnswers?: (epoch: CacheEpoch) => boolean;
  batchFailures?: number;
  holdReply?: (epoch: CacheEpoch, type: string) => boolean;
  events: string[];
};

function tapSpawner(inner: WorkerSpawner, tap: Tap): WorkerSpawner {
  return (epoch, onMessage, onError) => {
    const held: unknown[] = [];
    const worker = inner(
      epoch,
      (data) => {
        const type = (data as { type?: string })?.type ?? "";
        if (tap.holdReply?.(epoch, type)) return;
        if (type === "response") tap.events.push(`g${epoch.generation}:answer`);
        if (type === "response" && tap.failAnswers?.(epoch)) {
          held.push({
            ...(data as object),
            ok: false,
            code: "write-failed",
            error: "Injected write failure",
          });
          if (held.length >= (tap.batchFailures ?? 1))
            for (const answer of held.splice(0)) onMessage(answer);
          return;
        }
        onMessage(data);
      },
      onError,
    );
    return {
      postMessage(message: unknown) {
        const command = message as { type?: string; op?: string };
        if (command?.type === "close")
          tap.events.push(`g${epoch.generation}:close`);
        if (
          command?.type === "request" &&
          tap.dropRequest?.(epoch, command.op ?? "")
        )
          return;
        worker.postMessage(message);
      },
      terminate() {
        tap.events.push(`g${epoch.generation}:terminate`);
        worker.terminate();
      },
    };
  };
}

function storeWithoutEvents(): EpochStore {
  const stored = createFakeEpochStore();
  return { read: () => stored.read(), write: (epoch) => stored.write(epoch) };
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

describe("SQLite epoch transitions", () => {
  test("a buffer from before a purge in another tab is not written after it", async () => {
    const dir = tempDir("sqlite-purge-buffer-");
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(options(dir, { epochStore }));
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      const sid = "p".repeat(32);
      client.writePatches([patch("sessions", sid), patch("syncMeta")], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
        syncMeta: { cursor: 42 },
      });
      const before = epochStore.read()!;
      epochStore.write({
        ...before,
        accountEpoch: before.accountEpoch + 1,
        generation: 1,
        updatedAt: before.updatedAt + 1,
      });
      await delay(0);
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
      await client.flushPersistence();

      expect(client.currentEpoch()?.accountEpoch).toBe(2);
      expect(await client.loadCache(["sessions", "syncMeta"])).toBeNull();
    } finally {
      client.close();
    }
  });

  test("failures that arrive for a generation already left do not disable SQLite", async () => {
    const dir = tempDir("sqlite-stale-failures-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    let failing = false;
    const tap: Tap = {
      events: [],
      failAnswers: (epoch) => failing && epoch.generation === 1,
      batchFailures: 5,
    };
    const client = createSqliteWorkerClient(
      options(dir, {
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
      const loads = await Promise.all(
        Array.from({ length: 5 }, () => client.loadCache(["sessions"])),
      );
      expect(loads.every((result) => result === null)).toBe(true);
      await waitUntil(() => client.holdsLock(), 1000, "lock on generation 2");
      await delay(50);

      expect(client.isMemoryFallback()).toBe(false);
      expect(epochStore.read()?.generation).toBe(2);
    } finally {
      client.close();
    }
  });

  test("timeouts on a draining generation do not disable SQLite", async () => {
    const dir = tempDir("sqlite-drain-timeouts-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = storeWithoutEvents();
    let hold = false;
    const tap: Tap = {
      events: [],
      dropRequest: (epoch, op) =>
        hold && epoch.generation === 1 && op === "loadConversationMessages",
      holdReply: (epoch, type) =>
        epoch.generation === 1 && type === "worker-closing",
    };
    const client = createSqliteWorkerClient(
      options(dir, {
        epochStore,
        channelTransport,
        spawnWorker: tapSpawner(
          createDiskWorkerSpawner(dir, channelTransport).spawner,
          tap,
        ),
        workerTimeoutMs: 60,
      }),
    );
    try {
      await client.loadCache(["sessions", "syncMeta"]);
      await waitUntil(() => client.holdsLock(), 1000, "owner holds gen 1");
      hold = true;
      const reads = Array.from({ length: 5 }, (_, index) =>
        client.loadConversationMessages(`conversation-${index}`),
      );
      await delay(5);
      const first = epochStore.read()!;
      epochStore.write({ ...first, generation: 2, updatedAt: 2 });
      const sid = "t".repeat(32);
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
      });
      await client.flushPersistence();
      await Promise.all(reads);
      await delay(150);

      expect(client.isMemoryFallback()).toBe(false);
      expect(epochStore.read()?.generation).toBe(2);
      expect(tap.events).not.toContain("g2:terminate");
    } finally {
      client.close();
    }
  });

  test("a lost flush on a draining generation keeps the active shadow state", async () => {
    const dir = tempDir("sqlite-drain-shadow-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = storeWithoutEvents();
    let hold = false;
    const tap: Tap = {
      events: [],
      dropRequest: (epoch, op) =>
        hold && epoch.generation === 1 && op === "flushBatch",
      holdReply: (epoch, type) =>
        epoch.generation === 1 && type === "worker-closing",
    };
    const client = createSqliteWorkerClient(
      options(dir, {
        epochStore,
        channelTransport,
        spawnWorker: tapSpawner(
          createDiskWorkerSpawner(dir, channelTransport).spawner,
          tap,
        ),
      }),
    );
    try {
      await client.loadCache(["sessions", "docDetails", "syncMeta"]);
      await waitUntil(() => client.holdsLock(), 1000, "owner holds gen 1");
      hold = true;
      const sid = "h".repeat(32);
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: { _id: sid, updated_at: Date.now() } },
      });
      const lost = client.flushPersistence();
      const first = epochStore.read()!;
      epochStore.write({ ...first, generation: 2, updatedAt: 2 });
      const doc = { _id: "doc-active", workspace: "team:new", content: "New" };
      client.writePatches([patch("docDetails", doc._id)], {
        docDetails: { [doc._id]: doc },
      });
      await client.flushPersistence();
      await lost;

      expect(client.currentEpoch()?.generation).toBe(2);
      expect(client.persistedDocDetailWorkspace?.(doc._id)).toBe("team:new");
    } finally {
      client.close();
    }
  });

  test("a newer generation from another tab drains the ready worker", async () => {
    const dir = tempDir("sqlite-follow-drain-");
    const channelTransport = createFakeChannelTransport();
    const epochStore = createFakeEpochStore();
    const tap: Tap = { events: [] };
    const client = createSqliteWorkerClient(
      options(dir, {
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
      epochStore.write({ ...first, generation: 2, updatedAt: 2 });
      await waitUntil(
        () => client.currentEpoch()?.generation === 2 && client.holdsLock(),
        1000,
        "owner holds gen 2",
      );
      await waitUntil(
        () => tap.events.includes("g1:terminate"),
        1000,
        "gen 1 worker ends",
      );

      const gen1 = tap.events.filter((event) => event.startsWith("g1:"));
      expect(gen1.indexOf("g1:close")).toBeGreaterThan(-1);
      expect(gen1.indexOf("g1:close")).toBeLessThan(
        gen1.indexOf("g1:terminate"),
      );
    } finally {
      client.close();
    }
  });

  test("a purge on a closed client leaves the epoch record alone", async () => {
    const dir = tempDir("sqlite-closed-purge-");
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(options(dir, { epochStore }));
    await client.loadCache(["sessions"]);
    const before = epochStore.read();
    client.close();
    await client.purgeLocalCache({ reason: "sign-out" });

    expect(epochStore.read()).toEqual(before);
  });

  test("a flush whose epoch write disables SQLite keeps the batch in memory", async () => {
    const dir = tempDir("sqlite-flush-disable-");
    const client = createSqliteWorkerClient(
      options(dir, {
        epochStore: { read: () => null, write: () => false },
      }),
    );
    try {
      const sid = "m".repeat(32);
      const row = { _id: sid, updated_at: Date.now() };
      client.writePatches([patch("sessions", sid)], {
        sessions: { [sid]: row },
      });
      await client.flushPersistence();

      expect(client.isMemoryFallback()).toBe(true);
      expect(await client.loadCache(["sessions"])).toEqual({
        sessions: { [sid]: row },
      });
    } finally {
      client.close();
    }
  });

  test("rotations of the previous account do not count for the next one", async () => {
    const dir = tempDir("sqlite-rotation-account-");
    const channelTransport = createFakeChannelTransport();
    const auth = createTestAuth("userA");
    const epochStore = createFakeEpochStore();
    const client = createSqliteWorkerClient(
      options(dir, {
        auth,
        epochStore,
        channelTransport,
        spawnWorker: createDiskWorkerSpawner(dir, channelTransport, {
          beforeOpen: (db, epoch) => {
            if (epoch.principal === "userA" && epoch.generation <= 3)
              db.exec(BLOCKED_OWNER("userA"));
            if (epoch.principal === "userB" && epoch.generation === 1)
              db.exec(BLOCKED_OWNER("userB"));
          },
        }).spawner,
      }),
    );
    try {
      await client.loadCache(["sessions"]);
      await waitUntil(
        () => client.currentEpoch()?.generation === 4 && client.holdsLock(),
        2000,
        "userA reaches generation 4",
      );
      auth.setPrincipal("userB");
      await client.loadCache(["sessions"]);
      await waitUntil(
        () =>
          client.currentEpoch()?.principal === "userB" &&
          client.currentEpoch()?.generation === 2 &&
          client.holdsLock(),
        2000,
        "userB reaches generation 2",
      );

      expect(client.isMemoryFallback()).toBe(false);
    } finally {
      client.close();
    }
  });
});
