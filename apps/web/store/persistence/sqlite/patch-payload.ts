import type { Patch } from "mutative";
import {
  COLLECTION_LIVE_FIELDS,
  WEB_COLLECTION_INDEXES,
} from "../../clientSyncRegistry";
import {
  deleteAllowed,
  hasSnapshotDrops,
  patchedIds,
} from "../../idb-collection-diff";
import {
  classifyMetaLiveChange,
  onlyLiveFieldsChanged,
} from "../idb-liveness-lane";
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

export type BuiltWritePayload = {
  payload: SqliteWritePatchPayload;
  dropKeys: string[];
  heldMetaKeys: Array<{ key: string; value: unknown }>;
  livenessRowsHeld: Map<string, Set<string>>;
  livenessMetaHeld: Set<string>;
  holdSyncMeta: boolean;
  durableWritten: boolean;
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

export function buildWritePayload(params: {
  knownIds: Map<string, Set<string>>;
  lastPersistedRows: Map<string, Map<string, unknown>>;
  lastPersistedMeta: Map<string, unknown>;
  patches: Patch[];
  state: Record<string, any>;
}): {
  immediate: SqliteWritePatchPayload | null;
  dropKeys: string[];
  bufferedMeta: Map<string, unknown>;
  heldLivenessRows: Map<string, Set<string>>;
  heldLivenessMeta: Set<string>;
  holdSyncMeta: boolean;
  flushedDurableLivenessRows: Map<string, Set<string>>;
} | null {
  const { knownIds, lastPersistedRows, lastPersistedMeta, patches, state } =
    params;
  const filteredPatches = patches.filter(
    ({ path }) => path.length > 0 && !journalKeys.has(String(path[0])),
  );
  if (!filteredPatches.length) return null;

  const keys = new Set(filteredPatches.map(({ path }) => String(path[0])));
  const slice: Record<string, unknown> = {};
  if (state.currentUser?._id)
    slice.currentUser = { _id: state.currentUser._id };
  const snapshotDrops: Record<string, string[]> = {};
  const dropKeys: string[] = [];
  const statePending = (state.pending ?? {}) as Record<
    string,
    { type?: string }
  >;
  const pendingSubset: Record<string, { type?: string }> = {};
  let hasPendingSubset = false;
  let hasImmediateWork = false;
  let hasDurableCollectionOrMeta = false;
  let wantsSyncMeta = false;

  const bufferedMeta = new Map<string, unknown>();
  const heldLivenessRows = new Map<string, Set<string>>();
  const heldLivenessMeta = new Set<string>();
  const flushedDurableLivenessRows = new Map<string, Set<string>>();
  const immediatePatches: Patch[] = [];

  for (const key of keys) {
    if (Object.hasOwn(WEB_COLLECTION_INDEXES, key)) {
      const data = state[key];
      if (!data || typeof data !== "object") continue;
      let known = knownIds.get(key);
      if (!known) knownIds.set(key, (known = new Set()));
      let shadow = lastPersistedRows.get(key);
      if (!shadow) lastPersistedRows.set(key, (shadow = new Map()));

      const hasDrops = hasSnapshotDrops(key);
      if (hasDrops) {
        const drops: string[] = [];
        for (const id of known) {
          if (!Object.hasOwn(data, id) && deleteAllowed(key, id, {}))
            drops.push(id);
        }
        if (drops.length) snapshotDrops[key] = drops;
        dropKeys.push(key);
      }

      const ids = hasDrops ? null : patchedIds(filteredPatches, key);
      const live = COLLECTION_LIVE_FIELDS[key];
      if (ids === null) {
        slice[key] = { ...data };
        knownIds.set(key, new Set(Object.keys(data)));
        const nextShadow = new Map<string, unknown>();
        for (const [id, row] of Object.entries(data)) nextShadow.set(id, row);
        lastPersistedRows.set(key, nextShadow);
        flushedDurableLivenessRows.set(key, new Set(Object.keys(data)));
        hasImmediateWork = true;
        hasDurableCollectionOrMeta = true;
        for (const p of filteredPatches) {
          if (String(p.path[0]) === key) immediatePatches.push(p);
        }
      } else {
        const partial: Record<string, unknown> = {};
        const durableIds = new Set<string>();
        for (const id of ids) {
          const nextRow = Object.hasOwn(data, id) ? data[id] : undefined;
          if (nextRow != null) {
            const prevRow = shadow.get(id);
            if (
              live &&
              prevRow &&
              onlyLiveFieldsChanged(prevRow, nextRow, live)
            ) {
              let waiting = heldLivenessRows.get(key);
              if (!waiting) heldLivenessRows.set(key, (waiting = new Set()));
              waiting.add(id);
              continue;
            }
            partial[id] = nextRow;
            known.add(id);
            shadow.set(id, nextRow);
            durableIds.add(id);
          } else {
            known.delete(id);
            shadow.delete(id);
            durableIds.add(id);
          }
        }
        if (durableIds.size > 0) {
          flushedDurableLivenessRows.set(key, durableIds);
          slice[key] = partial;
          hasImmediateWork = true;
          hasDurableCollectionOrMeta = true;
          for (const p of filteredPatches) {
            if (
              String(p.path[0]) === key &&
              (p.path.length < 2 || durableIds.has(String(p.path[1])))
            ) {
              immediatePatches.push(p);
            }
          }
        }
      }

      if (hasImmediateWork) {
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
      }
    } else if (key === "syncMeta") {
      wantsSyncMeta = true;
    } else if (metaKeys.has(key)) {
      const value = state[key];
      const hasPrev = lastPersistedMeta.has(key);
      if (hasPrev) {
        const kind = classifyMetaLiveChange(
          key,
          lastPersistedMeta.get(key),
          value,
        );
        if (kind === "same") continue;
        if (kind === "live") {
          heldLivenessMeta.add(key);
          continue;
        }
      }
      lastPersistedMeta.set(key, value);
      bufferedMeta.set(key, value);
      hasDurableCollectionOrMeta = true;
    }
  }

  let holdSyncMeta = false;
  if (wantsSyncMeta) {
    if (
      !hasDurableCollectionOrMeta &&
      (heldLivenessRows.size > 0 || heldLivenessMeta.size > 0)
    ) {
      holdSyncMeta = true;
    } else {
      slice.syncMeta = state.syncMeta;
      hasImmediateWork = true;
      for (const p of filteredPatches) {
        if (String(p.path[0]) === "syncMeta") immediatePatches.push(p);
      }
    }
  }

  if (hasPendingSubset) slice.pending = pendingSubset;

  return {
    immediate: hasImmediateWork
      ? {
          patches: immediatePatches,
          state: slice,
          snapshotDrops,
        }
      : null,
    dropKeys,
    bufferedMeta,
    heldLivenessRows,
    heldLivenessMeta,
    holdSyncMeta,
    flushedDurableLivenessRows,
  };
}
