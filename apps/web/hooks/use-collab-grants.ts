import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useInboxStore } from "../store/inboxStore";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";

export function useCollabSendLevel(conversationId: string | undefined) {
  const select = useCallback(
    (access: FunctionReturnType<typeof api.collab.mySendAccess> | undefined) =>
      access && conversationId
        ? [{ ...access, _id: conversationId }]
        : undefined,
    [conversationId],
  );
  useSyncCollection(
    "collabAccess",
    api.collab.mySendAccess,
    entityIdArgs("conversation_id", conversationId),
    { select },
  );
  return useInboxStore((state) =>
    conversationId ? state.collabAccess[conversationId]?.level : undefined,
  );
}

export function useCollabRequests(conversationId: string) {
  const select = useCallback(
    (
      grants: FunctionReturnType<typeof api.collab.collabRequests> | undefined,
    ) =>
      grants?.map((row) => ({
        ...row,
        _id: row.grant_id,
        conversation_id: conversationId,
      })),
    [conversationId],
  );
  const dropAbsent = useCallback(
    (row: { conversation_id: string }) =>
      row.conversation_id === conversationId,
    [conversationId],
  );
  useSyncCollection(
    "collabRequests",
    api.collab.collabRequests,
    entityIdArgs("conversation_id", conversationId),
    { select, dropAbsent },
  );
  return useInboxStore(
    useShallow((state) =>
      Object.values(state.collabRequests)
        .filter((row) => row.conversation_id === conversationId)
        .sort((a, b) => b.updated_at - a.updated_at),
    ),
  );
}
