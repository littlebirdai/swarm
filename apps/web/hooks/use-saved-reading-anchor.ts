import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { startReadingAnchorClaim } from "../lib/reading-anchor-claims";
import { isConvexId } from "../lib/entityLinks";
import { msUntilInputQuiet, TYPING_QUIET_MS } from "../lib/inputQuiet";
import type { ReadingAnchorsSlice } from "../store/reading-anchors-slice";
import { useInboxStore } from "../store/inboxStore";
import { useTabVisible } from "./usePagePresence";
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
  startRestoreDeadline: (expire: () => void) => void;
  sawWindowLoading: boolean;
  restore: "pending" | "waiting" | "done";
};

function dropSavedReadingAnchor(id: string) {
  useInboxStore.getState().dropSavedReadingAnchor(id);
}

function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

const readVisibility = () => document.visibilityState === "visible";
const hiddenOnServer = () => false;

const CHECKPOINT_MS = 30_000;
const RESTORE_LIMIT_MS = 5000;
const materiallyDifferent = (a: Position, b: Position | null) =>
  !b || a.message_id !== b.message_id || Math.abs(a.offset - b.offset) >= 0.05;

function createReadingVisit(
  active: Id<"conversations">,
  key: string,
  restored: boolean,
  save: ReadingAnchorsSlice["saveSavedReadingAnchor"],
) {
  const lifetime = new AbortController();
  const { claim, end } = startReadingAnchorClaim();
  let wiring: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let viewId: string | null | undefined;
  let initial: Position | null = null;
  let sequence = 0;
  let checkpoint: ReturnType<typeof setTimeout> | undefined;
  let restoreDeadline: ReturnType<typeof setTimeout> | undefined;
  let latest: Position | null = null;
  let lastSent: Position | null = null;
  const acquire = () => {
    if (lifetime.signal.aborted) return;
    const store = useInboxStore.getState();
    if (!store._isDispatchWired()) {
      wiring = setTimeout(acquire, 100);
      return;
    }
    void store
      .beginSavedReadingAnchor(active, claim)
      .then((id) => {
        if (!lifetime.signal.aborted) viewId = id;
      })
      .catch(() => {});
  };
  acquire();
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
    sawWindowLoading: false,
    restore: restored ? "done" : "pending",
    confirmed(position) {
      if (!ready) lastSent = position;
      ready = true;
    },
    startRestoreDeadline(expire) {
      restoreDeadline ??= setTimeout(expire, RESTORE_LIMIT_MS);
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
      if (scrolled) latest = position;
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
    end();
    clearTimeout(wiring);
    clearTimeout(restoreDeadline);
    clearTimeout(checkpoint);
    flush(viewId, true);
  };
  return { current, finish };
}

export function useSavedReadingAnchor({
  conversationId,
  userId,
  restore,
  loadingWindow,
}: {
  conversationId: Id<"conversations"> | null;
  userId: string | undefined;
  loadingWindow?: boolean;
  restore: (
    anchor: SavedReadingAnchor,
    requestedWindow: boolean,
    expired: boolean,
    windowLoaded: boolean,
  ) => "restored" | "loading" | "requested" | "fallback";
}) {
  const tabVisible = useTabVisible();
  const visible = useSyncExternalStore(
    subscribeVisibility,
    readVisibility,
    hiddenOnServer,
  );
  const active = tabVisible && visible && userId ? conversationId : null;
  const mountedKey =
    conversationId && userId ? `${userId}:${conversationId}` : "";
  const key = active ? mountedKey : "";
  const restoredKey = useRef("");
  useWatchEffect(() => {
    restoredKey.current = "";
  }, [mountedKey]);
  const restoreRef = useRef(restore);
  useWatchEffect(() => {
    restoreRef.current = restore;
  }, [restore]);
  const response = useQueryNoThrow(
    api.conversationReadAnchors.get,
    active ? { conversation_id: active } : "skip",
    { breakAfterMs: RESTORE_LIMIT_MS },
  );
  const visit = useRef<Visit | null>(null);

  useWatchEffect(() => {
    if (!active) return;
    const { saveSavedReadingAnchor } = useInboxStore.getState();
    const { current, finish } = createReadingVisit(
      active,
      key,
      restoredKey.current === key,
      saveSavedReadingAnchor,
    );
    visit.current = current;
    window.addEventListener("pagehide", finish);
    return () => {
      finish();
      window.removeEventListener("pagehide", finish);
      dropSavedReadingAnchor(active);
      visit.current = null;
    };
  }, [active, key]);

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
    if (!current || current.key !== key) return;
    if (response.error || response.data === null) {
      if (!response.error) current.confirmed(null);
      restoredKey.current = key;
      current.restore = "done";
      return;
    }
    const saved = active
      ? useInboxStore.getState().sessionReadAnchors[active]
      : undefined;
    if (!response.data || saved?.user_id !== userId || !saved) return;
    current.confirmed(saved);
    if (current.restore === "done") return;
    current.startRestoreDeadline(() => {
      if (current.restore === "done") return;
      const requested = current.restore === "waiting";
      current.restore = "done";
      restoredKey.current = key;
      restoreRef.current(saved, requested, true, false);
    });
    const requested = current.restore === "waiting";
    if (requested && loadingWindow === true) current.sawWindowLoading = true;
    const result = restore(
      saved,
      requested,
      false,
      current.sawWindowLoading && loadingWindow === false,
    );
    if (result === "loading") return;
    if (result === "requested") {
      current.sawWindowLoading = loadingWindow === true;
      current.restore = "waiting";
      return;
    }
    restoredKey.current = key;
    if (result === "restored") current.placed();
    current.restore = "done";
  }, [
    key,
    active,
    userId,
    response.data,
    response.error,
    restore,
    loadingWindow,
  ]);

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
