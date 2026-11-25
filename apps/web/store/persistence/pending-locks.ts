import {
  sameLock,
  type PendingEntry,
  type PendingOutboxWrite,
} from "@platform/engine";
import { db } from "./db";

export async function writePendingChanges(
  changes: PendingOutboxWrite,
  writer: "sync" | "outbox" | "retry",
  writable: () => boolean,
): Promise<string[] | null> {
  const existing = await db.meta.get("pending");
  if (!writable()) return null;
  const value: Record<string, PendingEntry> = existing?.value ?? {};
  const retired = new Set(existing?.retiredLocks);
  const alreadyRetired: string[] = [];
  let changed = false;
  for (const { key, before, after, restore } of changes) {
    const current = value[key];
    const matchesBefore = before !== undefined && sameLock(current, before);
    if (restore && after?.lock && matchesBefore && !retired.has(after.lock)) {
      const committed = await db.dispatchOutbox
        .filter(
          (entry) =>
            entry.locks?.some(
              (lock) => lock.key === key && lock.lock === after.lock,
            ) ?? false,
        )
        .first();
      if (!writable()) return null;
      if (committed) {
        value[key] = after;
        changed = true;
        continue;
      }
    }
    if (!after || restore) {
      if (matchesBefore) {
        delete value[key];
        changed = true;
      } else if (
        writer === "sync" &&
        before?.lock &&
        !retired.has(before.lock)
      ) {
        retired.add(before.lock);
        changed = true;
      }
      continue;
    }
    if (writer === "sync" && after.lock && !sameLock(current, after)) continue;
    if (writer !== "sync" && after.lock && retired.delete(after.lock)) {
      alreadyRetired.push(after.lock);
      changed = true;
      continue;
    }
    if (
      current &&
      !matchesBefore &&
      (writer === "retry"
        ? (current.ts ?? 0) >= (after.ts ?? 0)
        : (current.ts ?? 0) > (after.ts ?? 0))
    )
      continue;
    value[key] = after;
    changed = true;
  }
  if (changed) {
    await db.meta.put({
      key: "pending",
      value,
      ...(retired.size ? { retiredLocks: [...retired] } : {}),
    });
  }
  return alreadyRetired;
}
