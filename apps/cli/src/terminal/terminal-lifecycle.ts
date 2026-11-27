import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  EDGE_PROTOCOL_VERSION as v,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import type { ClaimGrant } from "@codecast/edge-client";
import { atomicWriteFile } from "../atomicWrite.js";

type End = Extract<CanonicalEvent, { kind: "terminal.ended" }>;
export type TerminalEnd = (outcome: End["body"]["outcome"]) => Promise<void>;
type Reservation = { run: number; instance: number };
type Journal = { last: number; open?: Reservation };
type Watch = { identity: string; viewers: number };
type TerminalEvent = Extract<
  CanonicalEvent,
  { kind: "terminal.started" | "terminal.ended" }
>;
type PendingTerminal = {
  event: TerminalEvent;
  attempts: number;
  retryAt?: number;
  abandoned?: "rejected" | "unconfirmed";
};

const MAX_TERMINAL_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

export class TerminalEventRejected extends Error {}

export function isTerminalOwnerId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 256 && value.trim().length > 0
  );
}

type ObservePane = (
  identity: string,
  actor: string,
) => Promise<TerminalEnd | undefined>;

const writers = new Map<string, ObservePane>();

export function observeClaimedTerminal(
  session: string,
  identity: string,
  actor: string,
) {
  return writers.get(session)?.(identity, actor);
}

function loadJournal(file: string): Journal {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { last: 0 };
    throw error;
  }
  const state = JSON.parse(text) as Journal;
  if (
    !Number.isSafeInteger(state.last) ||
    state.last < 0 ||
    (state.open &&
      (!Number.isSafeInteger(state.open.run) ||
        state.open.run < 1 ||
        !Number.isSafeInteger(state.open.instance) ||
        state.open.instance < 1 ||
        state.open.instance > state.last))
  )
    throw new Error("Invalid terminal lifecycle reservation");
  return state;
}

export function createTerminalEventWriter(
  claim: ClaimGrant,
  directory: string,
  write: (
    events: [CanonicalEvent, ...CanonicalEvent[]],
    abandonTerminalSeq?: number,
  ) => Promise<void>,
  onTerminalError?: (error: unknown) => void,
) {
  const { session, run } = claim;
  const file = path.join(
    directory,
    createHash("sha256").update(session).digest("hex") + ".json",
  );
  const journal = loadJournal(file);
  let seq = claim.last_event_seq ?? 0;
  let providerSeq = seq;
  let tail = Promise.resolve();
  let pending: PendingTerminal | undefined;
  let endOutcome: End["body"]["outcome"] | undefined;
  let watch: Watch | undefined;
  let closed = false;
  const persist = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteFile(file, JSON.stringify(journal), { mode: 0o600 });
  };
  function ordered<T>(work: () => Promise<T>) {
    const result = tail.then(work);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  const envelope = (): Omit<End, "kind" | "body"> => ({
    v,
    session,
    run,
    seq: seq + 1,
    at: Date.now(),
    turn: null,
    source: "observed",
  });
  function writeable(terminal: PendingTerminal): CanonicalEvent {
    return terminal.abandoned
      ? { ...terminal.event, kind: "context", body: { data: null } }
      : terminal.event;
  }
  function recordFailure(terminal: PendingTerminal, error: unknown) {
    terminal.attempts++;
    if (error instanceof TerminalEventRejected && terminal.attempts === 1)
      terminal.abandoned = "rejected";
    else if (
      error instanceof TerminalEventRejected ||
      terminal.attempts >= MAX_TERMINAL_ATTEMPTS
    )
      terminal.abandoned = "unconfirmed";
    else terminal.retryAt = Date.now() + RETRY_DELAY_MS;
  }
  function confirmTerminal(terminal: PendingTerminal) {
    pending = undefined;
    seq = terminal.event.seq;
    if (
      terminal.event.kind === "terminal.ended" ||
      terminal.abandoned === "rejected"
    ) {
      journal.open = undefined;
      try {
        persist();
      } catch (error) {
        onTerminalError?.(error);
      }
    }
  }
  async function flushTerminal() {
    const terminal = pending;
    if (!terminal) return;
    const delay = (terminal.retryAt ?? 0) - Date.now();
    if (delay > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      await write([writeable(terminal)]);
    } catch (error) {
      if (!terminal.abandoned) recordFailure(terminal, error);
      throw error;
    }
    confirmTerminal(terminal);
  }
  async function drainTerminal() {
    await flushTerminal();
    const pane = journal.open;
    const outcome = endOutcome;
    endOutcome = undefined;
    if (!pane || !outcome) return;
    if (pane.run > run)
      throw new Error("Terminal reservation belongs to a later run");
    pending = {
      event: {
        ...envelope(),
        kind: "terminal.ended",
        body: { pane_instance: pane.instance, started_run: pane.run, outcome },
      },
      attempts: 0,
    };
    await flushTerminal();
  }
  function end(outcome: End["body"]["outcome"]) {
    watch = undefined;
    if (journal.open) endOutcome ??= outcome;
    return drainTerminal();
  }
  const observe: ObservePane = (identity, actor) =>
    ordered(async () => {
      if (writers.get(session) !== observe || !isTerminalOwnerId(actor)) return;
      if (watch?.identity !== identity) {
        await end({ kind: "replaced" });
        const last = Math.max(journal.last, claim.last_pane_instance);
        if (last >= Number.MAX_SAFE_INTEGER)
          throw new Error("Terminal pane numbers are exhausted");
        const reservation = { run, instance: last + 1 };
        journal.last = reservation.instance;
        journal.open = reservation;
        persist();
        watch = { identity, viewers: 0 };
        pending = {
          event: {
            ...envelope(),
            kind: "terminal.started",
            body: {
              pane_instance: reservation.instance,
              actor: { kind: "person", id: actor },
            },
          },
          attempts: 0,
        };
        await flushTerminal().catch((error) => onTerminalError?.(error));
      }
      const current = watch;
      current.viewers++;
      let released = false;
      return (outcome) =>
        ordered(async () => {
          if (released || current !== watch) return;
          released = true;
          if (--current.viewers === 0 || outcome.kind === "replaced")
            await end(outcome);
        });
    });
  return {
    append(event: CanonicalEvent) {
      return ordered(async () => {
        if (event.seq !== providerSeq + 1)
          throw new Error("Provider event sequence is not contiguous");
        if (pending && !pending.abandoned)
          await flushTerminal().catch((error) => onTerminalError?.(error));
        const abandoned = pending;
        if (abandoned) abandoned.abandoned ??= "unconfirmed";
        const next = { ...event, seq: seq + (abandoned ? 2 : 1) };
        await write([next], abandoned?.event.seq);
        if (abandoned) confirmTerminal(abandoned);
        providerSeq = event.seq;
        seq = next.seq;
        if (endOutcome)
          await drainTerminal().catch((error) => onTerminalError?.(error));
      });
    },
    async startWatching() {
      try {
        await ordered(() =>
          end({ kind: journal.open?.run === run ? "lost" : "replaced" }),
        );
      } finally {
        if (!closed) writers.set(session, observe);
      }
    },
    close() {
      closed = true;
      if (writers.get(session) === observe) writers.delete(session);
      return ordered(() => end({ kind: "lost" }));
    },
  };
}
