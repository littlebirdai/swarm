import type { Database } from "bun:sqlite";
import type { CacheEpoch, WorkerHandle } from "../protocol";
import {
  createDiskWorkerSpawner,
  createFakeChannelTransport,
  createFakeLockAdapter,
} from "./worker-testkit";

type MessageListener = (event: { data: unknown }) => void;

export function installBrowserSqliteWorker(rootDir: string): {
  rowsRead(): number;
  rowChanges(): number;
  databases: Database[];
  restore(): void;
} {
  const transport = createFakeChannelTransport();
  const locks = createFakeLockAdapter();
  let rowsRead = 0;
  const { spawner, openDbs } = createDiskWorkerSpawner(rootDir, transport, {
    onRead: (rows) => {
      rowsRead += rows;
    },
  });

  class InProcessBroadcastChannel {
    private readonly listeners = new Set<MessageListener>();
    private readonly endpoint;
    constructor(name: string) {
      this.endpoint = transport.open(name, (data) => {
        for (const listener of this.listeners) listener({ data });
      });
    }
    addEventListener(_type: "message", listener: MessageListener) {
      this.listeners.add(listener);
    }
    removeEventListener(_type: "message", listener: MessageListener) {
      this.listeners.delete(listener);
    }
    postMessage(data: unknown) {
      this.endpoint.post(data);
    }
    close() {
      this.listeners.clear();
      this.endpoint.close();
    }
  }

  class InProcessSqliteWorker {
    onmessage: MessageListener | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    private handle: WorkerHandle | null = null;
    postMessage(message: unknown) {
      const command = message as { type?: string; epoch?: CacheEpoch };
      if (command?.type === "init" && command.epoch && !this.handle) {
        this.handle = spawner(
          command.epoch,
          (data) => this.onmessage?.({ data }),
          (error) => this.onerror?.({ message: error }),
        );
      }
      this.handle?.postMessage(message);
    }
    terminate() {
      this.handle?.terminate();
      this.handle = null;
    }
  }

  const navigatorObject = globalThis.navigator as unknown as Record<
    string,
    unknown
  >;
  const previous = {
    Worker: globalThis.Worker,
    BroadcastChannel: globalThis.BroadcastChannel,
    locks: Object.getOwnPropertyDescriptor(navigatorObject, "locks"),
    storage: Object.getOwnPropertyDescriptor(navigatorObject, "storage"),
  };
  Object.assign(globalThis, {
    Worker: InProcessSqliteWorker,
    BroadcastChannel: InProcessBroadcastChannel,
  });
  Object.defineProperty(navigatorObject, "locks", {
    configurable: true,
    value: {
      request: (
        name: string,
        options: { signal?: AbortSignal },
        onAcquired: () => Promise<void> | void,
      ) =>
        locks.request(
          name,
          options.signal ?? new AbortController().signal,
          onAcquired,
        ),
    },
  });
  Object.defineProperty(navigatorObject, "storage", {
    configurable: true,
    value: { getDirectory: async () => ({}) },
  });

  const restoreProperty = (
    key: "locks" | "storage",
    descriptor: PropertyDescriptor | undefined,
  ) => {
    if (descriptor) Object.defineProperty(navigatorObject, key, descriptor);
    else delete navigatorObject[key];
  };

  return {
    rowsRead: () => rowsRead,
    rowChanges: () => {
      let changes = 0;
      for (const db of openDbs) {
        try {
          changes +=
            db.query<{ n: number }, []>("SELECT total_changes() AS n").get()
              ?.n ?? 0;
        } catch {}
      }
      return changes;
    },
    databases: openDbs,
    restore() {
      Object.assign(globalThis, {
        Worker: previous.Worker,
        BroadcastChannel: previous.BroadcastChannel,
      });
      restoreProperty("locks", previous.locks);
      restoreProperty("storage", previous.storage);
    },
  };
}
