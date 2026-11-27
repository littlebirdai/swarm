import type { MutUpdate } from "./sync-replication";
import { useInboxStore } from "./inboxStore";

export function forgetSeenBeforeOwnEcho(updates: MutUpdate[]): void {
  const keys: string[] = [];
  const rowPrefixes: string[] = [];
  for (const u of updates) {
    for (const [id, fields] of Object.entries(u.fields ?? {})) {
      for (const field of Object.keys(fields ?? {}))
        keys.push(`${u.key}:${id}:${field}`);
    }
    for (const row of u.upserts ?? [])
      if (row?._id != null) rowPrefixes.push(`${u.key}:${String(row._id)}:`);
  }
  if (keys.length > 0 || rowPrefixes.length > 0)
    useInboxStore.getState().forgetLockSeen(keys, rowPrefixes);
}
