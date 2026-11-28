import type { Patch } from "mutative";
import { WEB_COLLECTION_INDEXES } from "../../clientSyncRegistry";
import {
  deleteAllowed,
  hasSnapshotDrops,
  patchedIds,
  snapshotDropsFor,
} from "../../idb-collection-diff";
import { META_KEYS } from "../schema";
import type {
  SqliteFlushBatchPayload,
  SqliteFlushConversation,
} from "./protocol";

export const journalKeys = new Set([
  "pending",
  "pendingMessages",
  "queuedMessages",
]);
export const metaKeys = new Set(
  [...META_KEYS].filter((key) => !journalKeys.has(key)),
);

export type PendingWriteBatch = {
  principal: string;
  patches: Patch[];
  state: Record<string, any>;
  evictions: Map<string, Set<string>>;
  conversations: Map<
    string,
    {
      messages?: { rows: unknown[]; pagination: unknown };
      userMessages?: unknown[];
    }
  >;
};

export function recordKnownState(
  knownIds: Map<string, Set<string>>,
  lastPersistedRows: Map<string, Map<string, unknown>>,
  lastPersistedMeta: Map<string, unknown>,
  loaded: Record<string, any> | null,
): void {
  if (!loaded) return;
  for (const [key, value] of Object.entries(loaded)) {
    if (
      Object.hasOwn(WEB_COLLECTION_INDEXES, key) &&
      value &&
      typeof value === "object"
    ) {
      let ids = knownIds.get(key);
      if (!ids) knownIds.set(key, (ids = new Set()));
      let shadow = lastPersistedRows.get(key);
      if (!shadow) lastPersistedRows.set(key, (shadow = new Map()));
      for (const [id, row] of Object.entries(value)) {
        ids.add(id);
        shadow.set(id, row);
      }
    } else if (metaKeys.has(key)) {
      lastPersistedMeta.set(key, value);
    }
  }
}

export function buildFlushPayload(params: {
  batch: PendingWriteBatch;
  knownIds: Map<string, Set<string>>;
  writeSyncMeta: boolean;
}): {
  payload: SqliteFlushBatchPayload;
  dropKeys: string[];
  commitShadow: (
    knownIds: Map<string, Set<string>>,
    lastPersistedRows: Map<string, Map<string, unknown>>,
    lastPersistedMeta: Map<string, unknown>,
  ) => void;
} | null {
  const { batch, knownIds, writeSyncMeta } = params;
  const filteredPatches = batch.patches.filter(
    ({ path }) =>
      path.length > 0 &&
      !journalKeys.has(String(path[0])) &&
      (writeSyncMeta || path[0] !== "syncMeta"),
  );

  const slice: Record<string, unknown> = {};
  if (batch.state.currentUser?._id)
    slice.currentUser = { _id: batch.state.currentUser._id };
  const snapshotDrops: Record<string, string[]> = {};
  const evictionsRecord: Record<string, string[]> = {};
  const dropKeys: string[] = [];
  const statePending = (batch.state.pending ?? {}) as Record<
    string,
    { type?: string }
  >;
  const pendingSubset: Record<string, { type?: string }> = {};
  let hasPendingSubset = false;
  let hasCollectionOrMeta = false;

  const stagedRows = new Map<
    string,
    { replaceAll: boolean; entries: Map<string, unknown | undefined> }
  >();
  const stagedMeta = new Map<string, unknown>();

  const keys = new Set(filteredPatches.map(({ path }) => String(path[0])));
  for (const key of keys) {
    if (Object.hasOwn(WEB_COLLECTION_INDEXES, key)) {
      const data = batch.state[key];
      if (!data || typeof data !== "object") continue;
      hasCollectionOrMeta = true;
      const evicted = batch.evictions.get(key);
      if (evicted?.size) evictionsRecord[key] = [...evicted];

      const hasDrops = hasSnapshotDrops(key);
      if (hasDrops) {
        const dropSet = new Set<string>();
        const activeDrops = snapshotDropsFor(key);
        if (activeDrops) {
          for (const id of activeDrops) {
            if (!Object.hasOwn(data, id) && !evicted?.has(id)) dropSet.add(id);
          }
        }
        const known = knownIds.get(key);
        if (known) {
          for (const id of known) {
            if (
              !Object.hasOwn(data, id) &&
              !evicted?.has(id) &&
              deleteAllowed(key, id, {})
            )
              dropSet.add(id);
          }
        }
        if (dropSet.size) snapshotDrops[key] = [...dropSet];
        dropKeys.push(key);
      }

      const ids = hasDrops ? null : patchedIds(filteredPatches, key);
      if (ids === null) {
        slice[key] = { ...data };
        const entries = new Map<string, unknown | undefined>();
        for (const [id, row] of Object.entries(data)) entries.set(id, row);
        stagedRows.set(key, { replaceAll: true, entries });
      } else {
        const partial: Record<string, unknown> = {};
        const entries = new Map<string, unknown | undefined>();
        for (const id of ids) {
          if (Object.hasOwn(data, id) && data[id] != null) {
            partial[id] = data[id];
            entries.set(id, data[id]);
          } else if (!evicted?.has(id)) {
            entries.set(id, undefined);
          }
        }
        slice[key] = partial;
        stagedRows.set(key, { replaceAll: false, entries });
      }

      const prefix = `${key}:`;
      for (const [pendingKey, entry] of Object.entries(statePending)) {
        if (pendingKey.startsWith(prefix)) {
          pendingSubset[pendingKey] = entry;
          hasPendingSubset = true;
        }
      }
      if (key === "conversations") {
        if (batch.state.liveInboxIdList !== undefined) {
          slice.liveInboxIdList = batch.state.liveInboxIdList;
          stagedMeta.set("liveInboxIdList", batch.state.liveInboxIdList);
        }
        if (batch.state.lastFocusedConversationId !== undefined) {
          slice.lastFocusedConversationId =
            batch.state.lastFocusedConversationId;
          stagedMeta.set(
            "lastFocusedConversationId",
            batch.state.lastFocusedConversationId,
          );
        }
      }
    } else if (metaKeys.has(key) || key === "syncMeta") {
      hasCollectionOrMeta = true;
      slice[key] = batch.state[key];
      stagedMeta.set(key, batch.state[key]);
    }
  }

  if (hasPendingSubset) slice.pending = pendingSubset;

  const conversations: SqliteFlushConversation[] = [];
  for (const [conversationId, entry] of batch.conversations) {
    if (!entry.messages && !entry.userMessages) continue;
    conversations.push({
      conversationId,
      ...(entry.messages ? { messages: entry.messages } : {}),
      ...(entry.userMessages ? { userMessages: entry.userMessages } : {}),
    });
  }

  if (!hasCollectionOrMeta && !conversations.length) return null;

  const payload: SqliteFlushBatchPayload = {
    ...(hasCollectionOrMeta
      ? {
          patches: filteredPatches,
          state: slice,
          snapshotDrops,
          ...(Object.keys(evictionsRecord).length
            ? { evictions: evictionsRecord }
            : {}),
        }
      : {}),
    ...(conversations.length ? { conversations } : {}),
  };

  const commitShadow = (
    targetKnown: Map<string, Set<string>>,
    targetRows: Map<string, Map<string, unknown>>,
    targetMeta: Map<string, unknown>,
  ) => {
    for (const [key, update] of stagedRows) {
      if (update.replaceAll) {
        const nextIds = new Set<string>();
        const nextShadow = new Map<string, unknown>();
        for (const [id, row] of update.entries) {
          if (row != null) {
            nextIds.add(id);
            nextShadow.set(id, row);
          }
        }
        targetKnown.set(key, nextIds);
        targetRows.set(key, nextShadow);
      } else {
        let known = targetKnown.get(key);
        if (!known) targetKnown.set(key, (known = new Set()));
        let shadow = targetRows.get(key);
        if (!shadow) targetRows.set(key, (shadow = new Map()));
        for (const [id, row] of update.entries) {
          if (row != null) {
            known.add(id);
            shadow.set(id, row);
          } else {
            known.delete(id);
            shadow.delete(id);
          }
        }
      }
    }
    for (const [key, val] of stagedMeta) targetMeta.set(key, val);
  };

  return { payload, dropKeys, commitShadow };
}
