import type { Patch } from "mutative";
import { queuedMessagesFromPending } from "../../pendingMessageJournal";
import {
  db,
  deleteCacheDatabase,
  PERSISTENCE_AVAILABLE,
  reopenAfterPurge,
  setPurgeInProgress,
} from "../db";
import {
  enqueueDispatch,
  loadOutbox,
  outboxAccountId,
  removeDispatch,
} from "../outbox";
import { writePendingEntries } from "../pending-entries";
import {
  clearPendingInputJournal,
  loadPendingInput,
  persistPendingMessageChanges,
} from "../pendingInputJournal";
import { COMPOSER_RETRY_PREFIX, PENDING_INPUT_PREFIX } from "../schema";
import type { CacheStorage } from "../storage";

export type JournalBridge = Pick<
  CacheStorage,
  | "enqueueDispatch"
  | "removeDispatch"
  | "loadOutbox"
  | "outboxAccountId"
  | "persistPendingMessageChanges"
> & {
  loadJournalKeys(
    keys: readonly string[] | undefined,
    context: Record<string, unknown>,
    principal: string | null,
  ): Promise<Record<string, any>>;
  writePendingEntries(patches: readonly Patch[], pending: any): Promise<void>;
  purgeJournal(keepPendingInputFor: string | null): Promise<void>;
};

export function createIdbJournalBridge(): JournalBridge {
  return {
    enqueueDispatch,
    removeDispatch,
    loadOutbox,
    outboxAccountId,
    persistPendingMessageChanges,
    async loadJournalKeys(keys, context, principal) {
      if (!PERSISTENCE_AVAILABLE || !principal) return {};
      const wanted = keys ? new Set(keys) : null;
      const claimed = (context.currentUser as { _id?: string } | undefined)
        ?._id;
      if (claimed !== undefined && claimed !== principal) return {};
      const out: Record<string, any> = {};
      if (!wanted || wanted.has("pending")) {
        try {
          const rows = await db.pendingEntries.toArray();
          if (rows.length > 0) {
            out.pending = Object.fromEntries(
              rows.map(({ key, value }) => [key, value]),
            );
          }
        } catch {}
      }
      if (
        !wanted ||
        wanted.has("pendingMessages") ||
        wanted.has("queuedMessages")
      ) {
        try {
          const pendingMessages = await loadPendingInput(principal);
          if (Object.keys(pendingMessages).length > 0) {
            out.pendingMessages = pendingMessages;
            out.queuedMessages = queuedMessagesFromPending(pendingMessages);
          }
        } catch {}
      }
      return out;
    },
    writePendingEntries(patches, pending) {
      if (!PERSISTENCE_AVAILABLE) return Promise.resolve();
      return writePendingEntries(patches, pending ?? {});
    },
    async purgeJournal(keepPendingInputFor) {
      if (!PERSISTENCE_AVAILABLE) return;
      setPurgeInProgress(true);
      try {
        await clearPendingInputJournal();
        let kept: Array<{ key: string; value: any }> = [];
        if (keepPendingInputFor) {
          try {
            kept = await db.meta
              .where("key")
              .startsWithAnyOf(
                `${PENDING_INPUT_PREFIX}${keepPendingInputFor}:`,
                `${COMPOSER_RETRY_PREFIX}${keepPendingInputFor}:`,
              )
              .toArray();
          } catch {
            kept = [];
          }
        }
        try {
          await deleteCacheDatabase();
        } finally {
          await reopenAfterPurge();
        }
        if (kept.length) await db.meta.bulkPut(kept);
      } finally {
        setPurgeInProgress(false);
      }
    },
  };
}
