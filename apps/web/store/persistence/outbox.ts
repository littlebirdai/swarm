import { DOCS_SHOTS } from "../../lib/docsShots/flag";
import { storableActionArgs } from "../../lib/tab-safe-path";
import { retryOutboxPut } from "../outboxPutRetry";
import { db } from "./db";
import { takeBootReadPhase } from "./hydration";
import { persistenceOwned } from "./ownership";
import { timeBootRead } from "./storage-timings";

import type { OutboxEntry } from "@platform/engine";
import { authPrincipal } from "../../lib/authPrincipal";

export type { OutboxEntry };
export const outboxAccountId = authPrincipal.snapshot;

// Return the real promises: the middleware's storage watchdog and outbox
// retirement need to observe commit/failure. Swallowing errors here would
// report a wedged IndexedDB as healthy.
export function enqueueDispatch(entry: OutboxEntry): Promise<void> {
  // A write for an account this window no longer acts for parks nowhere: the
  // clear that follows the boundary unbinds the outbox, and this covers the
  // gap before that clear. Resolved, not rejected: it is not a storage fault.
  // Docs shots keep nothing, their outbox included.
  if (
    DOCS_SHOTS ||
    entry.action === "beginSavedReadingAnchor" ||
    entry.action === "saveSavedReadingAnchor"
  )
    return Promise.resolve();
  // The engine hands over the args as the caller passed them; a tab address in them is stored in its safe form (lib/tabSafePath).
  const accountId = outboxAccountId();
  if (
    !accountId ||
    (entry.accountId === undefined
      ? !persistenceOwned()
      : entry.accountId !== accountId)
  )
    return Promise.resolve();
  const row = {
    ...entry,
    accountId,
    args: storableActionArgs(entry.action, entry.args),
  };
  return retryOutboxPut(() => db.dispatchOutbox.put(row));
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
