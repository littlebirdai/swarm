import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheEpoch, EpochStore, WorkerSpawner } from "../protocol";
import { createSqliteWorkerClient } from "../worker-client";
import {
  createDiskWorkerSpawner,
  createFakeChannelTransport,
  createFakeEpochStore,
  createFakeJournal,
  createFakeLockAdapter,
  createTestAuth,
} from "./worker-testkit";

const tempDirs: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
}

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function blockedOwnerSql(principal: string): string {
  return `
  CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS collection_rows (collection TEXT NOT NULL, id TEXT NOT NULL, timestamp REAL, value TEXT NOT NULL, PRIMARY KEY (collection, id));
  CREATE TABLE IF NOT EXISTS conversation_meta (id TEXT NOT NULL PRIMARY KEY, pagination TEXT, latest_timestamp REAL, user_messages TEXT, touched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS message_rows (conversation_id TEXT NOT NULL, message_key TEXT NOT NULL, position REAL NOT NULL, value TEXT NOT NULL, PRIMARY KEY (conversation_id, message_key));
  INSERT OR IGNORE INTO migrations VALUES (1);
  INSERT OR REPLACE INTO meta VALUES ('cacheOwner', '${JSON.stringify({ principal, at: 1, reason: "write-failed", blocked: true })}');
`;
}

export function storeWithoutEvents(
  initial: CacheEpoch | null = null,
): EpochStore {
  const stored = createFakeEpochStore(initial);
  return { read: () => stored.read(), write: (epoch) => stored.write(epoch) };
}

export type WorkerTap = {
  events: string[];
  dropRequest?: (epoch: CacheEpoch, op: string) => boolean;
  failAnswers?: (epoch: CacheEpoch) => boolean;
  onReply?: (epoch: CacheEpoch, data: unknown) => "hold" | void;
  held: Array<() => void>;
  spawned: CacheEpoch[];
  deliver: Map<number, (data: unknown) => void>;
};

export function createWorkerTap(): WorkerTap {
  return { events: [], held: [], spawned: [], deliver: new Map() };
}

export function releaseHeld(tap: WorkerTap): void {
  for (const run of tap.held.splice(0)) run();
}

export function tapSpawner(
  inner: WorkerSpawner,
  tap: WorkerTap,
): WorkerSpawner {
  return (epoch, onMessage, onError) => {
    tap.spawned.push(epoch);
    tap.deliver.set(epoch.generation, onMessage);
    const worker = inner(
      epoch,
      (data) => {
        const type = (data as { type?: string })?.type ?? "";
        const delivered =
          type === "response" && tap.failAnswers?.(epoch)
            ? {
                ...(data as object),
                ok: false,
                code: "write-failed",
                error: "Injected write failure",
              }
            : data;
        if (tap.onReply?.(epoch, delivered) === "hold") {
          tap.held.push(() => onMessage(delivered));
          return;
        }
        onMessage(delivered);
      },
      onError,
    );
    return {
      postMessage(message: unknown) {
        const command = message as { type?: string; op?: string };
        if (command?.type === "close")
          tap.events.push(`g${epoch.generation}:close`);
        if (command?.type === "request") {
          if (tap.dropRequest?.(epoch, command.op ?? "")) {
            tap.events.push(`g${epoch.generation}:dropped:${command.op}`);
            return;
          }
        }
        worker.postMessage(message);
      },
      terminate() {
        tap.events.push(`g${epoch.generation}:terminate`);
        worker.terminate();
      },
    };
  };
}

export function clientOptions(
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
