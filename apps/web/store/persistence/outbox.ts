import { DOCS_SHOTS } from "../../lib/docsShots/flag";
import { storableActionArgs } from "../../lib/tabSafePath";
import { deleteDatabaseWithTimeout, readV2LegacyOutbox } from "../idbV2Salvage";
import { retryOutboxPut } from "../outboxPutRetry";
import { db } from "./db";
import { takeBootReadPhase } from "./hydration";
import { persistenceOwned } from "./ownership";
import { timeBootRead } from "./storage-timings";

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
  // Failed boot replays so far; entries are given up on at
  // MAX_OUTBOX_BOOT_ATTEMPTS (see mutativeMiddleware).
  attempts?: number;
  operationSchemaVersion?: number;
  // Repeated-write actions keep at most one row per key (see
  // OUTBOX_COALESCE_KEYS in mutativeMiddleware).
  coalesceKey?: string;
};

// Return the real promises: the middleware's storage watchdog and outbox
// retirement need to observe commit/failure. Swallowing errors here would
// report a wedged IndexedDB as healthy.
export function enqueueDispatch(entry: OutboxEntry): Promise<void> {
  // A write for an account this window no longer acts for parks nowhere: the
  // clear that follows the boundary unbinds the outbox, and this covers the
  // gap before that clear. Resolved, not rejected: it is not a storage fault.
  // Docs shots keep nothing, their outbox included.
  if (!persistenceOwned() || DOCS_SHOTS) return Promise.resolve();
  // The engine hands over the args as the caller passed them; a tab address in them is stored in its safe form (lib/tabSafePath).
  const row = { ...entry, args: storableActionArgs(entry.action, entry.args) };
  return retryOutboxPut(() => db.dispatchOutbox.put(row));
}

export function removeDispatch(id: string): Promise<void> {
  return db.dispatchOutbox.delete(id);
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    const rows = await timeBootRead(
      takeBootReadPhase("outbox"),
      "dispatchOutbox",
      () => db.dispatchOutbox.toArray(),
    );
    return rows.sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

// -- One-time salvage of the retired local-first v2 databases --
// Earlier builds parked durable writes in per-principal databases
// ("codecast-store-v2:<origin>:<principal>", legacyOutbox store). Move any
// parked rows into the dispatch outbox so nothing a user typed is lost, then
// delete those databases (and the "codecast-launcher-v2:*" launcher metadata).
// Row shape is compatible: both sides persisted the middleware's OutboxEntry.
export async function salvageLocalFirstV2Data(): Promise<number> {
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  )
    return 0;
  let salvaged = 0;
  let names: string[] = [];
  try {
    names = (await indexedDB.databases())
      .map((d) => d.name)
      .filter(
        (n): n is string =>
          !!n &&
          (n.startsWith("codecast-store-v2:") ||
            n.startsWith("codecast-launcher-v2:")),
      );
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      if (name.startsWith("codecast-store-v2:")) {
        const rows = await readV2LegacyOutbox(name);
        for (const row of rows) {
          if (
            !row ||
            typeof row !== "object" ||
            typeof (row as any).id !== "string"
          )
            continue;
          await db.dispatchOutbox.put(row as OutboxEntry);
          salvaged++;
        }
      }
      await deleteDatabaseWithTimeout(name);
    } catch (error) {
      console.error(`[idbCache] v2 salvage failed for ${name}`, error);
    }
  }
  if (salvaged > 0)
    console.warn(
      `[idbCache] salvaged ${salvaged} parked writes from retired v2 storage`,
    );
  return salvaged;
}
