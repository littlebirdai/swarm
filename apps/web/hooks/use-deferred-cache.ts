import { useAuthPrincipal, authPrincipal } from "../lib/authPrincipal";
import type { ClientSyncStoreKey } from "../store/clientSyncRegistry";
import {
  HYDRATION_ON_READ_KEYS,
  deferredCacheReadsEnabled,
} from "../store/deferred-cache-policy";
import { detailInvalidationRevision } from "../store/doc-detail-cache";
import { cacheStorage } from "../store/idb-cache";
import { hydrateMergeValue } from "../store/inbox-hydration";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";

const deferred = {
  epoch: -1,
  reads: new Map<string, Promise<void>>(),
  deniedDocs: new Set<string>(),
};

function forEpoch(epoch: number) {
  if (deferred.epoch !== epoch) {
    deferred.epoch = epoch;
    deferred.reads.clear();
    deferred.deniedDocs.clear();
  }
  return deferred;
}

export function denyDeferredDoc(id: string): void {
  if (deferredCacheReadsEnabled())
    forEpoch(authPrincipal.epoch()).deniedDocs.add(id);
}

export function deferredCacheRead(
  key: ClientSyncStoreKey,
): Promise<void> | undefined {
  return forEpoch(authPrincipal.epoch()).reads.get(key);
}

export function useDeferredCache(key: ClientSyncStoreKey, wanted = true): void {
  const { principalId, epoch } = useAuthPrincipal();
  useWatchEffect(() => {
    if (
      !wanted ||
      !principalId ||
      !deferredCacheReadsEnabled() ||
      !HYDRATION_ON_READ_KEYS.has(key)
    )
      return;
    const { reads, deniedDocs } = forEpoch(epoch);
    if (reads.has(key)) return;
    const pending = useInboxStore.getState().pending;
    const read = cacheStorage
      .loadCache([key], { pending })
      .then((cached) => {
        if (authPrincipal.epoch() !== epoch) return;
        if (!cached?.[key]) {
          reads.delete(key);
          return;
        }
        const state = useInboxStore.getState();
        const fromDisk =
          key === "docDetails"
            ? Object.fromEntries(
                Object.entries(cached[key]).filter(
                  ([id]) =>
                    !deniedDocs.has(id) && detailInvalidationRevision(id) === 0,
                ),
              )
            : cached[key];
        const merge = hydrateMergeValue(
          key,
          fromDisk,
          state[key as keyof typeof state],
        );
        if (merge.apply) useInboxStore.setState({ [key]: merge.value });
      })
      .catch(() => {
        if (authPrincipal.epoch() === epoch) reads.delete(key);
      });
    reads.set(key, read);
  }, [key, wanted, principalId, epoch]);
}
