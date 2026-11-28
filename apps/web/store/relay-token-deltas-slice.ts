import type { RelayHubStatus, RelaySignal } from "@codecast/relay-client";
import { sync } from "./mutativeMiddleware";

const MAX_ENTRIES_PER_CONVERSATION = 24;

export type RelayTokenDeltaSignal = Extract<
  RelaySignal,
  { type: "token_delta" }
>;

export type RelayTokenStreamEntry = {
  run: number;
  turn: string;
  messageId: string;
  nextSeq: number;
  text: string;
  dropped: boolean;
};

export type RelayTokenStreamState = {
  run: number;
  order: string[];
  entries: Record<string, RelayTokenStreamEntry>;
};

export type RelayTokenDeltasState = Record<
  string,
  RelayTokenStreamState | undefined
>;

export type RelayTokenDeltasSlice = {
  applyRelayTokenDeltaSignal: (
    conversationId: string,
    signal: RelayTokenDeltaSignal,
  ) => void;
  applyRelayTokenDeltaStatus: (
    conversationId: string,
    status: RelayHubStatus | "disabled",
  ) => void;
  pruneRelayTokenStreams: (
    conversationId: string,
    durableMessageUuids: ReadonlySet<string>,
    clearAll: boolean,
  ) => void;
};

type RelayTokenDeltasDraft = {
  relayTokenDeltas: RelayTokenDeltasState;
};

const EMPTY_STREAMS: readonly RelayTokenStreamEntry[] = [];

function streamKey(turn: string, messageId: string): string {
  return `${turn}\0${messageId}`;
}

export function reduceRelayTokenDeltaSignal(
  prev: RelayTokenStreamState | undefined,
  signal: RelayTokenDeltaSignal,
): RelayTokenStreamState | undefined {
  if (prev && signal.run < prev.run) return prev;
  const base: RelayTokenStreamState =
    !prev || signal.run > prev.run
      ? { run: signal.run, order: [], entries: {} }
      : prev;
  const key = streamKey(signal.turn, signal.message_id);
  const existing = base.entries[key];

  if (!existing) {
    const dropped = signal.delta_seq !== 1;
    const order = [...base.order, key];
    const entries: Record<string, RelayTokenStreamEntry> = {
      ...base.entries,
      [key]: {
        run: signal.run,
        turn: signal.turn,
        messageId: signal.message_id,
        nextSeq: signal.delta_seq + 1,
        text: dropped ? "" : signal.text,
        dropped,
      },
    };
    while (order.length > MAX_ENTRIES_PER_CONVERSATION) {
      const oldest = order.shift();
      if (oldest !== undefined) delete entries[oldest];
    }
    return { run: base.run, order, entries };
  }

  if (existing.dropped) return base;

  if (signal.delta_seq !== existing.nextSeq) {
    return {
      run: base.run,
      order: base.order,
      entries: {
        ...base.entries,
        [key]: {
          ...existing,
          text: "",
          dropped: true,
        },
      },
    };
  }

  return {
    run: base.run,
    order: base.order,
    entries: {
      ...base.entries,
      [key]: {
        ...existing,
        nextSeq: existing.nextSeq + 1,
        text: existing.text + signal.text,
      },
    },
  };
}

export function selectVisibleRelayTokenStreams(
  state: RelayTokenStreamState | undefined,
  durableMessageUuids: ReadonlySet<string>,
  turnOpen: boolean,
): readonly RelayTokenStreamEntry[] {
  if (!turnOpen || !state) return EMPTY_STREAMS;
  const visible: RelayTokenStreamEntry[] = [];
  for (const key of state.order) {
    const entry = state.entries[key];
    if (!entry || entry.dropped || !entry.text) continue;
    if (durableMessageUuids.has(entry.messageId)) continue;
    visible.push(entry);
  }
  return visible;
}

export function createRelayTokenDeltasSlice(): RelayTokenDeltasSlice {
  return {
    applyRelayTokenDeltaSignal: sync(function (
      this: RelayTokenDeltasDraft,
      conversationId: string,
      signal: RelayTokenDeltaSignal,
    ) {
      const current = this.relayTokenDeltas[conversationId];
      const next = reduceRelayTokenDeltaSignal(current, signal);
      if (next !== current) this.relayTokenDeltas[conversationId] = next;
    }),
    applyRelayTokenDeltaStatus: sync(function (
      this: RelayTokenDeltasDraft,
      conversationId: string,
      status: RelayHubStatus | "disabled",
    ) {
      if (
        status !== "unavailable" &&
        status !== "denied" &&
        status !== "disabled"
      )
        return;
      delete this.relayTokenDeltas[conversationId];
    }),
    pruneRelayTokenStreams: sync(function (
      this: RelayTokenDeltasDraft,
      conversationId: string,
      durableMessageUuids: ReadonlySet<string>,
      clearAll: boolean,
    ) {
      const current = this.relayTokenDeltas[conversationId];
      if (!current) return;
      if (clearAll) {
        delete this.relayTokenDeltas[conversationId];
        return;
      }
      const remainingKeys = current.order.filter((key) => {
        const entry = current.entries[key];
        return entry && !durableMessageUuids.has(entry.messageId);
      });
      if (remainingKeys.length === current.order.length) return;
      if (remainingKeys.length === 0) {
        delete this.relayTokenDeltas[conversationId];
        return;
      }
      const entries: Record<string, RelayTokenStreamEntry> = {};
      for (const key of remainingKeys) {
        const entry = current.entries[key];
        if (entry) entries[key] = entry;
      }
      this.relayTokenDeltas[conversationId] = {
        run: current.run,
        order: remainingKeys,
        entries,
      };
    }),
  };
}
