import type { RelayPublication } from "../src";

export const session = { kind: "session", id: "session" } as const;
export const second = { kind: "session", id: "second" } as const;
export const presence = {
  type: "presence",
  v: 1,
  hub: session,
  state: "active",
  in_draft: false,
} as const satisfies RelayPublication;

export const cursor = {
  type: "draft_cursor",
  v: 1,
  hub: session,
  cursor: { revision: 1, anchor: 0, head: 1 },
} as const satisfies RelayPublication;

export function fakeClock() {
  let time = 10_000;
  const timers = new Map<() => void, number>();
  return {
    now: () => time,
    setTimer(callback: () => void, delayMs: number) {
      const run = () => callback();
      timers.set(run, time + delayMs);
      return () => {
        timers.delete(run);
      };
    },
    get timerCount() {
      return timers.size;
    },
    get deadline() {
      return Math.min(...timers.values());
    },
    async advance(ms: number) {
      const target = time + ms;
      let steps = 0;
      while (true) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0];
        if (!next || next[1] > target) break;
        if (++steps > 10_000) throw new Error("Timer loop");
        const [callback, at] = next;
        time = at;
        timers.delete(callback);
        callback();
        await Promise.resolve();
      }
      time = target;
      await Promise.resolve();
    },
  };
}

export const fakeGrant = {
  status: "ok",
  url: "ws://relay.invalid/relay",
  token: "token",
  omitted: [],
} as const;
