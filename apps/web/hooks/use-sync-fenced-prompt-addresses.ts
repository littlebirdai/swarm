import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FencedPromptAddress } from "../store/fenced-prompt-answer";
import { useCollectionRows } from "./useCollectionRows";
import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import {
  entityIdArgs,
  useFeederError,
  useSyncCollection,
} from "./useSyncCollection";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useWatchEffect } from "./useWatchEffect";
import type { FunctionReturnType } from "convex/server";

type Feed = FunctionReturnType<typeof api.permissions.getFencedPromptFeed>;

export function FencedObservedTurnFeeder({
  conversationId,
}: {
  conversationId: Id<"conversations"> | undefined;
}) {
  const dropAbsent = useCallback(
    (row: { _id: Id<"conversations"> }) => row._id === conversationId,
    [conversationId],
  );
  const args = entityIdArgs("conversation_id", conversationId);
  const activeId = args !== "skip" ? conversationId : undefined;
  const select = useCallback(
    ({ turn }: Feed) => {
      if (!turn || turn._id !== activeId) return [];
      const { lease_remaining_ms, ...row } = turn;
      return [
        {
          ...row,
          local_lease_deadline: performance.now() + lease_remaining_ms,
        },
      ];
    },
    [activeId],
  );
  const clear = useCallback(() => {
    if (!activeId) return;
    const store = useInboxStore.getState();
    if (store.fencedObservedTurns[activeId])
      store.dropRows("fencedObservedTurns", [activeId]);
  }, [activeId]);
  const result = useSyncCollection(
    "fencedObservedTurns",
    api.permissions.getFencedPromptFeed,
    activeId ? { conversation_id: activeId } : "skip",
    { dropAbsent, select },
  );
  useWatchEffect(() => clear, [clear]);
  useWatchEffect(() => {
    if (result.error || result.refused) clear();
  }, [clear, result.error, result.refused]);
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
    api.permissions.getFencedPromptFeed,
    active ? { conversation_id: active } : "skip",
  );
  useFeederError("permissions:getFencedPromptFeed", error);
  useConvexSync(
    data?.prompts,
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
    row.answerer,
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
