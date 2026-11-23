import { captureException } from "@sentry/react";
import {
  applyPendingMessageWrite,
  clearPendingMessageJournal,
  importLegacyQueuedMessages,
  pendingMessageWrites,
  pendingMessagesFromRecords,
  readPendingMessageJournal,
  retireStalePendingRecords,
  writePendingMessageJournal,
  type PendingMessages,
} from "../pendingMessageJournal";
import { db, PERSISTENCE_AVAILABLE } from "./db";

export const PENDING_INPUT_PREFIX = "pendingInput:v1:";
let pendingJournalFlush: Promise<void> | null = null;
let pendingJournalEpoch = 0;

function pendingInputKey(ownerId: string, id: string): string {
  return `${PENDING_INPUT_PREFIX}${ownerId}:${id}`;
}

export function persistPendingMessageChanges(before: PendingMessages, after: PendingMessages, ownerId?: string): void {
  if (!PERSISTENCE_AVAILABLE || before === after) return;
  const writes = pendingMessageWrites(before, after);
  if (!writes.length) return;
  if (!ownerId) throw new Error("Sign in before sending a message so it can be saved safely.");
  writePendingMessageJournal(localStorage, ownerId, writes);
  void flushPendingMessageJournal().catch(error => captureException(error, { tags: { source: "pending-input-journal" } }));
}

export function flushPendingMessageJournal(): Promise<void> {
  if (pendingJournalFlush) return pendingJournalFlush;
  const epoch = pendingJournalEpoch;
  const run = async () => {
    for (;;) {
      if (epoch !== pendingJournalEpoch) return;
      const batches = readPendingMessageJournal(localStorage);
      if (!batches.length) return;
      await db.transaction("rw", db.meta, async () => {
        for (const batch of batches) {
          for (const write of batch.writes) {
            const key = pendingInputKey(batch.ownerId, write.id);
            const previous = await db.meta.get(key);
            const value = applyPendingMessageWrite(previous?.value, write);
            await db.meta.put({ key, value });
          }
        }
      });
      if (epoch !== pendingJournalEpoch) return;
      for (const { key } of batches) localStorage.removeItem(key);
    }
  };
  pendingJournalFlush = run().finally(() => { pendingJournalFlush = null; });
  return pendingJournalFlush;
}

export async function loadPendingInput(ownerId?: string): Promise<PendingMessages> {
  if (!ownerId) return {};
  await flushPendingMessageJournal();
  return db.transaction("rw", db.meta, async () => {
    const legacy = await db.meta.get("pendingMessages");
    const cachedUser = await db.meta.get("currentUser");
    if (legacy?.value && cachedUser?.value?._id === ownerId) {
      for (const write of pendingMessageWrites({}, legacy.value)) {
        const key = pendingInputKey(ownerId, write.id);
        if (await db.meta.get(key)) continue;
        await db.meta.put({ key, value: applyPendingMessageWrite(undefined, write) });
      }
      await db.meta.delete("pendingMessages");
    }
    const queued = await db.meta.get("queuedMessages");
    if (queued?.value && cachedUser?.value?._id === ownerId) {
      for (const write of pendingMessageWrites({}, importLegacyQueuedMessages(queued.value))) {
        await db.meta.put({ key: pendingInputKey(ownerId, write.id), value: applyPendingMessageWrite(undefined, write) });
      }
      await db.meta.delete("queuedMessages");
    }
    const rows = await db.meta.where("key").startsWith(`${PENDING_INPUT_PREFIX}${ownerId}:`).toArray();
    const { kept, retired } = retireStalePendingRecords(rows.map(row => row.value), Date.now());
    for (const row of retired) await db.meta.put({ key: pendingInputKey(ownerId, row.id), value: row });
    return pendingMessagesFromRecords(kept);
  });
}

export function clearPendingInputJournal(): Promise<void> | null {
  pendingJournalEpoch++;
  clearPendingMessageJournal(localStorage);
  return pendingJournalFlush;
}
