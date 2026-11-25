import type {
  RelayClientFrame,
  RelayGrantClaims,
  RelayServerFrame,
} from "@codecast/relay-contract";

export type Signal = Extract<RelayServerFrame, { seq: number }>;
export type ClientSignal = Extract<RelayClientFrame, { type: Signal["type"] }>;

export type Publication = {
  frame: Signal;
  sourceTtl: (now: number, monotonicNow: bigint) => number;
};

export function stampSignal(
  signal: ClientSignal,
  owner: RelayGrantClaims["subject"],
  connectionId: string,
  seq: number,
  ttl: number,
): Signal {
  const base = { connection_id: connectionId, seq, ttl_ms: ttl };
  switch (signal.type) {
    case "presence":
      return signal.state === "left"
        ? { ...signal, ...base, ttl_ms: 0, user_id: owner.id }
        : { ...signal, ...base, user_id: owner.id };
    case "session_liveness":
      return { ...signal, ...base, machine_id: owner.id };
    case "machine_liveness":
      return { ...signal, ...base };
    default:
      return { ...signal, ...base, user_id: owner.id };
  }
}

export function signalTtl(signal: ClientSignal, ttl: number): number {
  const clear =
    (signal.type === "presence" && signal.state === "left") ||
    ("cursor" in signal && signal.cursor === null);
  return clear ? 0 : ttl;
}

export function publicationFor(
  frame: Signal,
  sourceDeadline: number,
  currentDeadline: () => number,
  sentAt: bigint,
): Publication {
  return {
    frame,
    sourceTtl: (now, monotonicNow) =>
      frame.ttl_ms === 0
        ? 0
        : Math.min(
            sourceDeadline - now,
            currentDeadline() - now,
            frame.ttl_ms - Number(monotonicNow - sentAt) / 1e6,
          ),
  };
}

export function signalAtSend(
  publication: Publication,
  recipientTtl: number,
  now: number,
  monotonicNow: bigint,
): Signal | null {
  if (!(recipientTtl > 0)) return null;
  const { frame } = publication;
  if (frame.ttl_ms === 0) return frame;
  const ttl = Math.floor(
    Math.min(recipientTtl, publication.sourceTtl(now, monotonicNow)),
  );
  return ttl > 0 ? ({ ...frame, ttl_ms: ttl } as Signal) : null;
}
