import { replaceGlobals } from "./globals";

type PendingTimer = {
  kind: "timeout" | "interval";
  delay: number;
  callback: string;
};

export function trackTestTimers() {
  const schedule = globalThis.setTimeout;
  const scheduleInterval = globalThis.setInterval;
  const cancel = globalThis.clearTimeout;
  const cancelInterval = globalThis.clearInterval;
  const timeouts = new Map<ReturnType<typeof setTimeout>, PendingTimer>();
  const intervals = new Map<ReturnType<typeof setInterval>, PendingTimer>();

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
      timeouts.set(timer, {
        kind: "timeout",
        delay: delay ?? 0,
        callback: callback.name,
      });
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
      intervals.set(timer, {
        kind: "interval",
        delay: delay ?? 0,
        callback: callback.name,
      });
      return timer;
    },
    clearInterval(timer: ReturnType<typeof setInterval>) {
      timeouts.delete(timer);
      intervals.delete(timer);
      cancelInterval(timer);
    },
  });

  const pending: PendingTimer[] = [];
  return {
    pending: pending as readonly PendingTimer[],
    close() {
      pending.push(...timeouts.values(), ...intervals.values());
      for (const timer of timeouts.keys()) cancel(timer);
      for (const timer of intervals.keys()) cancelInterval(timer);
      restore();
    },
  };
}
