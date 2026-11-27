import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

type MoveOptions = FunctionReturnType<
  typeof api.edgeRunLease.forcedMoveOptions
>[number];

export function useForcedMoveOptions(conversationId: string) {
  const dropAbsent = useCallback(
    (row: MoveOptions) => row._id === conversationId,
    [conversationId],
  );
  useSyncCollection(
    "forcedMoveOptions",
    api.edgeRunLease.forcedMoveOptions,
    isConvexId(conversationId)
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip",
    { dropAbsent },
  );
  return useInboxStore(
    (s): MoveOptions | undefined => s.forcedMoveOptions[conversationId],
  );
}
