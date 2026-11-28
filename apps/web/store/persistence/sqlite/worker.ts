import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import {
  cleanupStaleEpochDirectories,
  openOpfsSahPoolDatabase,
} from "./driver";
import type { ChannelTransport, SqliteOwnerCommand } from "./protocol";
import { createSqliteWorkerHost, type SqliteWorkerHost } from "./worker-host";

const broadcastTransport: ChannelTransport = {
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

let sqliteModulePromise: Promise<Sqlite3Static> | null = null;
function loadSqlite(): Promise<Sqlite3Static> {
  if (!sqliteModulePromise) sqliteModulePromise = sqlite3InitModule();
  return sqliteModulePromise;
}

const workerId = crypto.randomUUID();
let host: SqliteWorkerHost | null = null;
let queue: Promise<void> = Promise.resolve();

export function dispatchWorkerMessage(
  data: unknown,
  handler: (message: SqliteOwnerCommand) => Promise<void>,
): void {
  if (!data || typeof data !== "object") return;
  const msg = data as { type?: unknown };
  if (typeof msg.type !== "string") return;
  if (msg.type === "init") {
    const epoch = (data as { epoch?: unknown }).epoch;
    if (!epoch || typeof epoch !== "object") return;
  }
  queue = queue.then(() => handler(data as SqliteOwnerCommand)).catch(() => {});
}

self.onmessage = (event: MessageEvent<SqliteOwnerCommand>) => {
  dispatchWorkerMessage(event?.data, async (message) => {
    if (message.type === "close") {
      if (host) {
        await host.close();
        host = null;
      }
      return;
    }
    if (message.type === "init") {
      if (host) {
        await host.close();
        host = null;
      }
      const nextHost = createSqliteWorkerHost({
        workerId,
        epoch: message.epoch,
        channelTransport: broadcastTransport,
        openDatabase: async (epoch, onWriteError) => {
          const sqlite3 = await loadSqlite();
          return openOpfsSahPoolDatabase(sqlite3, epoch, onWriteError);
        },
        postToOwner: (reply) => {
          self.postMessage(reply);
        },
      });
      host = nextHost;
      const started = await nextHost.start();
      if (started && host === nextHost) {
        void cleanupStaleEpochDirectories(message.epoch);
      } else if (host === nextHost) {
        host = null;
      }
      return;
    }
    if (host) await host.handleOwnerMessage(message);
  });
};
