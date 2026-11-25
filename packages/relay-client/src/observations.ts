import type { RelayServerFrame } from "@codecast/relay-contract";

export type RelaySignal = Extract<RelayServerFrame, { seq: number }>;
export type RelayEvent =
  | { type: "signal"; signal: RelaySignal }
  | { type: "removed"; signal: RelaySignal };
export type RelayHandler = (event: RelayEvent) => void;

export const MAX_TIMER_MS = 2_147_483_647;
const MAX_OBSERVATIONS = 4096;

export function hubKey(hub: RelaySignal["hub"]) {
  return `${hub.kind}/${hub.id}`;
}

type Observation = {
  hub: string;
  seq: number;
  signal?: RelaySignal;
  expires: number;
};

export function observations(
  now: () => number,
  setTimer: (callback: () => void, delayMs: number) => () => void,
  emit: (key: string, event: RelayEvent) => void,
) {
  const entries = new Map<string, Observation>();
  let cancelTimer: (() => void) | undefined;
  let nextExpiry = Infinity;

  function remove(entry: Observation) {
    const signal = entry.signal;
    entry.signal = undefined;
    entry.expires = Infinity;
    return signal;
  }

  function notifyRemoved(entry: Observation) {
    const signal = remove(entry);
    if (signal) emit(entry.hub, { type: "removed", signal });
  }

  function expire() {
    cancelTimer = undefined;
    nextExpiry = Infinity;
    for (const entry of entries.values()) {
      if (entry.expires <= now()) notifyRemoved(entry);
      nextExpiry = Math.min(nextExpiry, entry.expires);
    }
    if (!cancelTimer && nextExpiry < Infinity) {
      cancelTimer = setTimer(
        expire,
        Math.min(MAX_TIMER_MS, nextExpiry - now()),
      );
    }
  }

  return {
    receive(signal: RelaySignal) {
      const hub = hubKey(signal.hub);
      const peer = `${hub}/${signal.connection_id}`;
      const key = `${peer}/${signal.type}`;
      const prior = entries.get(key);
      if (prior && prior.seq >= signal.seq) return;
      const removed: Observation[] = [];
      if (signal.type === "presence" && signal.state === "left") {
        for (const type of ["draft_cursor", "reading_cursor"]) {
          const cursor = entries.get(`${peer}/${type}`);
          if (cursor?.signal) {
            removed.push({ ...cursor });
            remove(cursor);
          }
        }
      }
      const expires = signal.ttl_ms ? now() + signal.ttl_ms : Infinity;
      entries.delete(key);
      entries.set(key, {
        hub,
        seq: signal.seq,
        signal: signal.ttl_ms ? signal : undefined,
        expires,
      });
      if (entries.size > MAX_OBSERVATIONS) {
        const oldest = entries.entries().next().value;
        if (oldest) {
          entries.delete(oldest[0]);
          removed.push(oldest[1]);
        }
      }
      if (expires < nextExpiry) {
        cancelTimer?.();
        nextExpiry = expires;
        cancelTimer = setTimer(expire, Math.min(MAX_TIMER_MS, signal.ttl_ms));
      }
      for (const entry of removed) notifyRemoved(entry);
      emit(hub, { type: "signal", signal });
    },
    clear(hub?: string) {
      const removed = [];
      for (const [key, entry] of entries) {
        if (hub !== undefined && entry.hub !== hub) continue;
        entries.delete(key);
        removed.push(entry);
      }
      if (!entries.size) {
        cancelTimer?.();
        cancelTimer = undefined;
        nextExpiry = Infinity;
      }
      for (const entry of removed) notifyRemoved(entry);
    },
  };
}
