import {
  CLIENT_SYNC_REGISTRY,
  HYDRATION_DEFERRED_KEYS,
  type ClientSyncRegistryEntry,
} from "./clientSyncRegistry";

export const HYDRATION_ON_READ_KEYS = new Set(
  HYDRATION_DEFERRED_KEYS.filter((key) => {
    const { hydration } = CLIENT_SYNC_REGISTRY[key] as ClientSyncRegistryEntry;
    return typeof hydration === "object" && hydration.onRead === true;
  }),
);

export const HYDRATION_EAGER_DEFERRED_KEYS = HYDRATION_DEFERRED_KEYS.filter(
  (key) => !HYDRATION_ON_READ_KEYS.has(key),
);

export function deferredCacheReadsEnabled(): boolean {
  return (
    typeof document !== "undefined" &&
    process.env.VITE_DEFERRED_CACHE_BOOT === "1"
  );
}
