import { sameShape, type PendingEntry } from "@platform/engine";
import type { Patch } from "mutative";
import { authPrincipal } from "../../lib/authPrincipal";
import { db } from "./db";
import { persistenceOwned } from "./ownership";

export function writePendingEntries(
  patches: readonly Patch[],
  pending: Record<string, PendingEntry>,
): Promise<void> {
  const changes = patches.filter(({ path }) => path[0] === "pending");
  const replace = changes.some(({ path }) => path.length === 1);
  const table = db.pendingEntries;
  const owner = authPrincipal.current();
  const touched = new Set(changes.map(({ path }) => String(path[1])));
  return db.transaction("rw", table, async () => {
    if (!persistenceOwned() || authPrincipal.current() !== owner) return;
    if (replace) {
      const existing = await table.toArray();
      if (authPrincipal.current() !== owner) return;
      const previous = new Map(existing.map(({ key, value }) => [key, value]));
      const puts = Object.entries(pending).flatMap(([key, value]) =>
        sameShape(previous.get(key), value) ? [] : [{ key, value }],
      );
      const deletes = existing.flatMap(({ key }) =>
        Object.hasOwn(pending, key) ? [] : [key],
      );
      if (puts.length) await table.bulkPut(puts);
      if (deletes.length) await table.bulkDelete(deletes);
      return;
    }

    const puts = [];
    const deletes = [];
    for (const key of touched) {
      if (Object.hasOwn(pending, key)) puts.push({ key, value: pending[key] });
      else deletes.push(key);
    }
    if (puts.length) await table.bulkPut(puts);
    if (deletes.length) await table.bulkDelete(deletes);
  });
}
