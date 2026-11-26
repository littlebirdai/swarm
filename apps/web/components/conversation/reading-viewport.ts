import { type Virtualizer } from "@tanstack/react-virtual";
import type { SavedReadingAnchor } from "../../hooks/use-saved-reading-anchor";
import { hasCoPresent } from "../../lib/composerPresence";
import { anchorFromRects } from "../../lib/follow";
import { messageRowKey } from "../../lib/messageRowKey";
import { useInboxStore } from "../../store/inboxStore";
import { settleTimelineItemAtOffset } from "../conversationScroll";
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

export function restoreReadingPosition(
  anchor: SavedReadingAnchor,
  requestedWindow: boolean,
  {
    container,
    timeline,
    virtualizer,
    jumpToTimestamp,
    takePosition,
  }: {
    container: HTMLElement | null;
    timeline: readonly TimelineItem[];
    virtualizer: Parameters<typeof settleTimelineItemAtOffset>[1];
    jumpToTimestamp: ((timestamp: number) => void) | undefined;
    takePosition: () => void;
  },
) {
  if (!container || !timeline.length) return "loading";
  const index = timeline.findIndex(
    (item) => item.type === "message" && item.data._id === anchor.message_id,
  );
  const item = timeline[index];
  if (item?.type !== "message") {
    if (requestedWindow) return "loading";
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
