import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
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
