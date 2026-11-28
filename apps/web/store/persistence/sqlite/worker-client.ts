import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import {
  cacheEvictionsFor,
  withoutEvictionPatches,
} from "../../cache-eviction";
import {
  clearSnapshotDrops,
  createCoalescedWriter,
} from "../../idb-collection-diff";
import { bindWindowFlush } from "../db";
import { setHydrating as setPersistenceHydrating } from "../hydration";
import { LIVENESS_FLUSH_MS } from "../idb-liveness-lane";
import type { CacheStorage, CachedConversation } from "../storage";
import type { JournalBridge } from "./journal-bridge";
import {
  createMemoryCacheFallback,
  type MemoryCacheStorage,
} from "./memory-fallback";
import {
  buildWritePayload,
  journalKeys,
  recordKnownState,
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

type BufferedMessages = {
  principal: string;
  messages?: { rows: unknown[]; pagination: unknown };
  userMessages?: unknown[];
};

const META_COALESCE_MS = 250;
const MSG_COALESCE_MS = 300;

function computeLatestTimestamp(messages: unknown[]): number {
  let max = 0;
  for (const row of messages as Array<{ timestamp?: number }>) {
    if (typeof row?.timestamp === "number" && Number.isFinite(row.timestamp)) {
      if (row.timestamp > max) max = row.timestamp;
    }
  }
  return max;
}

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
  const lastPersistedRows = new Map<string, Map<string, unknown>>();
  const lastPersistedMeta = new Map<string, unknown>();
  const inFlightWrites = new Set<Promise<void>>();

  const pendingLivenessRows = new Map<string, Set<string>>();
  const pendingLivenessMeta = new Set<string>();
  let pendingLivenessSyncMeta = false;
  let livenessState: Record<string, any> | null = null;
  let livenessTimer: ReturnType<typeof setTimeout> | null = null;

  const pendingMsgWrites = new Map<string, BufferedMessages>();
  let msgWriteTimer: ReturnType<typeof setTimeout> | null = null;
  let latestUser: { _id: string } | undefined;

  let closed = false;
  let hydrating = false;
  let writeGeneration = 0;
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
      (error.code === "write-failed" ||
        error.code === "version-mismatch" ||
        (error.code === "owner-mismatch" &&
          epoch.principal !== null &&
          epoch.principal === auth.current()))
    ) {
      connection.handleEpochFailure(epoch, error.message);
    }
  };

  const metaWriter = createCoalescedWriter(
    (key, entry: { value: unknown; gen: number }) => {
      if (closed || hydrating || opfsMissing || entry.gen !== writeGeneration)
        return;
      const principal = auth.current();
      if (principal === null) return;
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return;
      const slice: Record<string, unknown> = { [key]: entry.value };
      if (latestUser) slice.currentUser = latestUser;
      const promise = connection
        .send(epoch, principal, "writePatches", {
          patches: [{ op: "replace", path: [key], value: entry.value }],
          state: slice,
        })
        .catch((error) => handleWorkerError(epoch, error))
        .then(() => undefined);
      trackWrite(promise);
    },
    META_COALESCE_MS,
  );

  const flushLiveness = () => {
    if (livenessTimer) {
      clearTimeout(livenessTimer);
      livenessTimer = null;
    }
    const state = livenessState;
    livenessState = null;
    const writeSyncMeta =
      pendingLivenessSyncMeta && state?.syncMeta !== undefined;
    pendingLivenessSyncMeta = false;
    const waitingRows = [...pendingLivenessRows];
    pendingLivenessRows.clear();
    const waitingMeta = [...pendingLivenessMeta];
    pendingLivenessMeta.clear();
    if (closed || hydrating || opfsMissing || !state) return;

    metaWriter.flush();
    const principal = auth.current();
    if (principal === null) return;
    if (state.currentUser?._id && state.currentUser._id !== principal) return;

    const slice: Record<string, unknown> = {};
    if (state.currentUser?._id)
      slice.currentUser = { _id: state.currentUser._id };
    const patches: Array<{
      op: "replace";
      path: (string | number)[];
      value: unknown;
    }> = [];

    for (const key of waitingMeta) {
      const value = state[key];
      if (value === undefined || lastPersistedMeta.get(key) === value) continue;
      lastPersistedMeta.set(key, value);
      slice[key] = value;
      patches.push({ op: "replace", path: [key], value });
    }
    for (const [key, ids] of waitingRows) {
      const data = state[key];
      const shadow = lastPersistedRows.get(key);
      if (!data || !shadow) continue;
      const partial: Record<string, unknown> = {};
      let added = false;
      for (const id of ids) {
        const row = Object.hasOwn(data, id) ? data[id] : undefined;
        if (row === undefined || shadow.get(id) === row) continue;
        partial[id] = row;
        shadow.set(id, row);
        knownIds.get(key)?.add(id);
        patches.push({ op: "replace", path: [key, id], value: row });
        added = true;
      }
      if (added) slice[key] = partial;
    }
    if (writeSyncMeta) {
      slice.syncMeta = state.syncMeta;
      patches.push({
        op: "replace",
        path: ["syncMeta"],
        value: state.syncMeta,
      });
    }
    if (!patches.length) return;
    const epoch = connection.ensureActiveEpoch(principal, true);
    if (!epoch) return;
    const promise = connection
      .send(epoch, principal, "writePatches", { patches, state: slice })
      .catch((error) => handleWorkerError(epoch, error))
      .then(() => undefined);
    trackWrite(promise);
  };

  const scheduleLiveness = (state: Record<string, any>) => {
    livenessState = state;
    if (!livenessTimer) {
      livenessTimer = setTimeout(flushLiveness, LIVENESS_FLUSH_MS);
    }
  };

  const flushMessages = () => {
    if (msgWriteTimer) {
      clearTimeout(msgWriteTimer);
      msgWriteTimer = null;
    }
    if (!pendingMsgWrites.size) return;
    const batch = [...pendingMsgWrites.entries()];
    pendingMsgWrites.clear();
    if (closed || opfsMissing) return;
    const principal = auth.current();
    if (principal === null) return;
    const epoch = connection.ensureActiveEpoch(principal, true);
    if (!epoch) return;

    for (const [conversationId, entry] of batch) {
      if (entry.principal !== principal) continue;
      if (entry.messages) {
        const { rows, pagination } = entry.messages;
        const promise = connection
          .send(epoch, principal, "writeConversationMessages", {
            conversationId,
            messages: rows,
            pagination,
          })
          .catch((error) => {
            if (opfsMissing) {
              memory.writeConversationMessages(
                conversationId,
                rows,
                pagination,
              );
              return;
            }
            handleWorkerError(epoch, error);
          })
          .then(() => undefined);
        trackWrite(promise);
      }
      if (entry.userMessages) {
        const userMessages = entry.userMessages;
        const promise = connection
          .send(epoch, principal, "writeConversationUserMessages", {
            conversationId,
            messages: userMessages,
          })
          .catch((error) => {
            if (opfsMissing) {
              memory.writeConversationUserMessages(
                conversationId,
                userMessages,
              );
              return;
            }
            handleWorkerError(epoch, error);
          })
          .then(() => undefined);
        trackWrite(promise);
      }
    }
  };

  const scheduleMessagesFlush = () => {
    if (!msgWriteTimer) {
      msgWriteTimer = setTimeout(flushMessages, MSG_COALESCE_MS);
    }
  };

  const clearPendingBuffers = () => {
    writeGeneration++;
    metaWriter.drop();
    if (livenessTimer) {
      clearTimeout(livenessTimer);
      livenessTimer = null;
    }
    if (msgWriteTimer) {
      clearTimeout(msgWriteTimer);
      msgWriteTimer = null;
    }
    livenessState = null;
    pendingLivenessSyncMeta = false;
    pendingLivenessRows.clear();
    pendingLivenessMeta.clear();
    pendingMsgWrites.clear();
    latestUser = undefined;
  };

  bindWindowFlush(() => {
    if (closed) return;
    metaWriter.flush();
    flushLiveness();
    flushMessages();
  });

  return {
    enqueueDispatch: journal.enqueueDispatch,
    removeDispatch: journal.removeDispatch,
    loadOutbox: journal.loadOutbox,
    outboxAccountId: journal.outboxAccountId,
    persistPendingMessageChanges: journal.persistPendingMessageChanges,

    setHydrating(value) {
      hydrating = value;
      setPersistenceHydrating(value);
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
        recordKnownState(
          knownIds,
          lastPersistedRows,
          lastPersistedMeta,
          sqliteResult,
        );
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
        recordKnownState(
          knownIds,
          lastPersistedRows,
          lastPersistedMeta,
          result,
        );
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

      const evictions = cacheEvictionsFor(patches, state);
      patches = withoutEvictionPatches(patches, evictions);
      if (!patches.length) return;

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

      if (state.currentUser?._id) latestUser = { _id: state.currentUser._id };

      const built = buildWritePayload({
        knownIds,
        lastPersistedRows,
        lastPersistedMeta,
        patches,
        state,
      });
      if (!built) return pendingWrite;

      for (const [key, ids] of built.flushedDurableLivenessRows) {
        const held = pendingLivenessRows.get(key);
        if (held) {
          for (const id of ids) held.delete(id);
          if (held.size === 0) pendingLivenessRows.delete(key);
        }
      }
      for (const [key, ids] of built.heldLivenessRows) {
        let waiting = pendingLivenessRows.get(key);
        if (!waiting) pendingLivenessRows.set(key, (waiting = new Set()));
        for (const id of ids) waiting.add(id);
        scheduleLiveness(state);
      }
      for (const key of built.heldLivenessMeta) {
        pendingLivenessMeta.add(key);
        scheduleLiveness(state);
      }
      for (const [key, value] of built.bufferedMeta) {
        pendingLivenessMeta.delete(key);
        metaWriter.write(key, { value, gen: writeGeneration });
      }
      if (built.holdSyncMeta) {
        pendingLivenessSyncMeta = true;
        scheduleLiveness(state);
      }

      if (!built.immediate) return pendingWrite;

      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return pendingWrite;

      const writePromise = connection
        .send(epoch, principal, "writePatches", built.immediate)
        .then(() => {
          for (const key of built.dropKeys) clearSnapshotDrops(key);
        })
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
      metaWriter.flush();
      flushLiveness();
      flushMessages();
      while (inFlightWrites.size > 0) {
        await Promise.all([...inFlightWrites]);
      }
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

      const buffered = pendingMsgWrites.get(conversationId);
      if (buffered && buffered.principal === principal && buffered.messages) {
        return {
          messages: [...buffered.messages.rows],
          pagination: buffered.messages.pagination,
          latestTimestamp: computeLatestTimestamp(buffered.messages.rows),
          userMessages: buffered.userMessages
            ? [...buffered.userMessages]
            : undefined,
        } satisfies CachedConversation;
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
        if (
          buffered &&
          buffered.principal === principal &&
          buffered.userMessages
        ) {
          return {
            messages: result?.messages ?? [],
            pagination: result?.pagination,
            latestTimestamp: result?.latestTimestamp ?? 0,
            userMessages: [...buffered.userMessages],
          };
        }
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
      const prev = pendingMsgWrites.get(conversationId);
      pendingMsgWrites.set(conversationId, {
        principal,
        messages: { rows: messages, pagination },
        userMessages:
          prev?.principal === principal ? prev.userMessages : undefined,
      });
      scheduleMessagesFlush();
    },

    writeConversationUserMessages(conversationId, messages) {
      if (closed || hydrating) return;
      const principal = auth.current();
      if (principal === null) return;
      if (opfsMissing) {
        memory.writeConversationUserMessages(conversationId, messages);
        return;
      }
      const prev = pendingMsgWrites.get(conversationId);
      pendingMsgWrites.set(conversationId, {
        principal,
        messages: prev?.principal === principal ? prev.messages : undefined,
        userMessages: messages,
      });
      scheduleMessagesFlush();
    },

    async deleteInvalidatedDocDetails(ids, current, archive) {
      if (closed || !ids.length) return [];
      const owner = archive?.accountId ?? auth.current();
      if (!owner) return [];
      if (opfsMissing) {
        return (
          memory.deleteInvalidatedDocDetails?.(ids, current, archive) ?? []
        );
      }
      const restores = new Set<string>();
      if (archive) {
        try {
          for (const entry of await journal.loadOutbox()) {
            if (
              entry.action === "restoreArchivedDoc" &&
              (!entry.accountId || entry.accountId === archive.accountId) &&
              entry.ts >= archive.dispatchedAt &&
              typeof entry.args?.[0] === "string"
            ) {
              restores.add(entry.args[0]);
            }
          }
        } catch {}
      }
      if (closed || auth.current() !== owner) return [];
      const confirmed = ids.filter((id) => !restores.has(id) && current(id));
      if (!confirmed.length) return [];
      const epoch = connection.ensureActiveEpoch(owner, true);
      if (!epoch) return [];
      try {
        const deleted = await connection.send(
          epoch,
          owner,
          "deleteDocDetails",
          { ids: confirmed },
        );
        const known = knownIds.get("docDetails");
        const shadow = lastPersistedRows.get("docDetails");
        for (const id of deleted) {
          known?.delete(id);
          shadow?.delete(id);
        }
        return deleted;
      } catch (error) {
        if (opfsMissing) {
          return (
            memory.deleteInvalidatedDocDetails?.(ids, current, archive) ?? []
          );
        }
        handleWorkerError(epoch, error);
        return [];
      }
    },

    async purgeLocalCache(options) {
      const keep = options?.keepPendingInputFor ?? null;
      recordCacheEvent("purge", {
        engine: opfsMissing ? "memory" : "sqlite-worker",
        reason: options?.reason ?? "unspecified",
        keepPendingInputFor: keep,
        ...options?.detail,
      });
      clearPendingBuffers();
      knownIds.clear();
      lastPersistedRows.clear();
      lastPersistedMeta.clear();
      await memory.purgeLocalCache(options);
      if (!opfsMissing) connection.rotateForPurge(keep);
      await journal.purgeJournal(keep);
    },

    close() {
      if (closed) return;
      closed = true;
      clearPendingBuffers();
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
