import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FencedPromptAddress } from "../store/fenced-prompt-answer";
import { useCollectionRows } from "./useCollectionRows";
import { useCallback } from "react";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";

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
  return useSyncCollection(
    "fencedPromptAddresses",
    api.permissions.listAnswerablePromptAddresses,
    enabled && args !== "skip" && conversationId
      ? { conversation_id: conversationId }
      : "skip",
    { dropAbsent },
  );
}

const submissionSignature = (row: FencedPromptAddress) =>
  JSON.stringify([row.submitted ?? false, row.questions]);

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
