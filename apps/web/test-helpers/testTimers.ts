import { replaceGlobals } from "./globals";

export function trackTestTimers() {
  const schedule = globalThis.setTimeout;
  const scheduleInterval = globalThis.setInterval;
  const cancel = globalThis.clearTimeout;
  const cancelInterval = globalThis.clearInterval;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();

  const restore = replaceGlobals({
    setTimeout(
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) {
      const timer = schedule(() => {
        timeouts.delete(timer);
        callback(...args);
      }, delay);
      timeouts.add(timer);
      return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      timeouts.delete(timer);
      intervals.delete(timer);
      cancel(timer);
    },
    setInterval(
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) {
      const timer = scheduleInterval(callback, delay, ...args);
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer: ReturnType<typeof setInterval>) {
      timeouts.delete(timer);
      intervals.delete(timer);
      cancelInterval(timer);
    },
  });

  return () => {
    for (const timer of timeouts) cancel(timer);
    for (const timer of intervals) cancelInterval(timer);
    restore();
  };
}
