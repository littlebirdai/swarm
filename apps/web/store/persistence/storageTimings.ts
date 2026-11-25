import { SYSTEM_TABLES, WEB_COLLECTION_INDEXES } from "./schema";
import { StorageTimingSamples, type BootPhase } from "./timingSamples";

export const storageTimings = new StorageTimingSamples([
  ...Object.keys(SYSTEM_TABLES),
  ...Object.keys(WEB_COLLECTION_INDEXES),
]);

export async function timeBootRead<T>(
  phase: BootPhase | undefined,
  table: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!phase) return read();
  const start = performance.now();
  const result = await read();
  storageTimings.recordBoot(phase, table, performance.now() - start);
  return result;
}
