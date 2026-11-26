import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FencedPromptAddress } from "../store/fenced-prompt-answer";
import { useCollectionRows } from "./useCollectionRows";
import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useWatchEffect } from "./useWatchEffect";
import type { FunctionReturnType } from "convex/server";

type Feed = FunctionReturnType<
  typeof api.permissions.listAnswerablePromptAddresses
>;

function stampLease(rows: Feed) {
  const receivedAt = performance.now();
  return rows.map(({ lease_remaining_ms, ...row }) => ({
    ...row,
    local_lease_deadline: receivedAt + lease_remaining_ms,
  }));
}

export function FencedPromptAddressesFeeder({
  conversationId,
}: {
  conversationId: Id<"conversations"> | undefined;
}) {
  useSyncFencedPromptAddresses(conversationId, true);
  return null;
}

export function useSyncFencedPromptAddresses(
  conversationId: Id<"conversations"> | undefined,
  enabled: boolean,
) {
  const dropAbsent = useCallback(
    (row: { conversation_id: Id<"conversations"> }) =>
      row.conversation_id === conversationId,
    [conversationId],
  );
  const args = entityIdArgs("conversation_id", conversationId);
  const activeId = enabled && args !== "skip" ? conversationId : undefined;
  const clear = useCallback(() => {
    if (!activeId) return;
    const store = useInboxStore.getState();
    if (store.fencedPromptAddresses[activeId])
      store.dropRows("fencedPromptAddresses", [activeId]);
  }, [activeId]);
  const result = useSyncCollection(
    "fencedPromptAddresses",
    api.permissions.listAnswerablePromptAddresses,
    activeId ? { conversation_id: activeId } : "skip",
    { dropAbsent, select: stampLease },
  );
  useWatchEffect(() => clear, [clear]);
  useWatchEffect(() => {
    if (result.error || result.refused) clear();
  }, [clear, result.error, result.refused]);
  return result;
}

const submissionSignature = (row: FencedPromptAddress) =>
  JSON.stringify([row.submitted ?? false, row.answerSummary, row.questions]);

export function useFencedPromptAddresses(
  conversationId: string | undefined,
  enabled: boolean,
) {
  const args = entityIdArgs("conversation_id", conversationId);
  const id =
    args === "skip" ? undefined : (conversationId as Id<"conversations">);
  const { ready } = useSyncFencedPromptAddresses(id, enabled);
  const where = useCallback(
    (row: FencedPromptAddress) => row.conversation_id === id,
    [id],
  );
  const rows = useCollectionRows<FencedPromptAddress>("fencedPromptAddresses", {
    where,
    sig: submissionSignature,
  });
  return { ready, rows };
}
