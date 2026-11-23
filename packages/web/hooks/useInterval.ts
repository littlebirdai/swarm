import { visibleInterval } from "../lib/windowVisibleWork";
import { useEffect, useRef } from "react";

/**
 * Run `tick` every `ms` while `active` and visible. The newest `tick` runs on each beat,
 * so a caller can pass a fresh closure every render without restarting the clock.
 */
export function useInterval(tick: () => void, ms: number, active = true) {
  const latest = useRef(tick);
  latest.current = tick;
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!active) return;
    return visibleInterval(() => latest.current(), ms);
  }, [active, ms]);
}
