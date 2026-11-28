import { useSyncExternalStore } from "react";
import { useAuthPrincipal, authPrincipal } from "../lib/authPrincipal";
import {
  REPLICATED_STORE_KEYS,
  type ClientSyncStoreKey,
} from "../store/clientSyncRegistry";
import {
  HYDRATION_ON_READ_KEYS,
  deferredCacheReadsEnabled,
  deferredDocEdit,
  deferredSharedCacheSource,
  subscribeDeferredSharedCache,
} from "../store/deferred-cache-policy";
import { detailInvalidationRevision } from "../store/doc-detail-cache";
import { cacheStorage } from "../store/idb-cache";
import { useInboxStore } from "../store/inboxStore";
import { revokedOnDisk } from "../store/scope-revocation-disk";
import { useWatchEffect } from "./useWatchEffect";

const deferred = {
  epoch: -1,
  reads: new Set<string>(),
  complete: new Set<string>(),
  listeners: new Set<() => void>(),
};

function subscribe(listener: () => void) {
  deferred.listeners.add(listener);
  return () => deferred.listeners.delete(listener);
}

function applyDeferredRows(
  key: ClientSyncStoreKey,
  fromDisk: Record<string, any>,
) {
  const state = useInboxStore.getState();
  const live = state[key as keyof typeof state] as Record<string, unknown>;
  const rows = Object.entries(fromDisk).flatMap(([id, row]) => {
    if (live?.[id]) return [];
    if (key !== "docDetails") return [row];
    const edit = deferredDocEdit(id);
    const thin = state.docs[id] as Record<string, unknown> | undefined;
    if (
      edit?.block === "denied" ||
      (edit?.block === "archive" && !thin) ||
      detailInvalidationRevision(id) !== 0 ||
      state.pending[`docs:${id}`]?.type === "exclude" ||
      thin?.archived_at != null
    )
      return [];
    if (!edit?.fields.length) return [row];
    if (!thin) return [];
    const fields = Object.fromEntries(
      edit.fields.flatMap((field) =>
        thin[field] === undefined ? [] : [[field, thin[field]]],
      ),
    );
    return [
      {
        ...row,
        ...fields,
        updated_at: Math.max(row.updated_at ?? 0, Number(thin.updated_at ?? 0)),
      },
    ];
  });
  if (rows.length) state.syncTable(key, rows, { isDelta: true });
}

export function useDeferredCache(
  key: ClientSyncStoreKey,
  wanted = true,
): boolean {
  const { principalId, epoch } = useAuthPrincipal();
  const source = useSyncExternalStore(
    subscribeDeferredSharedCache,
    deferredSharedCacheSource,
    () => "disk" as const,
  );
  const complete = useSyncExternalStore(
    subscribe,
    () => deferred.epoch === epoch && deferred.complete.has(key),
    () => false,
  );
  const enabled =
    wanted &&
    !!principalId &&
    deferredCacheReadsEnabled() &&
    HYDRATION_ON_READ_KEYS.has(key);
  const shared = REPLICATED_STORE_KEYS.includes(key);
  const readFromDisk = enabled && (!shared || source === "disk");

  useWatchEffect(() => {
    if (!readFromDisk) return;
    if (deferred.epoch !== epoch) {
      deferred.epoch = epoch;
      deferred.reads.clear();
      deferred.complete.clear();
    }
    if (deferred.reads.has(key)) return;
    deferred.reads.add(key);

    const pending = useInboxStore.getState().pending;
    void cacheStorage
      .loadCache([key], { pending, revokedOnDisk })
      .then((cached) => {
        if (
          authPrincipal.epoch() === epoch &&
          (!shared || deferredSharedCacheSource() === "disk") &&
          cached?.[key]
        )
          applyDeferredRows(key, cached[key]);
      })
      .catch(() => {})
      .finally(() => {
        if (authPrincipal.epoch() !== epoch) return;
        if (shared && deferredSharedCacheSource() !== "disk") {
          deferred.reads.delete(key);
        } else {
          deferred.complete.add(key);
        }
        for (const listener of deferred.listeners) listener();
      });
  }, [key, epoch, readFromDisk, shared]);

  return !enabled || (shared && source === "replica") || complete;
}
