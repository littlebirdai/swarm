import { Database } from "bun:sqlite";
import type { AuthTokenState } from "@platform/auth/web";
import type { Patch } from "mutative";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JournalBridge } from "../journal-bridge";
import {
  epochDirectory,
  type CacheEpoch,
  type ChannelTransport,
  type EpochStore,
  type LockAdapter,
  type WorkerHandle,
  type WorkerSpawner,
} from "../protocol";
import type { SqliteDriver, SqlValue } from "../schema";
import { createSqliteWorkerHost } from "../worker-host";

export const patch = (...path: string[]): Patch => ({
  op: "replace",
  path,
  value: null,
});

export function createFakeChannelTransport(): ChannelTransport {
  const channels = new Map<
    string,
    Set<{ onMessage: (data: unknown) => void }>
  >();
  return {
    open(channelName, onMessage) {
      let listeners = channels.get(channelName);
      if (!listeners) channels.set(channelName, (listeners = new Set()));
      const entry = { onMessage };
      listeners.add(entry);
      return {
        post(data) {
          const copy = structuredClone(data);
          const current = [...(channels.get(channelName) ?? [])];
          queueMicrotask(() => {
            for (const target of current) {
              if (target !== entry) target.onMessage(copy);
            }
          });
        },
        close() {
          channels.get(channelName)?.delete(entry);
        },
      };
    },
  };
}

export function createFakeLockAdapter(): LockAdapter {
  const held = new Map<
    string,
    Array<{
      signal: AbortSignal;
      run: () => void;
    }>
  >();

  const drain = (name: string) => {
    const queue = held.get(name);
    if (!queue || queue.length === 0) return;
    while (queue.length > 0 && queue[0].signal.aborted) queue.shift();
    if (queue.length === 0) {
      held.delete(name);
      return;
    }
    queue[0].run();
  };

  return {
    request(name, signal, onAcquired) {
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let queue = held.get(name);
        if (!queue) held.set(name, (queue = []));

        const entry = {
          signal,
          run: () => {
            if (signal.aborted) {
              queue!.shift();
              drain(name);
              resolve();
              return;
            }
            Promise.resolve()
              .then(() => onAcquired())
              .finally(() => {
                const idx = queue!.indexOf(entry);
                if (idx >= 0) queue!.splice(idx, 1);
                drain(name);
                resolve();
              });
          },
        };
        const wasIdle = queue.length === 0;
        queue.push(entry);
        const onAbort = () => {
          const idx = queue!.indexOf(entry);
          if (idx > 0) {
            queue!.splice(idx, 1);
            resolve();
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (wasIdle) queueMicrotask(() => drain(name));
      });
    },
  };
}

export function createFakeEpochStore(
  initial: CacheEpoch | null = null,
): EpochStore {
  let current = initial;
  const listeners = new Set<(epoch: CacheEpoch | null) => void>();
  return {
    read: () => current,
    write(epoch) {
      current = epoch;
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(epoch);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createFakeJournal(): JournalBridge & {
  outbox: any[];
  pending: Record<string, any>;
} {
  const outbox: any[] = [];
  const pending: Record<string, any> = {};
  return {
    outbox,
    pending,
    enqueueDispatch: async (entry) => {
      outbox.push(entry);
    },
    removeDispatch: async (id) => {
      const idx = outbox.findIndex((item) => item.id === id);
      if (idx >= 0) outbox.splice(idx, 1);
    },
    loadOutbox: async () => [...outbox],
    outboxAccountId: () => "userA",
    persistPendingMessageChanges: () => {},
    loadJournalKeys: async (keys) => {
      const wanted = keys ? new Set(keys) : null;
      if (
        (!wanted || wanted.has("pending")) &&
        Object.keys(pending).length > 0
      ) {
        return { pending: { ...pending } };
      }
      return {};
    },
    writePendingEntries: async (patches, nextPending) => {
      if (patches.some(({ path }) => path[0] === "pending")) {
        for (const k of Object.keys(pending)) delete pending[k];
        Object.assign(pending, nextPending ?? {});
      }
    },
    purgeJournal: async () => {
      outbox.length = 0;
      for (const k of Object.keys(pending)) delete pending[k];
    },
  };
}

function wrapBunSqliteDriver(
  db: Database,
  onWriteError?: (error: unknown) => void,
): SqliteDriver {
  return {
    exec(sql: string) {
      try {
        return db.exec(sql);
      } catch (error) {
        onWriteError?.(error);
        throw error;
      }
    },
    prepare<Row>(sql: string) {
      const query = db.query<Row, SqlValue[]>(sql);
      return {
        get: (...params: SqlValue[]) => query.get(...params) ?? null,
        all: (...params: SqlValue[]) => query.all(...params),
        run: (...params: SqlValue[]) => {
          try {
            return query.run(...params);
          } catch (error) {
            onWriteError?.(error);
            throw error;
          }
        },
      };
    },
    transaction<Result>(body: () => Result): () => Result {
      const tx = db.transaction(body);
      return () => {
        try {
          return tx();
        } catch (error) {
          onWriteError?.(error);
          throw error;
        }
      };
    },
  };
}

export function createDiskWorkerSpawner(
  rootDir: string,
  channelTransport: ChannelTransport,
  opts?: {
    onSpawn?: (epoch: CacheEpoch) => void;
    beforeOpen?: (db: Database, epoch: CacheEpoch) => void;
    hang?: () => boolean;
    hangRpc?: () => boolean;
    failOpfs?: () => boolean;
  },
): { spawner: WorkerSpawner; openDbs: Database[] } {
  let seq = 0;
  const openDbs: Database[] = [];
  const spawner: WorkerSpawner = (epoch, onMessage) => {
    opts?.onSpawn?.(epoch);
    const workerId = `w-${++seq}`;
    let host: ReturnType<typeof createSqliteWorkerHost> | null = null;
    let terminated = false;

    const handle: WorkerHandle = {
      postMessage(msg: unknown) {
        if (terminated) return;
        const cmd = msg as { type?: string; epoch?: CacheEpoch };
        if (cmd.type === "init") {
          if (opts?.hang?.()) return;
          const dbDir = join(rootDir, epochDirectory(epoch).slice(1));
          const file = join(dbDir, "cache.sqlite3");
          host = createSqliteWorkerHost({
            workerId,
            epoch,
            channelTransport,
            openDatabase: async (_ep, onWriteError) => {
              if (opts?.failOpfs?.()) {
                throw new Error("Missing required OPFS APIs.");
              }
              mkdirSync(dbDir, { recursive: true });
              const db = new Database(file);
              openDbs.push(db);
              opts?.beforeOpen?.(db, epoch);
              return {
                driver: wrapBunSqliteDriver(db, onWriteError),
                close: () => {
                  try {
                    db.close();
                  } catch {}
                },
              };
            },
            postToOwner: (reply) => {
              if (!terminated) queueMicrotask(() => onMessage(reply));
            },
          });
          void host.start();
          return;
        }
        if (opts?.hangRpc?.()) return;
        if (host) void host.handleOwnerMessage(msg);
      },
      terminate() {
        terminated = true;
        if (host) void host.close();
      },
    };
    return handle;
  };
  return { spawner, openDbs };
}

export function createTestAuth(initialPrincipal: string | null = "userA") {
  let principal: string | null = initialPrincipal;
  let tokenState: AuthTokenState = initialPrincipal ? "named" : "absent";
  let authEpoch = 0;
  return {
    current: () => principal,
    resolve: async () => principal,
    tokenState: () => tokenState,
    epoch: () => authEpoch,
    setPrincipal(next: string | null, nextState?: AuthTokenState) {
      principal = next;
      tokenState = nextState ?? (next ? "named" : "absent");
      authEpoch++;
    },
  };
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1500,
  label = "condition",
) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
