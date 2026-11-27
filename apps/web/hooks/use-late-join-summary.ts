import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
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

const MAX_RETRIES = 1;

export function useLateJoinSummary(
  conversationId: Id<"conversations"> | null,
  enabled: boolean,
): LateJoinSummary | null | undefined {
  const convex = useConvex();
  const [result, setResult] = useState<{
    conversationId: string;
    summary: LateJoinSummary | null;
  } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const currentTargetRef = useRef<string | null>(null);
  const settledForRef = useRef<string | null>(null);
  const retryCountRef = useRef<{ conversationId: string; count: number }>({
    conversationId: "",
    count: 0,
  });
  const inFlightRef = useRef<{
    conversationId: string;
    promise: Promise<LateJoinSummary | null>;
  } | null>(null);

  useWatchEffect(() => {
    const target = conversationId ? String(conversationId) : null;
    if (!target) {
      currentTargetRef.current = null;
      settledForRef.current = null;
      inFlightRef.current = null;
      retryCountRef.current = { conversationId: "", count: 0 };
      setResult(null);
      return;
    }
    if (currentTargetRef.current !== target) {
      currentTargetRef.current = target;
      settledForRef.current = null;
      inFlightRef.current = null;
      retryCountRef.current = { conversationId: target, count: 0 };
      setResult(null);
    }
  }, [conversationId]);

  useWatchEffect(() => {
    if (!enabled || !conversationId) return;
    const target = String(conversationId);
    if (settledForRef.current === target) return;

    const ac = new AbortController();
    let entry =
      inFlightRef.current?.conversationId === target
        ? inFlightRef.current
        : null;
    if (!entry) {
      const promise = convex
        .query(api.lateJoinSummary.get, { conversation_id: conversationId })
        .then(
          (data) => {
            if (inFlightRef.current?.promise === promise) {
              inFlightRef.current = null;
            }
            return (data ?? null) as LateJoinSummary | null;
          },
          (error) => {
            if (inFlightRef.current?.promise === promise) {
              inFlightRef.current = null;
            }
            throw error;
          },
        );
      entry = { conversationId: target, promise };
      inFlightRef.current = entry;
    }

    void entry.promise.then(
      (summary) => {
        if (ac.signal.aborted || currentTargetRef.current !== target) return;
        settledForRef.current = target;
        setResult({ conversationId: target, summary });
      },
      () => {
        if (ac.signal.aborted || currentTargetRef.current !== target) return;
        const retries =
          retryCountRef.current.conversationId === target
            ? retryCountRef.current.count
            : 0;
        if (retries < MAX_RETRIES) {
          retryCountRef.current = {
            conversationId: target,
            count: retries + 1,
          };
          setRetryTick((n) => n + 1);
        } else {
          settledForRef.current = target;
        }
      },
    );

    return () => {
      ac.abort();
    };
  }, [enabled, conversationId, convex, retryTick]);

  if (!enabled || !conversationId) return undefined;
  if (!result || result.conversationId !== String(conversationId)) {
    return undefined;
  }
  return result.summary;
}

export function useLateJoinSummaryController({
  conversationId,
  visitKey,
  guest,
  newSessionPage,
  pendingPermissions,
  loadedMessageIds,
  scrollToMessageById,
  onJumpToTimestamp,
  hasMoreBelow,
  onJumpToEnd,
  setJumpPending,
  setUserScrolled,
  setGuestStayAtTop,
  jumpDirectionRef,
  paginationCooldownRef,
  scrollToEdgeRef,
  containerRef,
}: {
  conversationId: Id<"conversations"> | null;
  visitKey: string | null;
  guest: boolean;
  newSessionPage: boolean;
  pendingPermissions: readonly unknown[] | undefined;
  loadedMessageIds: ReadonlySet<string>;
  scrollToMessageById: (id: string) => void;
  onJumpToTimestamp?: (ts: number) => void;
  hasMoreBelow?: boolean;
  onJumpToEnd?: () => void;
  setJumpPending: (v: "start" | "end" | null) => void;
  setUserScrolled: (v: boolean) => void;
  setGuestStayAtTop: (v: boolean) => void;
  jumpDirectionRef: RefObject<"start" | "end" | null>;
  paginationCooldownRef: RefObject<number>;
  scrollToEdgeRef: RefObject<(edge: "top" | "bottom") => void>;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const enabled = isLateJoinSummaryEnabled();
  const [reachedBottom, setReachedBottom] = useState(false);
  const sawAwayFromBottomRef = useRef(false);

  const summaryRaw = useLateJoinSummary(
    conversationId,
    enabled && !guest && !newSessionPage && !reachedBottom,
  );

  const summary = useMemo(() => {
    if (!summaryRaw) return summaryRaw;
    if (
      summaryRaw.open_prompt?.source === "pending_permission" &&
      pendingPermissions !== undefined &&
      pendingPermissions.length === 0
    ) {
      return { ...summaryRaw, open_prompt: null };
    }
    return summaryRaw;
  }, [summaryRaw, pendingPermissions]);

  useWatchEffect(() => {
    if (!enabled) return;
    setReachedBottom(false);
    sawAwayFromBottomRef.current = false;
  }, [enabled, visitKey]);

  const markReachedBottom = useCallback(() => {
    if (!enabled) return;
    setReachedBottom(true);
  }, [enabled]);

  const noteScrollPosition = useCallback(
    (
      isAtBottom: boolean,
      moreBelow: boolean,
      noPendingJump: boolean,
      readerMovingDown: boolean,
    ) => {
      if (!enabled) return;
      if (!isAtBottom || moreBelow) {
        sawAwayFromBottomRef.current = true;
      } else if (
        noPendingJump &&
        (sawAwayFromBottomRef.current || readerMovingDown)
      ) {
        setReachedBottom(true);
      }
    },
    [enabled],
  );

  const handleJumpAnchor = useCallback(
    (messageId: string, timestamp: number) => {
      sawAwayFromBottomRef.current = true;
      if (loadedMessageIds.has(messageId) || !onJumpToTimestamp) {
        scrollToMessageById(messageId);
      } else {
        onJumpToTimestamp(timestamp);
      }
    },
    [loadedMessageIds, scrollToMessageById, onJumpToTimestamp],
  );

  const handleJumpPrompt = useCallback(
    (prompt: NonNullable<LateJoinSummary["open_prompt"]>) => {
      if (prompt.message_id) {
        sawAwayFromBottomRef.current = true;
        if (
          loadedMessageIds.has(prompt.message_id) ||
          !onJumpToTimestamp ||
          prompt.timestamp === undefined
        ) {
          scrollToMessageById(prompt.message_id);
        } else {
          onJumpToTimestamp(prompt.timestamp);
        }
        return;
      }
      setReachedBottom(true);
      if (hasMoreBelow && onJumpToEnd) {
        jumpDirectionRef.current = "end";
        setJumpPending("end");
        setGuestStayAtTop(false);
        onJumpToEnd();
      } else {
        setGuestStayAtTop(false);
        setUserScrolled(false);
        paginationCooldownRef.current = Date.now() + 1000;
        scrollToEdgeRef.current("bottom");
        const dock = containerRef.current
          ?.closest("main")
          ?.querySelector<HTMLElement>("[data-cc-permission-dock]");
        dock?.scrollIntoView?.({ block: "nearest" });
      }
    },
    [
      loadedMessageIds,
      scrollToMessageById,
      onJumpToTimestamp,
      hasMoreBelow,
      onJumpToEnd,
      jumpDirectionRef,
      setJumpPending,
      setUserScrolled,
      setGuestStayAtTop,
      paginationCooldownRef,
      scrollToEdgeRef,
      containerRef,
    ],
  );

  return {
    visible: enabled && !guest && !reachedBottom && hasLateJoinUpdates(summary),
    summary,
    markReachedBottom,
    noteScrollPosition,
    handleJumpAnchor,
    handleJumpPrompt,
  };
}
