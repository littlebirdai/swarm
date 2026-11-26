import { type Virtualizer } from "@tanstack/react-virtual";
import type { SavedReadingAnchor } from "../../hooks/use-saved-reading-anchor";
import { hasCoPresent } from "../../lib/composerPresence";
import { anchorFromRects } from "../../lib/follow";
import { messageRowKey } from "../../lib/messageRowKey";
import { useInboxStore } from "../../store/inboxStore";
import {
  jumpRowForMessage,
  READER_SCROLL_WINDOW_MS,
  settleTimelineItemAtOffset,
} from "../conversationScroll";
import type { TimelineItem } from "./types";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, Element>;

// The virtualizer holds each mounted row by key; a selector walk over the
// feed per row per frame cost more than the boxes themselves.
export function mountedTranscriptRow(
  virtualizer: Pick<TranscriptVirtualizer, "elementsCache">,
  item: { key: string | number | bigint; index: number },
) {
  const node = virtualizer.elementsCache.get(item.key) as
    | HTMLElement
    | undefined;
  return node?.isConnected && node.dataset.index === String(item.index)
    ? node
    : null;
}

export function transcriptViewportRects(
  virtualizer: Pick<TranscriptVirtualizer, "elementsCache">,
  virtualItems: ReturnType<TranscriptVirtualizer["getVirtualItems"]>,
) {
  const rects = [];
  for (const v of virtualItems) {
    const domEl = mountedTranscriptRow(virtualizer, v);
    if (!domEl) continue;
    const r = domEl.getBoundingClientRect();
    rects.push({ index: v.index, top: r.top, bottom: r.bottom });
  }
  return rects;
}

export function publishReadingPosition(
  conversationId: string | undefined,
  observe:
    | ((messageId: string, offset: number, scrolled: boolean) => void)
    | null,
  scrolled: boolean,
  ...rects: Parameters<typeof anchorFromRects>
) {
  const store = useInboxStore.getState();
  const sharePosition =
    conversationId &&
    (store.followedBy.length > 0 || hasCoPresent(conversationId));
  if (!sharePosition && !observe) return;
  const anchor = anchorFromRects(...rects);
  if (sharePosition)
    store.setViewAnchor(anchor ? { conversationId, ...anchor } : null);
  if (observe && anchor) observe(anchor.messageId, anchor.offset, scrolled);
}

export function readingRowForMessage(
  id: string,
  density: Parameters<typeof jumpRowForMessage>[1],
  aggregates: Parameters<typeof jumpRowForMessage>[2] & {
    lastTextOf: ReadonlyMap<string, string>;
    firstAssistOf: ReadonlyMap<string, string>;
  },
  expandedGroups: ReadonlySet<string>,
) {
  const { scrollToId, expandKey } = jumpRowForMessage(id, density, aggregates);
  if (density !== "compact" || !expandKey || expandedGroups.has(expandKey))
    return scrollToId;
  return (
    aggregates.lastTextOf.get(expandKey) ??
    aggregates.firstAssistOf.get(expandKey) ??
    scrollToId
  );
}

export function restoreReadingPosition(
  anchor: SavedReadingAnchor,
  requestedWindow: boolean,
  {
    container,
    timeline,
    virtualizer,
    jumpToTimestamp,
    takePosition,
    resolveMessage = (id) => id,
    windowLoaded,
  }: {
    container: HTMLElement | null;
    timeline: readonly TimelineItem[];
    virtualizer: Parameters<typeof settleTimelineItemAtOffset>[1];
    jumpToTimestamp: ((timestamp: number) => void) | undefined;
    takePosition: () => void;
    resolveMessage?: (id: string) => string;
    windowLoaded?: boolean;
  },
) {
  if (!container || !timeline.some((item) => item.type === "message"))
    return requestedWindow && windowLoaded ? "fallback" : "loading";
  const messageId = resolveMessage(anchor.message_id);
  const index = timeline.findIndex(
    (item) => item.type === "message" && item.data._id === messageId,
  );
  const item = timeline[index];
  if (item?.type !== "message") {
    if (requestedWindow) return windowLoaded ? "fallback" : "loading";
    if (!jumpToTimestamp) return "fallback";
    jumpToTimestamp(anchor.timestamp);
    return "requested";
  }
  takePosition();
  settleTimelineItemAtOffset(container, virtualizer, index, 0, {
    offsetFraction: anchor.offset,
    initialDelayMs: 0,
    itemKey: messageRowKey(item.data),
  });
  return "restored";
}

export function watchReadingScroll(
  feed: HTMLElement,
  onScroll: (readerMoved: boolean) => void,
  watchInput = true,
) {
  if (!watchInput) {
    const scroll = () => onScroll(false);
    feed.addEventListener("scroll", scroll, { passive: true });
    return () => feed.removeEventListener("scroll", scroll);
  }
  let inputAt = -Infinity;
  let scrollbarHeld = false;
  const input = () => {
    inputAt = performance.now();
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY !== 0 && !event.ctrlKey) input();
  };
  const key = (event: KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest("input, textarea, select, button"))
    )
      return;
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key)
    )
      input();
  };
  const down = (event: PointerEvent) => {
    if (event.target === feed && event.offsetX > feed.clientWidth)
      scrollbarHeld = true;
  };
  const up = () => {
    scrollbarHeld = false;
  };
  const scroll = () => {
    onScroll(
      scrollbarHeld || performance.now() - inputAt < READER_SCROLL_WINDOW_MS,
    );
    inputAt = -Infinity;
  };
  feed.addEventListener("wheel", wheel, { passive: true });
  feed.addEventListener("touchmove", input, { passive: true });
  feed.addEventListener("keydown", key);
  feed.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  feed.addEventListener("scroll", scroll, { passive: true });
  return () => {
    feed.removeEventListener("wheel", wheel);
    feed.removeEventListener("touchmove", input);
    feed.removeEventListener("keydown", key);
    feed.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    feed.removeEventListener("scroll", scroll);
  };
}

export function observeComposerBand(
  feed: HTMLElement | null,
  setHeight: (height: number) => void,
) {
  // The floating scroll buttons sit just above everything below the feed —
  // composer, pinned state panel, a docked decision card — so measure that
  // whole band (pane bottom minus feed bottom), not the composer alone.
  // The feed is the flex-1 column child, so any change in the band resizes
  // it; observing feed + pane catches every case.
  const pane = feed?.closest("main");
  if (!feed || !pane) return;
  const measure = () =>
    setHeight(
      Math.max(
        0,
        Math.round(
          pane.getBoundingClientRect().bottom -
            feed.getBoundingClientRect().bottom,
        ),
      ),
    );
  // Measured in the observer's first callback (after layout, before paint);
  // a read on mount laid out the conversation the mount had just changed.
  if (typeof ResizeObserver === "undefined") {
    measure();
    return;
  }
  const ro = new ResizeObserver(measure);
  ro.observe(feed);
  ro.observe(pane);
  return () => ro.disconnect();
}
