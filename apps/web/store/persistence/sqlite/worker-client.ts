import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import type { CacheStorage } from "../storage";
import type { JournalBridge } from "./journal-bridge";
import {
  createMemoryCacheFallback,
  type MemoryCacheStorage,
} from "./memory-fallback";
import {
  buildWritePayload,
  journalKeys,
  recordKnownRows,
} from "./patch-payload";
import {
  SQLITE_WORKER_TIMEOUT_MS,
  type CacheEpoch,
  type ChannelTransport,
  type EpochStore,
  type LockAdapter,
  type WorkerSpawner,
} from "./protocol";
import { createWorkerConnection, WorkerRpcError } from "./worker-connection";

export type SqliteWorkerClientDeps = {
  auth: Pick<
    AuthPrincipalTracker,
    "current" | "resolve" | "tokenState" | "epoch"
  >;
  schemaVersion: number;
  epochStore: EpochStore;
  locks: LockAdapter | null;
  channelTransport: ChannelTransport | null;
  spawnWorker: WorkerSpawner;
  opfsSupported: () => boolean;
  journal: JournalBridge;
  workerTimeoutMs?: number;
  now?: () => number;
  createId?: () => string;
  onFallbackToMemory?: (reason: string) => void;
};

export type SqliteWorkerCacheClient = CacheStorage & {
  close(): void;
  currentEpoch(): CacheEpoch | null;
  holdsLock(): boolean;
  isMemoryFallback(): boolean;
};

export function createSqliteWorkerClient(
  deps: SqliteWorkerClientDeps,
): SqliteWorkerCacheClient {
  const {
    auth,
    schemaVersion,
    epochStore,
    locks,
    channelTransport,
    spawnWorker,
    opfsSupported,
    journal,
    workerTimeoutMs = SQLITE_WORKER_TIMEOUT_MS,
    now = () => Date.now(),
    createId = () => crypto.randomUUID(),
    onFallbackToMemory,
  } = deps;

  const memory: MemoryCacheStorage = createMemoryCacheFallback(auth);
  const knownIds = new Map<string, Set<string>>();
  const inFlightWrites = new Set<Promise<void>>();

  let closed = false;
  let hydrating = false;
  let opfsMissing = !opfsSupported() || !locks || !channelTransport;
  if (opfsMissing) onFallbackToMemory?.("opfs-unsupported");

  const connection = createWorkerConnection({
    clientId: createId(),
    auth,
    schemaVersion,
    epochStore,
    locks,
    channelTransport,
    spawnWorker,
    workerTimeoutMs,
    now,
    createId,
    onOpfsMissing: (reason) => {
      if (!opfsMissing) {
        opfsMissing = true;
        onFallbackToMemory?.(reason);
      }
    },
  });

  const trackWrite = (promise: Promise<void>) => {
    inFlightWrites.add(promise);
    void promise.finally(() => inFlightWrites.delete(promise));
  };

  const handleWorkerError = (epoch: CacheEpoch, error: unknown) => {
    if (
      error instanceof WorkerRpcError &&
      (error.code === "write-failed" || error.code === "version-mismatch")
    ) {
      connection.handleEpochFailure(epoch, error.message);
    }
  };

  return {
    enqueueDispatch: journal.enqueueDispatch,
    removeDispatch: journal.removeDispatch,
    loadOutbox: journal.loadOutbox,
    outboxAccountId: journal.outboxAccountId,
    persistPendingMessageChanges: journal.persistPendingMessageChanges,

    setHydrating(value) {
      hydrating = value;
      memory.setHydrating(value);
    },

    async loadCache(keys, context = {}) {
      if (closed) return null;
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;

      if (opfsMissing) {
        const [memResult, journalResult] = await Promise.all([
          memory.loadCache(keys, context),
          journal.loadJournalKeys(keys, context, principal),
        ]);
        const merged = { ...(memResult ?? {}), ...journalResult };
        return Object.keys(merged).length ? merged : null;
      }

      if (principal === null) {
        connection.ensureActiveEpoch(null, false);
        return null;
      }

      const epoch = connection.ensureActiveEpoch(principal, true);
      const journalResult = await journal.loadJournalKeys(
        keys,
        context,
        principal,
      );
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;

      const wantsOnlyJournal =
        Array.isArray(keys) && keys.every((key) => journalKeys.has(key));
      if (wantsOnlyJournal || !epoch) {
        return Object.keys(journalResult).length ? journalResult : null;
      }

      const sqliteContext =
        journalResult.pending && context.pending === undefined
          ? { ...context, pending: journalResult.pending }
          : context;
      let sqliteResult: Record<string, any> | null = null;
      try {
        sqliteResult = await connection.send(epoch, principal, "loadCache", {
          keys,
          context: sqliteContext,
        });
        recordKnownRows(knownIds, sqliteResult);
      } catch (error) {
        if (opfsMissing) {
          const memResult = await memory.loadCache(keys, context);
          const merged = { ...(memResult ?? {}), ...journalResult };
          return Object.keys(merged).length ? merged : null;
        }
        handleWorkerError(epoch, error);
        sqliteResult = null;
      }
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      const merged = { ...(sqliteResult ?? {}), ...journalResult };
      return Object.keys(merged).length ? merged : null;
    },

    async loadPaintCache() {
      if (closed) return null;
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      if (opfsMissing) return memory.loadPaintCache();
      if (principal === null) {
        connection.ensureActiveEpoch(null, false);
        return null;
      }
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return null;
      try {
        const result = await connection.send(
          epoch,
          principal,
          "loadPaintCache",
          {},
        );
        if (
          closed ||
          authEpoch !== auth.epoch() ||
          auth.current() !== principal
        )
          return null;
        recordKnownRows(knownIds, result);
        return result;
      } catch (error) {
        if (opfsMissing) return memory.loadPaintCache();
        handleWorkerError(epoch, error);
        return null;
      }
    },

    writePatches(patches, state: Record<string, any>) {
      if (closed || hydrating) return;
      const principal = auth.current();
      const stateOwner = state.currentUser?._id;
      if (
        principal === null ||
        (stateOwner !== undefined && stateOwner !== principal)
      )
        return;

      let pendingWrite: Promise<void> | undefined;
      if (patches.some(({ path }) => path[0] === "pending")) {
        pendingWrite = journal
          .writePendingEntries(patches, state.pending)
          .catch(() => {});
        trackWrite(pendingWrite);
      }

      if (opfsMissing) {
        memory.writePatches(patches, state);
        return pendingWrite;
      }

      const payload = buildWritePayload(knownIds, patches, state);
      if (!payload) return pendingWrite;
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return pendingWrite;

      const writePromise = connection
        .send(epoch, principal, "writePatches", payload)
        .catch((error) => {
          if (opfsMissing) {
            memory.writePatches(patches, state);
            return;
          }
          handleWorkerError(epoch, error);
        })
        .then(() => undefined);
      trackWrite(writePromise);
      return pendingWrite ?? writePromise;
    },

    async flushPersistence() {
      await Promise.all([...inFlightWrites]);
      await memory.flushPersistence();
    },

    async loadConversationMessages(conversationId) {
      if (closed) return null;
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      if (opfsMissing) return memory.loadConversationMessages(conversationId);
      if (principal === null) {
        connection.ensureActiveEpoch(null, false);
        return null;
      }
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return null;
      try {
        const result = await connection.send(
          epoch,
          principal,
          "loadConversationMessages",
          { conversationId },
        );
        if (
          closed ||
          authEpoch !== auth.epoch() ||
          auth.current() !== principal
        )
          return null;
        return result;
      } catch (error) {
        if (opfsMissing) return memory.loadConversationMessages(conversationId);
        handleWorkerError(epoch, error);
        return null;
      }
    },

    writeConversationMessages(conversationId, messages, pagination) {
      if (closed || hydrating) return;
      const principal = auth.current();
      if (principal === null) return;
      if (opfsMissing) {
        memory.writeConversationMessages(conversationId, messages, pagination);
        return;
      }
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return;
      const writePromise = connection
        .send(epoch, principal, "writeConversationMessages", {
          conversationId,
          messages,
          pagination,
        })
        .catch((error) => {
          if (opfsMissing) {
            memory.writeConversationMessages(
              conversationId,
              messages,
              pagination,
            );
            return;
          }
          handleWorkerError(epoch, error);
        })
        .then(() => undefined);
      trackWrite(writePromise);
    },

    writeConversationUserMessages(conversationId, messages) {
      if (closed || hydrating) return;
      const principal = auth.current();
      if (principal === null) return;
      if (opfsMissing) {
        memory.writeConversationUserMessages(conversationId, messages);
        return;
      }
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return;
      const writePromise = connection
        .send(epoch, principal, "writeConversationUserMessages", {
          conversationId,
          messages,
        })
        .catch((error) => {
          if (opfsMissing) {
            memory.writeConversationUserMessages(conversationId, messages);
            return;
          }
          handleWorkerError(epoch, error);
        })
        .then(() => undefined);
      trackWrite(writePromise);
    },

    async purgeLocalCache(options) {
      const keep = options?.keepPendingInputFor ?? null;
      recordCacheEvent("purge", {
        engine: opfsMissing ? "memory" : "sqlite-worker",
        reason: options?.reason ?? "unspecified",
        keepPendingInputFor: keep,
        ...options?.detail,
      });
      knownIds.clear();
      await memory.purgeLocalCache(options);
      if (!opfsMissing) connection.rotateForPurge(keep);
      await journal.purgeJournal(keep);
    },

    close() {
      if (closed) return;
      closed = true;
      connection.close();
    },

    currentEpoch() {
      return connection.currentEpoch();
    },

    holdsLock() {
      return connection.holdsLock();
    },

    isMemoryFallback() {
      return opfsMissing;
    },
  };
}
