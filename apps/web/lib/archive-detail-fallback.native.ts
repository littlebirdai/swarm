import type { detailReadPosition } from "../store/doc-detail-cache";

export async function removeVerifiedArchivedBody(
  _id: string,
  _accountId: string,
  _dispatchedAt: number,
  _position: ReturnType<typeof detailReadPosition>,
): Promise<void> {}
