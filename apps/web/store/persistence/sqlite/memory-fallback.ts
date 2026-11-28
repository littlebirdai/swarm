import type { AuthPrincipalTracker } from "@platform/auth/web";
import type { Patch } from "mutative";
import { timedDocCapsEnabled } from "../../cache-eviction";
import {
  COLLECTION_RETENTION,
  partitionDocDetailRetention,
  partitionSessionRetention,
  pendingDocDetailIds,
  persistedMessageTail,
} from "../../cacheRetention";
import { isDetailPinned } from "../../../lib/detail-rows";
import {
  collectionRowHydrator,
  collectionRowValidator,
  WEB_COLLECTION_INDEXES,
} from "../../clientSyncRegistry";
import {
  clearSnapshotDrops,
  deleteAllowed,
  hasSnapshotDrops,
  patchedIds,
} from "../../idb-collection-diff";
import { META_KEYS } from "../schema";
import type {
  CachedConversation,
  CachedDocDetailRef,
  CacheStorage,
} from "../storage";

const journalKeys = new Set(["pending", "pendingMessages", "queuedMessages"]);
const metaKeys = new Set([...META_KEYS].filter((key) => !journalKeys.has(key)));

export type MemoryCacheStorage = Omit<
  CacheStorage,
  | "enqueueDispatch"
  | "removeDispatch"
  | "loadOutbox"
  | "outboxAccountId"
  | "persistPendingMessageChanges"
  | "loadPaintCache"
  | "loadPaintCacheSync"
>;

function paginationRecord(
  pagination: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof pagination !== "object" ||
    pagination === null ||
    Array.isArray(pagination)
  )
    return undefined;
  return Object.fromEntries(Object.entries(pagination));
}

export function createMemoryCacheFallback(
  auth: Pick<AuthPrincipalTracker, "current" | "resolve" | "epoch">,
): MemoryCacheStorage {
  let boundOwner: string | null = null;
  let hydrating = false;
  let meta = new Map<string, unknown>();
  let collections = new Map<string, Map<string, Record<string, unknown>>>();
  let conversations = new Map<string, CachedConversation>();

  function clear(nextOwner: string | null) {
    meta = new Map();
    collections = new Map();
    conversations = new Map();
    boundOwner = nextOwner;
  }

  function ensureOwner(principal: string | null): boolean {
    if (principal === null) return false;
    if (boundOwner !== null && boundOwner !== principal) {
      clear(principal);
      return false;
    }
    boundOwner = principal;
    return true;
  }

  function loadKeys(
    keys: readonly string[] | undefined,
    context: Record<string, unknown>,
  ): Record<string, any> | null {
    const result: Record<string, any> = {};
    for (const key of keys ?? metaKeys) {
      if (!metaKeys.has(key)) continue;
      if (meta.has(key)) result[key] = meta.get(key);
    }
    const now = Date.now();
    const rawLive = meta.get("liveInboxIdList");
    const rawFocus = meta.get("lastFocusedConversationId");
    const live = (rawLive === undefined ? context.liveInboxIdList : rawLive) as
      | string[]
      | undefined;
    const focus = (
      rawFocus === undefined ? context.lastFocusedConversationId : rawFocus
    ) as string | undefined;
    for (const key of keys ?? Object.keys(WEB_COLLECTION_INDEXES)) {
      if (!Object.hasOwn(WEB_COLLECTION_INDEXES, key)) continue;
      const map = collections.get(key);
      if (!map || map.size === 0) continue;
      const valid = collectionRowValidator(key);
      const rows: Array<Record<string, any>> = [];
      for (const [id, row] of map) {
        if (valid && !valid(row)) {
          map.delete(id);
          continue;
        }
        rows.push(row);
      }
      if (!rows.length) continue;
      const memoryOnlyDocDetails =
        key === "docDetails" && timedDocCapsEnabled();
      const protectedIds = memoryOnlyDocDetails
        ? (() => {
            const ids = pendingDocDetailIds(
              (context.pending as Record<string, unknown> | undefined) ?? {},
            );
            for (const row of rows) {
              if (isDetailPinned("docDetails", row._id)) ids.add(row._id);
            }
            return ids;
          })()
        : undefined;
      const retained =
        key === "sessions" || key === "conversations"
          ? partitionSessionRetention(rows, live, focus, now)
          : memoryOnlyDocDetails
            ? partitionDocDetailRetention(rows, now, protectedIds)
            : COLLECTION_RETENTION[key]?.(rows, now);
      if (!memoryOnlyDocDetails && retained?.drop.length) {
        for (const id of retained.drop) map.delete(id);
      }
      const hydrate = collectionRowHydrator(key);
      const hydrateCtx = {
        pending: (context.pending as Record<string, any> | undefined) ?? {},
      };
      const kept = (retained?.keep ?? rows).map((row) => {
        const value = hydrate ? hydrate(row, hydrateCtx) : row;
        if (value !== row) map.set(row._id, value);
        return value;
      });
      if (
        kept.length ||
        (key === "conversations" && retained?.keep.length === 0)
      )
        result[key] = Object.fromEntries(kept.map((row) => [row._id, row]));
    }
    return Object.keys(result).length ? result : null;
  }

  return {
    async loadCache(keys, context = {}) {
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      if (!ensureOwner(principal)) return null;
      return loadKeys(keys, context);
    },
    setHydrating(value) {
      hydrating = value;
    },
    writePatches(patches: Patch[], state: Record<string, any>) {
      if (hydrating) return;
      const principal = auth.current();
      const stateOwner = state.currentUser?._id;
      if (
        principal === null ||
        (boundOwner !== null && boundOwner !== principal) ||
        (stateOwner !== undefined && stateOwner !== principal)
      )
        return;
      boundOwner = principal;
      const keys = new Set(
        patches.flatMap(({ path }) => (path.length ? [String(path[0])] : [])),
      );
      for (const key of keys) {
        if (Object.hasOwn(WEB_COLLECTION_INDEXES, key)) {
          const data = state[key];
          if (!data || typeof data !== "object") continue;
          let map = collections.get(key);
          if (!map) collections.set(key, (map = new Map()));
          const pending = state.pending ?? {};
          const snapshot = hasSnapshotDrops(key);
          const ids = snapshot ? null : patchedIds(patches, key);
          const affected =
            ids ?? new Set([...Object.keys(data), ...map.keys()]);
          for (const id of affected) {
            const row = Object.hasOwn(data, id) ? data[id] : undefined;
            if (row != null) map.set(id, row);
            else if (deleteAllowed(key, id, pending)) map.delete(id);
          }
          if (snapshot) clearSnapshotDrops(key);
        } else if (metaKeys.has(key)) {
          if (state[key] === undefined) meta.delete(key);
          else meta.set(key, state[key]);
        }
      }
    },
    flushPersistence: () => Promise.resolve(),
    async loadConversationMessages(conversationId) {
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      if (!ensureOwner(principal)) return null;
      return conversations.get(conversationId) ?? null;
    },
    writeConversationMessages(conversationId, messages, pagination) {
      if (hydrating) return;
      const principal = auth.current();
      if (
        principal === null ||
        (boundOwner !== null && boundOwner !== principal)
      )
        return;
      boundOwner = principal;
      const prev = conversations.get(conversationId);
      const tail = persistedMessageTail(
        messages as any[],
        paginationRecord(pagination),
      );
      const latestTimestamp = (
        tail.messages as Array<{ timestamp?: number }>
      ).reduce(
        (max, m) =>
          typeof m?.timestamp === "number" && Number.isFinite(m.timestamp)
            ? Math.max(max, m.timestamp)
            : max,
        0,
      );
      conversations.set(conversationId, {
        messages: tail.messages,
        pagination: tail.pagination,
        latestTimestamp,
        userMessages: prev?.userMessages,
      });
    },
    writeConversationUserMessages(conversationId, userMessages) {
      if (hydrating) return;
      const principal = auth.current();
      if (
        principal === null ||
        (boundOwner !== null && boundOwner !== principal)
      )
        return;
      boundOwner = principal;
      const prev = conversations.get(conversationId);
      conversations.set(conversationId, {
        messages: prev?.messages ?? [],
        pagination: prev?.pagination,
        latestTimestamp: prev?.latestTimestamp ?? 0,
        userMessages: userMessages as any[],
      });
    },
    async deleteInvalidatedDocDetails(ids, current) {
      const principal = auth.current();
      if (
        principal === null ||
        (boundOwner !== null && boundOwner !== principal)
      )
        return [];
      boundOwner = principal;
      const map = collections.get("docDetails");
      const deleted: string[] = [];
      for (const id of ids) {
        if (!current(id)) continue;
        map?.delete(id);
        deleted.push(id);
      }
      return deleted;
    },
    async readCachedDocDetails() {
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (authEpoch !== auth.epoch() || auth.current() !== principal) return [];
      if (!ensureOwner(principal)) return [];
      const map = collections.get("docDetails");
      if (!map) return [];
      const refs: CachedDocDetailRef[] = [];
      for (const [id, row] of map) {
        refs.push({
          _id: id,
          workspace:
            typeof row.workspace === "string" ? row.workspace : undefined,
          cachedAt:
            typeof row._cachedAt === "number" && Number.isFinite(row._cachedAt)
              ? row._cachedAt
              : null,
        });
      }
      return refs.sort((a, b) => {
        if (a.cachedAt == null && b.cachedAt == null) return 0;
        if (a.cachedAt == null) return -1;
        if (b.cachedAt == null) return 1;
        return a.cachedAt - b.cachedAt;
      });
    },
    persistedDocDetailWorkspace(id) {
      const row = collections.get("docDetails")?.get(id);
      return typeof row?.workspace === "string" ? row.workspace : undefined;
    },
    compactPersistedDocDetails() {},
    async purgeLocalCache(options) {
      clear(options?.keepPendingInputFor ?? null);
    },
  };
}
