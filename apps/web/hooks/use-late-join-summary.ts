import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useQueryNoThrow } from "./useQueryNoThrow";

export type LateJoinSummary = NonNullable<
  FunctionReturnType<typeof api.lateJoinSummary.get>
>;

export function isLateJoinSummaryEnabled(): boolean {
  return import.meta.env.VITE_LATE_JOIN_SUMMARY === "1";
}

export function hasLateJoinUpdates(
  summary: LateJoinSummary | null | undefined,
): summary is LateJoinSummary {
  if (!summary) return false;
  return (
    summary.new_turns > 0 ||
    summary.changed_files.length > 0 ||
    summary.decisions.length > 0 ||
    summary.open_prompt !== null
  );
}

export function useLateJoinSummary(
  conversationId: Id<"conversations"> | null,
  enabled: boolean,
): LateJoinSummary | null | undefined {
  const { data } = useQueryNoThrow(
    api.lateJoinSummary.get,
    enabled && conversationId ? { conversation_id: conversationId } : "skip",
  );
  return enabled && conversationId ? data : undefined;
}
