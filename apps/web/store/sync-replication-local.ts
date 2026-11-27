import {
  collectCompleteDocCrawlAbsences,
  hideInvalidatedDetails,
  persistDetailInvalidation,
  verifyDetailInvalidation,
  type DetailAuthorityReader,
} from "./doc-detail-authority";
import {
  detailAccountIsCurrent,
  detailReadPosition,
  setDetailInvalidationReporter,
} from "./doc-detail-cache";
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
  setDetailInvalidationReporter(
    (evidence) => {
      if (!current()) return false;
      if (evidence.cause !== "crawl") hideInvalidatedDetails(evidence.ids);
      void verifyDetailInvalidation(authority, evidence, current)
        .then((ids) => persistDetailInvalidation(ids, current))
        .catch(() => {});
      return true;
    },
    authority.detail,
    collectCompleteDocCrawlAbsences,
  );
  const retention = startTimedDocRetention(
    useInboxStore.getState,
    current,
    current,
  );
  return {
    stop() {
      active = false;
      retention.stop();
      setDetailInvalidationReporter();
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
