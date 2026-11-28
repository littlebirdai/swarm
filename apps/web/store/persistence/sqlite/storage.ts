import { authPrincipal } from "../../../lib/authPrincipal";
import { DOCS_SHOTS } from "../../../lib/docsShots/flag";
import { CACHE_SCHEMA_VERSION } from "../schema";
import type { CacheStorage } from "../storage";
import { createIdbJournalBridge } from "./journal-bridge";
import {
  parseCacheEpoch,
  SQLITE_EPOCH_STORAGE_KEY,
  type ChannelTransport,
  type EpochStore,
  type LockAdapter,
  type WorkerSpawner,
} from "./protocol";
import {
  createSqliteWorkerClient,
  type SqliteWorkerCacheClient,
} from "./worker-client";

function createBrowserEpochStore(): EpochStore {
  return {
    read() {
      try {
        if (typeof localStorage === "undefined") return null;
        return parseCacheEpoch(localStorage.getItem(SQLITE_EPOCH_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    write(epoch) {
      try {
        if (typeof localStorage === "undefined") return true;
        localStorage.setItem(SQLITE_EPOCH_STORAGE_KEY, JSON.stringify(epoch));
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      if (typeof window === "undefined") return () => {};
      const handler = (event: StorageEvent) => {
        if (event.key !== SQLITE_EPOCH_STORAGE_KEY) return;
        listener(parseCacheEpoch(event.newValue));
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}

function createBrowserLocks(): LockAdapter | null {
  if (
    typeof navigator === "undefined" ||
    typeof (navigator as { locks?: { request?: unknown } }).locks?.request !==
      "function"
  )
    return null;
  return {
    request(name, signal, onAcquired) {
      return (navigator as unknown as { locks: LockManager }).locks.request(
        name,
        { mode: "exclusive", signal },
        onAcquired,
      );
    },
  };
}

function createBrowserChannelTransport(): ChannelTransport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return {
    open(channelName, onMessage) {
      const channel = new BroadcastChannel(channelName);
      const handler = (event: MessageEvent) => onMessage(event.data);
      channel.addEventListener("message", handler);
      return {
        post(data) {
          channel.postMessage(data);
        },
        close() {
          channel.removeEventListener("message", handler);
          channel.close();
        },
      };
    },
  };
}

function createBrowserWorkerSpawner(): WorkerSpawner {
  return (_epoch, onMessage, onError) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event) => onMessage(event.data);
    worker.onerror = (event) => onError(event.message || "Worker error");
    return {
      postMessage(message) {
        worker.postMessage(message);
      },
      terminate() {
        worker.terminate();
      },
    };
  };
}

function browserOpfsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !DOCS_SHOTS &&
    typeof Worker !== "undefined" &&
    typeof BroadcastChannel !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof (navigator as { locks?: { request?: unknown } }).locks?.request ===
      "function" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

let sqliteStorage: SqliteWorkerCacheClient | null = null;

export function getSqliteCacheStorage(): CacheStorage {
  if (!sqliteStorage) {
    sqliteStorage = createSqliteWorkerClient({
      auth: authPrincipal,
      schemaVersion: CACHE_SCHEMA_VERSION,
      epochStore: createBrowserEpochStore(),
      locks: createBrowserLocks(),
      channelTransport: createBrowserChannelTransport(),
      spawnWorker: createBrowserWorkerSpawner(),
      opfsSupported: browserOpfsSupported,
      journal: createIdbJournalBridge(),
    });
  }
  return sqliteStorage;
}
