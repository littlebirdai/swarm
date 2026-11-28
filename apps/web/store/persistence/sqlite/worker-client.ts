import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import {
  cacheEvictionsFor,
  timedDocCapsEnabled,
  withoutEvictionPatches,
} from "../../cache-eviction";
import { clearSnapshotDrops } from "../../idb-collection-diff";
import { bindWindowFlush } from "../db";
import { setHydrating as setPersistenceHydrating } from "../hydration";
import type { CacheStorage, CachedConversation } from "../storage";
import type { JournalBridge } from "./journal-bridge";
import {
  createMemoryCacheFallback,
  type MemoryCacheStorage,
} from "./memory-fallback";
import { hydratedEpochAfterLoad, rotatedEpochToRetry } from "./hydrated-epoch";
import {
  findArchiveRestores,
  findPendingArchives,
  stripPendingArchives,
} from "./doc-detail-archives";
import {
  buildFlushPayload,
  dropBatchDocDetails,
  journalKeys,
  recordKnownState,
  type PendingWriteBatch,
} from "./patch-payload";
import {
  epochId,
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

const BUFFER_FLUSH_MS = 250;
const BEST_EFFORT_FLUSH_MS = 150;

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
  const docDetailWorkspaces = new Map<string, string | undefined>();
  const inFlightWrites = new Set<Promise<void>>();

  let pendingBatch: PendingWriteBatch | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let hydratedEpoch: CacheEpoch | null = null;

  let closed = false;
  let hydrating = false;
  let opfsMissing = !opfsSupported() || !locks || !channelTransport;
  if (opfsMissing) onFallbackToMemory?.("opfs-unsupported");

  const syncDocDetailWorkspacesFromShadow = () => {
    const shadow = lastPersistedRows.get("docDetails");
    if (!shadow) return;
    for (const [id, row] of shadow) {
      const ws = (row as { workspace?: unknown } | undefined)?.workspace;
      docDetailWorkspaces.set(id, typeof ws === "string" ? ws : undefined);
    }
  };

  const resetShadowState = () => {
    knownIds.clear();
    lastPersistedRows.clear();
    lastPersistedMeta.clear();
    docDetailWorkspaces.clear();
  };

  const clearPendingBatch = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingBatch = null;
  };

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

  const rotateAfterLostWrite = (
    epoch: CacheEpoch,
    principal: string,
    code: string,
  ) => {
    const active = connection.activeEpoch();
    if (
      closed ||
      auth.current() !== principal ||
      !active ||
      epochId(active) !== epochId(epoch)
    )
      return;
    connection.handleEpochFailure(epoch, `flush-${code}`);
  };

  const ensurePendingBatch = (principal: string): PendingWriteBatch => {
    if (pendingBatch && pendingBatch.principal !== principal) {
      clearPendingBatch();
    }
    if (!pendingBatch) {
      pendingBatch = {
        principal,
        patches: [],
        state: {},
        evictions: new Map(),
        conversations: new Map(),
      };
    }
    return pendingBatch;
  };

  const flushBatchNow = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batch = pendingBatch;
    pendingBatch = null;
    if (!batch || closed || opfsMissing) {
      return Promise.resolve();
    }
    const principal = auth.current();
    if (principal === null || batch.principal !== principal) {
      return Promise.resolve();
    }
    const epoch = connection.ensureActiveEpoch(principal, true);
    if (!epoch) {
      return Promise.resolve();
    }
    const sentEpochId = epochId(epoch);
    const built = buildFlushPayload({
      batch,
      knownIds,
      writeSyncMeta:
        hydratedEpoch !== null && epochId(hydratedEpoch) === sentEpochId,
    });
    if (!built) {
      return Promise.resolve();
    }
    const promise = connection
      .send(epoch, principal, "flushBatch", built.payload)
      .then(() => {
        const current = connection.currentEpoch();
        if (
          closed ||
          opfsMissing ||
          auth.current() !== principal ||
          !current ||
          epochId(current) !== sentEpochId
        ) {
          return;
        }
        built.commitShadow(knownIds, lastPersistedRows, lastPersistedMeta);
        syncDocDetailWorkspacesFromShadow();
        for (const key of built.dropKeys) clearSnapshotDrops(key);
      })
      .catch((error) => {
        resetShadowState();
        if (opfsMissing) {
          if (closed || auth.current() !== principal) return;
          if (batch.patches.length) {
            memory.writePatches(batch.patches, batch.state);
          }
          for (const [conversationId, entry] of batch.conversations) {
            if (entry.messages) {
              memory.writeConversationMessages(
                conversationId,
                entry.messages.rows,
                entry.messages.pagination,
              );
            }
            if (entry.userMessages) {
              memory.writeConversationUserMessages(
                conversationId,
                entry.userMessages,
              );
            }
          }
          return;
        }
        if (
          error instanceof WorkerRpcError &&
          (error.code === "closed" || error.code === "timeout")
        ) {
          rotateAfterLostWrite(epoch, principal, error.code);
          return;
        }
        handleWorkerError(epoch, error);
      });
    trackWrite(promise);
    return promise;
  };

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
    onEpochChange: () => {
      resetShadowState();
    },
    onBeforeLockRelease: () => {
      void flushBatchNow();
    },
  });

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        void flushBatchNow();
      }, BUFFER_FLUSH_MS);
    }
  };

  const unbindWindowFlush = bindWindowFlush(() => {
    if (closed) return;
    const promise = flushBatchNow();
    void Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(resolve, BEST_EFFORT_FLUSH_MS)),
    ]);
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

      const wantsPendingArchives =
        principal !== null &&
        timedDocCapsEnabled() &&
        (!keys || keys.includes("docDetails"));

      if (opfsMissing) {
        const [memResult, journalResult, pendingArchives] = await Promise.all([
          memory.loadCache(keys, context),
          journal.loadJournalKeys(keys, context, principal),
          wantsPendingArchives ? findPendingArchives(journal, principal) : null,
        ]);
        const merged = { ...(memResult ?? {}), ...journalResult };
        const filtered = stripPendingArchives(
          Object.keys(merged).length ? merged : null,
          pendingArchives,
          docDetailWorkspaces,
        );
        return filtered;
      }

      if (principal === null) {
        connection.ensureActiveEpoch(null, false);
        await journal.loadJournalKeys(keys, context, null);
        return null;
      }

      const epoch = connection.ensureActiveEpoch(principal, true);
      const [journalResult, pendingArchives] = await Promise.all([
        journal.loadJournalKeys(keys, context, principal),
        wantsPendingArchives ? findPendingArchives(journal, principal) : null,
      ]);
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
      let target: CacheEpoch | null = epoch;
      for (let attempt = 0; target && attempt < 2; attempt++) {
        const sent: CacheEpoch = target;
        target = null;
        try {
          sqliteResult = await connection.send(sent, principal, "loadCache", {
            keys,
            context: sqliteContext,
          });
          hydratedEpoch = hydratedEpochAfterLoad(
            hydratedEpoch,
            sent,
            connection.activeEpoch(),
            keys,
          );
          recordKnownState(
            knownIds,
            lastPersistedRows,
            lastPersistedMeta,
            sqliteResult,
          );
          syncDocDetailWorkspacesFromShadow();
        } catch (error) {
          if (opfsMissing) {
            const memResult = await memory.loadCache(keys, context);
            const merged = { ...(memResult ?? {}), ...journalResult };
            return stripPendingArchives(
              Object.keys(merged).length ? merged : null,
              pendingArchives,
              docDetailWorkspaces,
            );
          }
          handleWorkerError(sent, error);
          sqliteResult = null;
          if (closed || auth.current() !== principal) break;
          if (attempt === 0)
            target = rotatedEpochToRetry(
              hydratedEpoch,
              sent,
              connection.activeEpoch(),
              keys,
            );
        }
      }
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      const merged = { ...(sqliteResult ?? {}), ...journalResult };
      return stripPendingArchives(
        Object.keys(merged).length ? merged : null,
        pendingArchives,
        docDetailWorkspaces,
      );
    },

    async loadPaintCache() {
      return null;
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

      const batch = ensurePendingBatch(principal);
      batch.patches.push(...patches);
      for (const patch of patches) {
        const root = patch.path[0];
        if (typeof root === "string" && Object.hasOwn(state, root)) {
          batch.state[root] = state[root];
        }
      }
      if (state.currentUser?._id) batch.state.currentUser = state.currentUser;
      if (state.pending !== undefined) batch.state.pending = state.pending;
      if (state.liveInboxIdList !== undefined)
        batch.state.liveInboxIdList = state.liveInboxIdList;
      if (state.lastFocusedConversationId !== undefined)
        batch.state.lastFocusedConversationId = state.lastFocusedConversationId;
      for (const row of evictions) {
        let set = batch.evictions.get(row.key);
        if (!set) batch.evictions.set(row.key, (set = new Set()));
        set.add(row.id);
      }
      scheduleFlush();
      return pendingWrite;
    },

    async flushPersistence() {
      flushBatchNow();
      while (inFlightWrites.size > 0) {
        await Promise.all([...inFlightWrites]);
      }
      await memory.flushPersistence();
    },

    async loadConversationMessages(conversationId) {
      if (closed) return null;
      if (opfsMissing) return memory.loadConversationMessages(conversationId);
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      if (principal === null) {
        connection.ensureActiveEpoch(null, false);
        return null;
      }

      const buffered =
        pendingBatch && pendingBatch.principal === principal
          ? pendingBatch.conversations.get(conversationId)
          : undefined;
      if (buffered?.messages) {
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
        if (buffered?.userMessages) {
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
      const batch = ensurePendingBatch(principal);
      const prev = batch.conversations.get(conversationId);
      batch.conversations.set(conversationId, {
        messages: { rows: messages, pagination },
        userMessages: prev?.userMessages,
      });
      scheduleFlush();
    },

    writeConversationUserMessages(conversationId, messages) {
      if (closed || hydrating) return;
      const principal = auth.current();
      if (principal === null) return;
      if (opfsMissing) {
        memory.writeConversationUserMessages(conversationId, messages);
        return;
      }
      const batch = ensurePendingBatch(principal);
      const prev = batch.conversations.get(conversationId);
      batch.conversations.set(conversationId, {
        messages: prev?.messages,
        userMessages: messages,
      });
      scheduleFlush();
    },

    async deleteInvalidatedDocDetails(ids, current, archive) {
      if (closed || !ids.length) return [];
      const owner = archive?.accountId ?? auth.current();
      if (!owner) return [];
      const restores = await findArchiveRestores(journal, archive);
      if (closed || auth.current() !== owner) return [];
      const confirmed = ids.filter((id) => !restores.has(id) && current(id));
      if (!confirmed.length) return [];
      if (pendingBatch?.principal === owner)
        dropBatchDocDetails(pendingBatch, confirmed);
      if (opfsMissing) {
        return memory.deleteInvalidatedDocDetails?.(confirmed, current) ?? [];
      }
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
          docDetailWorkspaces.delete(id);
        }
        return deleted;
      } catch (error) {
        if (opfsMissing) {
          if (closed || auth.current() !== owner) return [];
          return memory.deleteInvalidatedDocDetails?.(confirmed, current) ?? [];
        }
        if (
          error instanceof WorkerRpcError &&
          (error.code === "closed" || error.code === "timeout")
        ) {
          rotateAfterLostWrite(epoch, owner, error.code);
          return [];
        }
        handleWorkerError(epoch, error);
        return [];
      }
    },

    async readCachedDocDetails() {
      if (closed) return [];
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (closed || authEpoch !== auth.epoch() || auth.current() !== principal)
        return [];
      if (opfsMissing) return memory.readCachedDocDetails?.() ?? [];
      if (principal === null) {
        connection.ensureActiveEpoch(null, false);
        return [];
      }
      const epoch = connection.ensureActiveEpoch(principal, true);
      if (!epoch) return [];
      try {
        const refs = await connection.send(
          epoch,
          principal,
          "readDocDetailRefs",
          {},
        );
        if (
          closed ||
          authEpoch !== auth.epoch() ||
          auth.current() !== principal
        )
          return [];
        docDetailWorkspaces.clear();
        for (const ref of refs) docDetailWorkspaces.set(ref._id, ref.workspace);
        return refs;
      } catch (error) {
        if (opfsMissing) return memory.readCachedDocDetails?.() ?? [];
        handleWorkerError(epoch, error);
        return [];
      }
    },

    persistedDocDetailWorkspace(id) {
      if (opfsMissing) return memory.persistedDocDetailWorkspace?.(id);
      const row = lastPersistedRows.get("docDetails")?.get(id) as
        | { workspace?: unknown }
        | undefined;
      if (row)
        return typeof row.workspace === "string" ? row.workspace : undefined;
      return docDetailWorkspaces.get(id);
    },

    compactPersistedDocDetails(ids) {
      if (opfsMissing) {
        memory.compactPersistedDocDetails?.(ids);
        return;
      }
      const shadow = lastPersistedRows.get("docDetails");
      for (const id of ids) {
        const row = shadow?.get(id) as { workspace?: unknown } | undefined;
        const workspace =
          typeof row?.workspace === "string"
            ? row.workspace
            : docDetailWorkspaces.get(id);
        if (row && shadow) shadow.set(id, { _id: id, workspace });
        if (workspace !== undefined) docDetailWorkspaces.set(id, workspace);
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
      clearPendingBatch();
      resetShadowState();
      hydratedEpoch = null;
      await memory.purgeLocalCache(options);
      if (!opfsMissing) connection.rotateForPurge(keep);
      await journal.purgeJournal(keep);
    },

    close() {
      if (closed) return;
      unbindWindowFlush();
      connection.close();
      closed = true;
      clearPendingBatch();
      resetShadowState();
      hydratedEpoch = null;
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
