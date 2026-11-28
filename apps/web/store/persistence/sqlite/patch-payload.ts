import type { Patch } from "mutative";
import { WEB_COLLECTION_INDEXES } from "../../clientSyncRegistry";
import {
  clearSnapshotDrops,
  deleteAllowed,
  hasSnapshotDrops,
  patchedIds,
} from "../../idb-collection-diff";
import { META_KEYS } from "../schema";
import type { SqliteWritePatchPayload } from "./protocol";

export const journalKeys = new Set([
  "pending",
  "pendingMessages",
  "queuedMessages",
]);
export const metaKeys = new Set(
  [...META_KEYS].filter((key) => !journalKeys.has(key)),
);

export function recordKnownRows(
  knownIds: Map<string, Set<string>>,
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
      for (const id of Object.keys(value)) ids.add(id);
    }
  }
}

export function buildWritePayload(
  knownIds: Map<string, Set<string>>,
  patches: Patch[],
  state: Record<string, any>,
): SqliteWritePatchPayload | null {
  const filteredPatches = patches.filter(
    ({ path }) => path.length > 0 && !journalKeys.has(String(path[0])),
  );
  if (!filteredPatches.length) return null;

  const keys = new Set(filteredPatches.map(({ path }) => String(path[0])));
  const slice: Record<string, unknown> = {};
  if (state.currentUser?._id)
    slice.currentUser = { _id: state.currentUser._id };
  const snapshotDrops: Record<string, string[]> = {};
  const statePending = (state.pending ?? {}) as Record<
    string,
    { type?: string }
  >;
  const pendingSubset: Record<string, { type?: string }> = {};
  let hasPendingSubset = false;

  for (const key of keys) {
    if (Object.hasOwn(WEB_COLLECTION_INDEXES, key)) {
      const data = state[key];
      if (!data || typeof data !== "object") continue;
      let known = knownIds.get(key);
      if (!known) knownIds.set(key, (known = new Set()));
      const hasDrops = hasSnapshotDrops(key);
      if (hasDrops) {
        const drops: string[] = [];
        for (const id of known) {
          if (!Object.hasOwn(data, id) && deleteAllowed(key, id, {}))
            drops.push(id);
        }
        if (drops.length) snapshotDrops[key] = drops;
        clearSnapshotDrops(key);
      }
      const ids = hasDrops ? null : patchedIds(filteredPatches, key);
      if (ids === null) {
        slice[key] = { ...data };
        knownIds.set(key, new Set(Object.keys(data)));
      } else {
        const partial: Record<string, unknown> = {};
        for (const id of ids) {
          if (Object.hasOwn(data, id) && data[id] != null) {
            partial[id] = data[id];
            known.add(id);
          } else {
            known.delete(id);
          }
        }
        slice[key] = partial;
      }
      const prefix = `${key}:`;
      for (const [pendingKey, entry] of Object.entries(statePending)) {
        if (pendingKey.startsWith(prefix)) {
          pendingSubset[pendingKey] = entry;
          hasPendingSubset = true;
        }
      }
      if (key === "conversations") {
        if (state.liveInboxIdList !== undefined)
          slice.liveInboxIdList = state.liveInboxIdList;
        if (state.lastFocusedConversationId !== undefined)
          slice.lastFocusedConversationId = state.lastFocusedConversationId;
      }
    } else if (metaKeys.has(key) || key === "syncMeta") {
      slice[key] = state[key];
    }
  }
  if (hasPendingSubset) slice.pending = pendingSubset;
  return {
    patches: filteredPatches,
    state: slice,
    snapshotDrops,
  };
}
