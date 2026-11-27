import { authPrincipal } from "./authPrincipal";
import { detailAuthorityReader } from "./detail-authority-client";
import { desktopPanelKind } from "./windowRole";
import { hideInvalidatedDetails } from "../store/doc-detail-authority";
import {
  detailReadIsCurrent,
  type detailReadPosition,
  readDocDetailForInvalidation,
} from "../store/doc-detail-cache";
import { deleteInvalidatedDocDetails } from "../store/doc-detail-disk";
import { outboxAccountId } from "../store/idb-cache";
import { useInboxStore } from "../store/inboxStore";
import { canWriteSharedDocDetails } from "../store/sync-replication";

export async function removeVerifiedArchivedBody(
  id: string,
  accountId: string,
  dispatchedAt: number,
  position: ReturnType<typeof detailReadPosition>,
): Promise<void> {
  const initial = useInboxStore.getState();
  const doc = initial.docs[id];
  const detail = initial.docDetails[id];
  const current = () => {
    const state = useInboxStore.getState();
    return (
      !desktopPanelKind() &&
      canWriteSharedDocDetails(accountId) &&
      accountId === outboxAccountId() &&
      authPrincipal.current() === accountId &&
      detailReadIsCurrent(id, position) &&
      state.docs[id] === doc &&
      state.docDetails[id] === detail &&
      state.pending[`docs:${id}`]?.type !== "include" &&
      state.pending[`docDetails:${id}`]?.type !== "include"
    );
  };
  if (!current()) return;
  const row = await readDocDetailForInvalidation(id, () =>
    detailAuthorityReader(accountId).detail(id),
  );
  if (row?.archived_at === undefined || !current()) return;
  const deleted = await deleteInvalidatedDocDetails([id], current, {
    accountId,
    dispatchedAt,
  });
  if (deleted.length && current()) hideInvalidatedDetails(deleted);
}
