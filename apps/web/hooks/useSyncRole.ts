import { useSyncExternalStore } from "react";
import { useAuthPrincipal } from "../lib/authPrincipal";
import {
  isWindowStoreActive,
  subscribeWindowStoreStart,
} from "../lib/windowRole";
import { useInboxStore } from "../store/inboxStore";
import { startSyncReplication } from "../store/sync-replication";

import { useWatchEffect } from "./useWatchEffect";
/**
 * Whether this window feeds itself from the server (sync host or solo) or
 * receives the shared slice from another window (follower). Global feeders
 * gate on this; per-view queries (a conversation's messages, a doc body)
 * never do. See docs/architecture/sync-host.md.
 */
export function useIsSyncHost(): boolean {
  return useInboxStore((s) => s.syncRole !== "follower");
}

/** Mount cross-window replication for this window. `eligible` = this window
 *  mounts the full shell and may be elected host. Replication is scoped to
 *  the account the window acts for and restarts when that changes. */
export function useSyncReplication(eligible: boolean): void {
  const { principalId } = useAuthPrincipal();
  const active = useSyncExternalStore(
    subscribeWindowStoreStart,
    isWindowStoreActive,
    () => true,
  );
  useWatchEffect(() => {
    if (active) return startSyncReplication({ eligible, principalId });
  }, [active, eligible, principalId]);
}
