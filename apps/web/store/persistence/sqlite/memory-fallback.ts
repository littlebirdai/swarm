import type { AuthPrincipalTracker } from "@platform/auth/web";
import type { Patch } from "mutative";
import {
  COLLECTION_RETENTION,
  partitionSessionRetention,
} from "../../cacheRetention";
import {
  HYDRATION_PAINT_KEYS,
  WEB_COLLECTION_INDEXES,
} from "../../clientSyncRegistry";
import {
  clearSnapshotDrops,
  deleteAllowed,
  hasSnapshotDrops,
  patchedIds,
} from "../../idb-collection-diff";
import { META_KEYS } from "../schema";
import type { CachedConversation, CacheStorage } from "../storage";

const journalKeys = new Set(["pending", "pendingMessages", "queuedMessages"]);
const metaKeys = new Set([...META_KEYS].filter((key) => !journalKeys.has(key)));

export type MemoryCacheStorage = Omit<
  CacheStorage,
  | "enqueueDispatch"
  | "removeDispatch"
  | "loadOutbox"
  | "outboxAccountId"
  | "persistPendingMessageChanges"
  | "loadPaintCacheSync"
>;

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
      const rows = [...map.values()] as Array<Record<string, any>>;
      const retained =
        key === "sessions" || key === "conversations"
          ? partitionSessionRetention(rows, live, focus, now)
          : COLLECTION_RETENTION[key]?.(rows, now);
      const kept = retained?.keep ?? rows;
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
    async loadPaintCache() {
      const authEpoch = auth.epoch();
      const principal = await auth.resolve();
      if (authEpoch !== auth.epoch() || auth.current() !== principal)
        return null;
      if (!ensureOwner(principal)) return null;
      return loadKeys(HYDRATION_PAINT_KEYS, {});
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
      const latestTimestamp = (
        messages as Array<{ timestamp?: number }>
      ).reduce(
        (max, m) =>
          typeof m?.timestamp === "number" && Number.isFinite(m.timestamp)
            ? Math.max(max, m.timestamp)
            : max,
        0,
      );
      conversations.set(conversationId, {
        messages: messages as any[],
        pagination,
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
    async purgeLocalCache(options) {
      clear(options?.keepPendingInputFor ?? null);
    },
  };
}
