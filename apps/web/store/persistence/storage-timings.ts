import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../clientSyncRegistry";
import { WEB_COLLECTION_INDEXES } from "./schema";
import { StorageTimingSamples, type BootPhase } from "./timing-samples";

export const storageTimings = new StorageTimingSamples([
  "meta",
  "pendingInput",
  "dispatchOutbox",
  "conversationUserMessages",
  "conversationMessageMeta",
  "conversationMessageRows",
  ...[...HYDRATION_CRITICAL_READ_KEYS, ...HYDRATION_DEFERRED_KEYS].filter(
    (table) => Object.hasOwn(WEB_COLLECTION_INDEXES, table),
  ),
]);

export function timeBootRead<T>(
  phase: BootPhase | undefined,
  table: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!phase) return read();
  const start = performance.now();
  return read().then((result) => {
    storageTimings.recordBoot(phase, table, performance.now() - start);
    return result;
  });
}
