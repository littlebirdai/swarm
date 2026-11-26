import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FencedPromptAddress } from "../store/fenced-prompt-answer";
import { useCollectionRows } from "./useCollectionRows";
import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { entityIdArgs, useFeederError } from "./useSyncCollection";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";

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
  const args = entityIdArgs("conversation_id", conversationId);
  const authSettled = useServerAuthSettled();
  const active = authSettled && enabled && args !== "skip" && conversationId;
  const { data, error } = useQueryNoThrow(
    api.permissions.listAnswerablePromptAddresses,
    active ? { conversation_id: active } : "skip",
  );
  useFeederError("permissions:listAnswerablePromptAddresses", error);
  useConvexSync(
    data,
    useCallback(
      (rows: FencedPromptAddress[]) => {
        if (!active) return;
        const store = useInboxStore.getState();
        store.syncTable("fencedPromptAddresses", rows);
        store.reconcileFencedPromptAddresses(
          active,
          new Set(rows.map((row) => row._id)),
        );
      },
      [active],
    ),
  );
  return { ready: data !== undefined };
}

const submissionSignature = (row: FencedPromptAddress) =>
  JSON.stringify([
    row.submitted === true || row.accepted === true,
    row.feedAbsent,
    row.answerSummary,
    row.questions,
  ]);

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
