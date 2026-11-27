import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

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
  const convex = useConvex();
  const [result, setResult] = useState<{
    conversationId: string;
    summary: LateJoinSummary | null;
  } | null>(null);
  const fetchedForRef = useRef<string | null>(null);
  const visitRef = useRef(0);

  useWatchEffect(() => {
    const target = conversationId ? String(conversationId) : null;
    if (!target) {
      fetchedForRef.current = null;
      visitRef.current += 1;
      setResult(null);
      return;
    }
    if (fetchedForRef.current && fetchedForRef.current !== target) {
      fetchedForRef.current = null;
      visitRef.current += 1;
      setResult(null);
    }
  }, [conversationId]);

  useWatchEffect(() => {
    if (!enabled || !conversationId) return;
    const target = String(conversationId);
    if (fetchedForRef.current === target) return;
    fetchedForRef.current = target;
    const visit = ++visitRef.current;
    void convex
      .query(api.lateJoinSummary.get, { conversation_id: conversationId })
      .then((data) => {
        if (visitRef.current === visit && fetchedForRef.current === target) {
          setResult({ conversationId: target, summary: data ?? null });
        }
      })
      .catch(() => {});
    return () => {
      visitRef.current += 1;
    };
  }, [enabled, conversationId, convex]);

  if (!enabled || !conversationId) return undefined;
  if (!result || result.conversationId !== String(conversationId)) {
    return undefined;
  }
  return result.summary;
}
