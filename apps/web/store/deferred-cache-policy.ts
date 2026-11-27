import {
  CLIENT_SYNC_REGISTRY,
  HYDRATION_DEFERRED_KEYS,
  type ClientSyncRegistryEntry,
} from "./clientSyncRegistry";

export const HYDRATION_ON_READ_KEYS: ReadonlySet<string> = new Set(
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

type SharedCacheSource = "disk" | "joining" | "replica";
type DeferredDocEdit = readonly string[] | "archive" | "denied";

function newDeferredWindow(listeners = new Set<() => void>()) {
  return {
    source: "disk" as SharedCacheSource,
    docEdits: new Map<string, DeferredDocEdit>(),
    listeners,
  };
}

let deferredWindow = newDeferredWindow();

export function deferredSharedCacheSource(): SharedCacheSource {
  return deferredWindow.source;
}

export function subscribeDeferredSharedCache(listener: () => void) {
  deferredWindow.listeners.add(listener);
  return () => deferredWindow.listeners.delete(listener);
}

export function setDeferredSharedCacheSource(source: SharedCacheSource): void {
  if (!deferredCacheReadsEnabled() || deferredWindow.source === source) return;
  deferredWindow.source = source;
  for (const listener of deferredWindow.listeners) listener();
}

export function resetDeferredCacheWindow(): void {
  if (!deferredCacheReadsEnabled()) return;
  setDeferredSharedCacheSource("disk");
  deferredWindow.docEdits.clear();
}

export function noteDeferredDocEdit(id: string, edit: DeferredDocEdit): void {
  if (!deferredCacheReadsEnabled()) return;
  const previous = deferredWindow.docEdits.get(id);
  if (typeof edit === "string" || !previous) {
    deferredWindow.docEdits.set(id, edit);
  } else if (typeof previous !== "string") {
    deferredWindow.docEdits.set(id, [...new Set([...previous, ...edit])]);
  }
}

export function deferredDocEdit(id: string): DeferredDocEdit | undefined {
  return deferredWindow.docEdits.get(id);
}

export function __deferredCacheSimSlots() {
  const copy = (state: typeof deferredWindow) => ({
    ...state,
    docEdits: new Map(state.docEdits),
    listeners: new Set(state.listeners),
  });
  return {
    get: () => copy(deferredWindow),
    set: (state: typeof deferredWindow) => {
      deferredWindow = copy(state);
    },
    fresh: newDeferredWindow,
  };
}
