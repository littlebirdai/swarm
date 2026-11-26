import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useMutation, type ReactMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useRef } from "react";
import { isConvexId } from "../lib/entityLinks";
import { msUntilInputQuiet, TYPING_QUIET_MS } from "../lib/inputQuiet";
import { useInboxStore } from "../store/inboxStore";
import { usePageReading } from "./usePagePresence";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

export type SavedReadingAnchor = NonNullable<
  FunctionReturnType<typeof api.conversationReadAnchors.get>
>;

type Position = Pick<SavedReadingAnchor, "message_id" | "offset">;
type Visit = {
  key: string;
  observe: (position: Position, scrolled: boolean) => void;
  confirmed: (position: Position | null) => void;
  placed: () => void;
  restore: "pending" | "waiting" | "done";
};

function dropSavedReadingAnchor(id: string) {
  const rows = useInboxStore.getState().sessionReadAnchors;
  if (!rows[id]) return;
  const next = { ...rows };
  delete next[id];
  useInboxStore.setState({ sessionReadAnchors: next });
}

const CHECKPOINT_MS = 30_000;
const RESTORE_LIMIT_MS = 5000;
const materiallyDifferent = (a: Position, b: Position | null) =>
  !b || a.message_id !== b.message_id || Math.abs(a.offset - b.offset) >= 0.05;

function createReadingVisit(
  active: Id<"conversations">,
  key: string,
  acquired: Promise<string | null>,
  save: ReactMutation<typeof api.conversationReadAnchors.save>,
) {
  const lifetime = new AbortController();
  let ready = false;
  let viewId: string | null | undefined;
  let initial: Position | null = null;
  let sequence = 0;
  let checkpoint: ReturnType<typeof setTimeout> | undefined;
  let latest: Position | null = null;
  let lastSent: Position | null = null;
  void acquired.then((id) => {
    if (!lifetime.signal.aborted) viewId = id;
  });
  const flush = (id: string | null | undefined, final = false) => {
    if (!id || !ready || !latest || current.restore !== "done") return;
    if (final) {
      if (
        latest.message_id === lastSent?.message_id &&
        latest.offset === lastSent.offset
      )
        return;
    } else if (!materiallyDifferent(latest, lastSent)) return;
    const position = latest;
    const previous = lastSent;
    lastSent = position;
    void save({
      ...position,
      conversation_id: active,
      view_id: id,
      sequence: ++sequence,
    })
      .then((result) => {
        if (!lifetime.signal.aborted && result === "stale") viewId = null;
        if (!lifetime.signal.aborted && result === "unavailable") {
          viewId = null;
          dropSavedReadingAnchor(active);
        }
      })
      .catch(() => {
        if (lastSent === position) lastSent = previous;
      });
  };
  const checkpointWhenQuiet = () => {
    const wait = msUntilInputQuiet(TYPING_QUIET_MS);
    if (wait > 0) {
      checkpoint = setTimeout(checkpointWhenQuiet, wait);
      return;
    }
    checkpoint = undefined;
    flush(viewId);
  };
  const current: Visit = {
    key,
    restore: "pending",
    confirmed(position) {
      if (!ready) lastSent = position;
      ready = true;
    },
    placed() {
      latest = null;
      clearTimeout(checkpoint);
      checkpoint = undefined;
    },
    observe(position, scrolled) {
      if (lifetime.signal.aborted || current.restore === "waiting") return;
      const baseline = lastSent ?? initial;
      initial ??= position;
      latest = position;
      if (
        scrolled &&
        baseline &&
        materiallyDifferent(position, baseline) &&
        checkpoint === undefined
      )
        checkpoint = setTimeout(checkpointWhenQuiet, CHECKPOINT_MS);
    },
  };
  const finish = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    clearTimeout(checkpoint);
    if (viewId === undefined) void acquired.then((id) => flush(id, true));
    else flush(viewId, true);
  };
  return { current, finish };
}

export function useSavedReadingAnchor({
  conversationId,
  userId,
  enabled,
  restore,
}: {
  conversationId: Id<"conversations"> | null;
  userId: string | undefined;
  enabled: boolean;
  restore: (
    anchor: SavedReadingAnchor,
    requestedWindow: boolean,
  ) => "restored" | "loading" | "requested" | "fallback";
}) {
  const reading = usePageReading();
  const active = enabled && reading && userId ? conversationId : null;
  const key = active ? `${userId}:${active}` : "";
  const begin = useMutation(api.conversationReadAnchors.begin);
  const save = useMutation(api.conversationReadAnchors.save);
  const response = useQueryNoThrow(
    api.conversationReadAnchors.get,
    active ? { conversation_id: active } : "skip",
    { breakAfterMs: RESTORE_LIMIT_MS },
  );
  const visit = useRef<Visit | null>(null);

  useWatchEffect(() => {
    if (!active) return;
    const acquired = begin({ conversation_id: active }).catch(() => null);
    const { current, finish } = createReadingVisit(active, key, acquired, save);
    visit.current = current;
    window.addEventListener("pagehide", finish);
    return () => {
      finish();
      window.removeEventListener("pagehide", finish);
      dropSavedReadingAnchor(active);
      visit.current = null;
    };
  }, [active, key, begin, save]);

  useWatchEffect(() => {
    if (!active) return;
    const state = useInboxStore.getState();
    const answer = response.data;
    if (answer && answer.user_id === userId)
      state.syncRecord("sessionReadAnchors", active, answer);
    else if (answer !== undefined || response.error)
      dropSavedReadingAnchor(active);
  }, [active, userId, response.data, response.error]);

  useWatchEffect(() => {
    const current = visit.current;
    if (!current || current.key !== key || current.restore === "done") return;
    if (response.error || response.data === null) {
      if (!response.error) current.confirmed(null);
      current.restore = "done";
      return;
    }
    const saved = active
      ? useInboxStore.getState().sessionReadAnchors[active]
      : undefined;
    if (!response.data || saved?.user_id !== userId || !saved) return;
    current.confirmed(saved);
    const result = restore(saved, current.restore === "waiting");
    if (result === "restored") current.placed();
    if (result === "requested") current.restore = "waiting";
    else if (result !== "loading") current.restore = "done";
  }, [key, active, userId, response.data, response.error, restore]);

  const observe = useCallback(
    (messageId: string, offset: number, scrolled: boolean) => {
      const current = visit.current;
      if (current?.key !== key || !isConvexId(messageId)) return;
      current.observe(
        { message_id: messageId as Id<"messages">, offset },
        scrolled,
      );
    },
    [key],
  );
  return active ? observe : null;
}
