import {
  startLocalDocAuthority,
  type DetailAuthorityReader,
} from "./doc-detail-authority";
import { detailAccountIsCurrent, detailReadPosition } from "./doc-detail-cache";
import { useInboxStore } from "./inboxStore";
import type { SyncReplicationStatus } from "./sync-replication";
import { startTimedDocRetention } from "./timed-doc-retention";

export function startLocalDocReplication(
  principalId: string | null,
  authority: DetailAuthorityReader,
  onStop: () => void,
): { stop: () => void; status: () => SyncReplicationStatus } {
  const account = detailReadPosition();
  let active = true;
  const current = () => active && detailAccountIsCurrent(account);
  const stopAuthority = startLocalDocAuthority(authority);
  const retention = startTimedDocRetention(
    useInboxStore.getState,
    current,
    current,
  );
  return {
    stop() {
      active = false;
      retention.stop();
      stopAuthority();
      onStop();
    },
    status: () => ({
      principalId,
      role: "host",
      elected: false,
      holdsLock: false,
      synced: false,
      selfId: "",
    }),
  };
}
