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
  write: (...events: [CanonicalEvent, ...CanonicalEvent[]]) => Promise<void>,
  onJournalError?: (error: unknown) => void,
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
  let pending: { event: CanonicalEvent; confirm: () => void } | undefined;
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
  async function flushTerminal() {
    if (!pending) return;
    await write(pending.event);
    confirmTerminal();
  }
  function confirmTerminal() {
    if (!pending) return;
    const { event, confirm } = pending;
    pending = undefined;
    seq = event.seq;
    confirm();
  }
  async function end(outcome: End["body"]["outcome"]) {
    const pane = journal.open;
    if (!pane) return;
    if (pane.run > run)
      throw new Error("Terminal reservation belongs to a later run");
    pending = {
      event: {
        ...envelope(),
        kind: "terminal.ended",
        body: { pane_instance: pane.instance, started_run: pane.run, outcome },
      },
      confirm: () => {
        journal.open = undefined;
        watch = undefined;
        persist();
      },
    };
    await flushTerminal();
  }
  const observe: ObservePane = (identity, actor) =>
    ordered(async () => {
      if (writers.get(session) !== observe) return;
      await flushTerminal();
      if (watch?.identity !== identity) {
        await end({ kind: "replaced" });
        const last = Math.max(journal.last, claim.last_pane_instance);
        if (last >= Number.MAX_SAFE_INTEGER)
          throw new Error("Terminal pane numbers are exhausted");
        const reservation = { run, instance: last + 1 };
        journal.last = reservation.instance;
        journal.open = reservation;
        persist();
        pending = {
          event: {
            ...envelope(),
            kind: "terminal.started",
            body: {
              pane_instance: reservation.instance,
              actor: { kind: "person", id: actor },
            },
          },
          confirm: () => {
            watch = { identity, viewers: 0 };
          },
        };
        await flushTerminal();
      }
      const current = watch!;
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
        const next = { ...event, seq: seq + (pending ? 2 : 1) };
        const terminal = pending;
        if (terminal) await write(terminal.event, next);
        else await write(next);
        pending = undefined;
        providerSeq = event.seq;
        seq = next.seq;
        try {
          terminal?.confirm();
        } catch (error) {
          onJournalError?.(error);
        }
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
      return ordered(async () => {
        await flushTerminal();
        await end({ kind: "lost" });
      });
    },
  };
}
