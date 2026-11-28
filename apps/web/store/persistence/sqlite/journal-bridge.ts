import type { Patch } from "mutative";
import { authPrincipal } from "../../../lib/authPrincipal";
import { DOCS_SHOTS } from "../../../lib/docsShots/flag";
import { expireExcludeTombstones } from "../../cacheRetention";
import { queuedMessagesFromPending } from "../../pendingMessageJournal";
import { db } from "../db";
import {
  enqueueDispatch,
  loadOutbox,
  outboxAccountId,
  removeDispatch,
} from "../outbox";
import { ensureCacheOwnership, persistenceOwned } from "../ownership";
import { writePendingEntries } from "../pending-entries";
import {
  loadPendingInput,
  persistPendingMessageChanges,
} from "../pendingInputJournal";
import { purgeLocalCache } from "../purge";
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

async function ownerStampMatches(principal: string): Promise<boolean> {
  try {
    const row = await db.meta.get("cacheOwner");
    return row?.value?.principal === principal;
  } catch {
    return false;
  }
}

export function createIdbJournalBridge(): JournalBridge {
  return {
    enqueueDispatch,
    removeDispatch,
    loadOutbox,
    outboxAccountId,
    persistPendingMessageChanges,
    async loadJournalKeys(keys, context, principal) {
      if (DOCS_SHOTS) return {};
      const claimed = (context.currentUser as { _id?: string } | undefined)
        ?._id;
      if (principal !== null && claimed !== undefined && claimed !== principal)
        return {};
      const resolved = await authPrincipal.resolve();
      if (resolved !== principal) return {};

      const owner = await ensureCacheOwnership(purgeLocalCache);
      if (!principal) return {};
      const wanted = keys ? new Set(keys) : null;
      const out: Record<string, any> = {};

      if (owner === principal && (!wanted || wanted.has("pending"))) {
        try {
          const rows = await db.pendingEntries.toArray();
          if (rows.length > 0) {
            const raw = Object.fromEntries(
              rows.map(({ key, value }) => [key, value]),
            );
            const pending = expireExcludeTombstones(raw, Date.now());
            if (Object.keys(pending).length > 0) out.pending = pending;
          }
        } catch {}
      }

      if (
        (!wanted ||
          wanted.has("pendingMessages") ||
          wanted.has("queuedMessages")) &&
        (owner === principal || (await ownerStampMatches(principal)))
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
    async writePendingEntries(patches, pending) {
      if (DOCS_SHOTS || !persistenceOwned()) return;
      const principal = authPrincipal.current();
      if (!principal) return;
      await ensureCacheOwnership(purgeLocalCache);
      if (!persistenceOwned() || authPrincipal.current() !== principal) return;
      if (!(await ownerStampMatches(principal))) return;
      await writePendingEntries(patches, pending ?? {});
    },
    async purgeJournal(keepPendingInputFor) {
      if (DOCS_SHOTS) return;
      await purgeLocalCache({
        keepPendingInputFor,
        reason: "sqlite-journal-purge",
      });
    },
  };
}
