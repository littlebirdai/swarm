import { DOCS_SHOTS } from "../../lib/docsShots/flag";
import { storableActionArgs } from "../../lib/tabSafePath";
import { deleteDatabaseWithTimeout, readV2LegacyOutbox } from "../idbV2Salvage";
import { retryOutboxPut } from "../outboxPutRetry";
import { db, purgeInProgress } from "./db";
import { takeBootReadPhase } from "./hydration";
import { persistenceOwned } from "./ownership";
import { timeBootRead } from "./storage-timings";

import {
  sameLock,
  type OutboxEntry,
  type PendingEntry,
  type PendingOutboxWrite,
} from "@platform/engine";
import { authPrincipal } from "../../lib/authPrincipal";

export type { OutboxEntry };
export const outboxAccountId = authPrincipal.snapshot;

// Return the real promises: the middleware's storage watchdog and outbox
// retirement need to observe commit/failure. Swallowing errors here would
// report a wedged IndexedDB as healthy.
export const enqueueDispatch = Object.assign(
  (entry: OutboxEntry) => putDispatch(entry),
  {
    withPending: (entry: OutboxEntry, pending: PendingOutboxWrite) =>
      putDispatch(entry, pending),
  },
);

let outboxWriteEpoch = 0;

export function invalidateOutboxWrites() {
  outboxWriteEpoch++;
}

function putDispatch(
  entry: OutboxEntry,
  pending?: PendingOutboxWrite,
): Promise<void> {
  // A write for an account this window no longer acts for parks nowhere: the
  // clear that follows the boundary unbinds the outbox, and this covers the
  // gap before that clear. Resolved, not rejected: it is not a storage fault.
  // Docs shots keep nothing, their outbox included.
  if (DOCS_SHOTS) return Promise.resolve();
  // The engine hands over the args as the caller passed them; a tab address in them is stored in its safe form (lib/tabSafePath).
  const accountId = entry.accountId ?? outboxAccountId();
  if (!accountId || purgeInProgress) return Promise.resolve();
  const epoch = outboxWriteEpoch;
  const row = {
    ...entry,
    accountId,
    args: storableActionArgs(entry.action, entry.args),
  };
  const tables = pending ? [db.meta, db.dispatchOutbox] : [db.dispatchOutbox];
  let retry = false;
  return retryOutboxPut(() => {
    const isRetry = retry;
    retry = true;
    return db.transaction("rw", tables, async () => {
      const existing = pending ? await db.meta.get("pending") : undefined;
      if (
        epoch !== outboxWriteEpoch ||
        purgeInProgress ||
        accountId !== authPrincipal.current() ||
        !persistenceOwned()
      )
        return;
      if (pending) {
        const value: Record<string, PendingEntry> = existing?.value ?? {};
        let changed = false;
        for (const { key, before, after } of pending) {
          const current = value[key];
          if (after) {
            if (
              current &&
              !(before && sameLock(current, before)) &&
              (isRetry
                ? (current.ts ?? 0) >= (after.ts ?? 0)
                : (current.ts ?? 0) > (after.ts ?? 0))
            )
              continue;
            value[key] = after;
            changed = true;
          } else if (before && sameLock(current, before)) {
            delete value[key];
            changed = true;
          }
        }
        if (changed) await db.meta.put({ key: "pending", value });
      }
      await db.dispatchOutbox.put(row);
    });
  });
}

export function removeDispatch(id: string): Promise<void> {
  return db.dispatchOutbox.delete(id);
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    const accountId = outboxAccountId();
    if (!accountId || accountId !== outboxAccountId()) return [];
    const rows = await db.transaction(
      "rw",
      db.dispatchOutbox,
      db.meta,
      async () => {
        const entries = await timeBootRead(
          takeBootReadPhase("outbox"),
          "dispatchOutbox",
          () => db.dispatchOutbox.toArray(),
        );
        if (accountId !== outboxAccountId()) return [];
        const legacy = entries.filter((row) => row.accountId === undefined);
        if (legacy.length) {
          const [stamp, user] = await db.meta.bulkGet([
            "cacheOwner",
            "currentUser",
          ]);
          if (
            (stamp?.value?.principal === accountId ||
              (!stamp && user?.value?._id === accountId)) &&
            (!user || user.value?._id === accountId) &&
            accountId === outboxAccountId()
          ) {
            for (const row of legacy) row.accountId = accountId;
            await db.dispatchOutbox.bulkPut(legacy);
          }
        }
        return entries.filter((row) => row.accountId === accountId);
      },
    );
    return accountId === outboxAccountId()
      ? rows.sort((a, b) => a.ts - b.ts)
      : [];
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
  const accountId = outboxAccountId();
  if (!accountId) return 0;
  const ownedDatabase = `codecast-store-v2:${globalThis.location?.origin}:${accountId}`;
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
        if (name !== ownedDatabase) continue;
        const rows = await readV2LegacyOutbox(name);
        for (const row of rows) {
          if (
            !row ||
            typeof row !== "object" ||
            typeof (row as any).id !== "string"
          )
            continue;
          if (accountId !== outboxAccountId()) return salvaged;
          const entry = row as OutboxEntry;
          if (entry.accountId && entry.accountId !== accountId) continue;
          await db.dispatchOutbox.put({ ...entry, accountId });
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
