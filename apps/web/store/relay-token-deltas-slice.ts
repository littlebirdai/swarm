import type { RelayHubStatus, RelaySignal } from "@codecast/relay-client";
import { sync } from "./mutativeMiddleware";

const MAX_ENTRIES_PER_CONVERSATION = 24;
const MAX_RETIRED_TURNS = 16;
export const MAX_STREAM_TEXT_BYTES = 64 * 1024;
const utf8Encoder = new TextEncoder();

export type RelayTokenDeltaSignal = Extract<
  RelaySignal,
  { type: "token_delta" }
>;

export type RelayTokenStreamEntry = {
  run: number;
  turn: string;
  messageId: string;
  nextSeq: number;
  bytes: number;
  text: string;
  dropped: boolean;
};

export type RelayTokenStreamState = {
  run: number;
  activeTurn: string;
  retiredTurns: string[];
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
    durableAssistantUuids: ReadonlySet<string>,
    baselineUuids: ReadonlySet<string>,
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

function appendRetiredTurn(
  retiredTurns: readonly string[],
  turn: string,
): string[] {
  if (retiredTurns.includes(turn)) return [...retiredTurns];
  const next = [...retiredTurns, turn];
  while (next.length > MAX_RETIRED_TURNS) next.shift();
  return next;
}

function hasDurableMatchForTurn(
  state: RelayTokenStreamState,
  durableAssistantUuids: ReadonlySet<string>,
  baselineUuids: ReadonlySet<string>,
): boolean {
  for (const id of durableAssistantUuids) {
    if (!baselineUuids.has(id)) return true;
  }
  for (const key of state.order) {
    const entry = state.entries[key];
    if (entry && durableAssistantUuids.has(entry.messageId)) return true;
  }
  return false;
}

export function reduceRelayTokenDeltaSignal(
  prev: RelayTokenStreamState | undefined,
  signal: RelayTokenDeltaSignal,
): RelayTokenStreamState | undefined {
  if (prev && signal.run < prev.run) return prev;
  if (
    prev &&
    signal.run === prev.run &&
    prev.retiredTurns.includes(signal.turn)
  )
    return prev;
  let base: RelayTokenStreamState;
  if (!prev || signal.run > prev.run) {
    base = {
      run: signal.run,
      activeTurn: signal.turn,
      retiredTurns: [],
      order: [],
      entries: {},
    };
  } else if (signal.turn !== prev.activeTurn) {
    base = {
      run: prev.run,
      activeTurn: signal.turn,
      retiredTurns: appendRetiredTurn(prev.retiredTurns, prev.activeTurn),
      order: [],
      entries: {},
    };
  } else {
    base = prev;
  }

  const key = streamKey(signal.turn, signal.message_id);
  const existing = base.entries[key];
  const chunkBytes = utf8Encoder.encode(signal.text).byteLength;

  if (!existing) {
    const dropped =
      signal.delta_seq !== 1 || chunkBytes > MAX_STREAM_TEXT_BYTES;
    const order = [...base.order, key];
    const entries: Record<string, RelayTokenStreamEntry> = {
      ...base.entries,
      [key]: {
        run: signal.run,
        turn: signal.turn,
        messageId: signal.message_id,
        nextSeq: signal.delta_seq + 1,
        bytes: dropped ? 0 : chunkBytes,
        text: dropped ? "" : signal.text,
        dropped,
      },
    };
    while (order.length > MAX_ENTRIES_PER_CONVERSATION) {
      const oldest = order.shift();
      if (oldest !== undefined) delete entries[oldest];
    }
    return {
      run: base.run,
      activeTurn: base.activeTurn,
      retiredTurns: base.retiredTurns,
      order,
      entries,
    };
  }

  if (existing.dropped) return base;

  const nextBytes = existing.bytes + chunkBytes;
  if (
    signal.delta_seq !== existing.nextSeq ||
    nextBytes > MAX_STREAM_TEXT_BYTES
  ) {
    return {
      ...base,
      entries: {
        ...base.entries,
        [key]: {
          ...existing,
          bytes: 0,
          text: "",
          dropped: true,
        },
      },
    };
  }

  return {
    ...base,
    entries: {
      ...base.entries,
      [key]: {
        ...existing,
        nextSeq: existing.nextSeq + 1,
        bytes: nextBytes,
        text: existing.text + signal.text,
      },
    },
  };
}

export function selectVisibleRelayTokenStreams(
  state: RelayTokenStreamState | undefined,
  durableAssistantUuids: ReadonlySet<string>,
  turnOpen: boolean,
  baselineUuids: ReadonlySet<string> = new Set(),
): readonly RelayTokenStreamEntry[] {
  if (!turnOpen || !state || state.order.length === 0) return EMPTY_STREAMS;
  if (hasDurableMatchForTurn(state, durableAssistantUuids, baselineUuids))
    return EMPTY_STREAMS;
  const visible: RelayTokenStreamEntry[] = [];
  for (const key of state.order) {
    const entry = state.entries[key];
    if (!entry || entry.dropped || !entry.text) continue;
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
        !(conversationId in this.relayTokenDeltas) ||
        (status !== "unavailable" &&
          status !== "denied" &&
          status !== "disabled")
      )
        return;
      delete this.relayTokenDeltas[conversationId];
    }),
    pruneRelayTokenStreams: sync(function (
      this: RelayTokenDeltasDraft,
      conversationId: string,
      durableAssistantUuids: ReadonlySet<string>,
      baselineUuids: ReadonlySet<string>,
      clearAll: boolean,
    ) {
      const current = this.relayTokenDeltas[conversationId];
      if (!current) return;
      if (clearAll) {
        this.relayTokenDeltas[conversationId] = {
          run: current.run,
          activeTurn: current.activeTurn,
          retiredTurns: appendRetiredTurn(
            current.retiredTurns,
            current.activeTurn,
          ),
          order: [],
          entries: {},
        };
        return;
      }
      if (
        current.order.length > 0 &&
        hasDurableMatchForTurn(current, durableAssistantUuids, baselineUuids)
      ) {
        this.relayTokenDeltas[conversationId] = {
          run: current.run,
          activeTurn: current.activeTurn,
          retiredTurns: appendRetiredTurn(
            current.retiredTurns,
            current.activeTurn,
          ),
          order: [],
          entries: {},
        };
      }
    }),
  };
}
