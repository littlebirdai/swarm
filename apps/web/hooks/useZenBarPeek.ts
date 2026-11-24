"use client";

// The zen top bar's peek: resting the pointer on the window's top edge slides
// the bar down, and leaving it (with none of its menus open) slides it away.
// The edge strip itself is ZenTopEdge (components/ZenBarPeek.tsx).

import { visibleInterval } from "../lib/windowVisibleWork";
import {
  useCallback,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { useWatchEffect } from "./useWatchEffect";

// Same dwell as the side peeks (EdgePeek): a pointer passing over the top edge
// on its way to the menu bar or another window opens nothing.
const PEEK_DWELL_MS = 280;
// How often a bar held open by one of its own menus checks whether to go.
const HOLD_CHECK_MS = 300;

/** A menu, popover or picker opened from the bar keeps it down: their layers
 *  portal outside the bar, so the pointer moving into one is not a leave. */
function barHoldsMenu(bar: HTMLElement | null): boolean {
  return !!bar?.querySelector('[aria-expanded="true"], [data-state="open"]');
}

export function useZenBarPeek(
  enabled: boolean,
  barRef: RefObject<HTMLElement | null>,
) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopMenuPoll = useRef<(() => void) | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stopMenuPoll.current?.();
    stopMenuPoll.current = null;
  };
  // The bar goes once the pointer is off it and none of its menus is open.
  const onBarLeave = useCallback(() => {
    clear();
    const closeWhenFree = () => {
      if (barHoldsMenu(barRef.current)) return;
      clear();
      setOpen(false);
    };
    stopMenuPoll.current = visibleInterval(closeWhenFree, HOLD_CHECK_MS);
    if (!document.hidden) closeWhenFree();
  }, [barRef]);
  const onEdgeEnter = useCallback((e: MouseEvent) => {
    clear();
    if (e.buttons !== 0) return;
    timer.current = setTimeout(() => setOpen(true), PEEK_DWELL_MS);
  }, []);
  const onEdgeLeave = useCallback(() => {
    if (!open) clear();
  }, [open]);
  const onBarEnter = useCallback(() => {
    clear();
  }, []);
  // Leaving zen (or the bar becoming an app window's) drops the peek.
  useWatchEffect(() => {
    if (!enabled) {
      clear();
      setOpen(false);
    }
  }, [enabled]);
  useWatchEffect(() => () => clear(), []);
  const shown = enabled && open;
  // What the bar itself carries while zen hides it (globals.css styles these).
  const barProps = enabled
    ? {
        "data-zen-bar": shown ? "open" : "closed",
        "data-flyout": "",
        onMouseEnter: onBarEnter,
        onMouseLeave: onBarLeave,
      }
    : {};
  return {
    open: shown,
    barProps,
    onEdgeEnter,
    onEdgeLeave,
    onBarEnter,
    onBarLeave,
  };
}
