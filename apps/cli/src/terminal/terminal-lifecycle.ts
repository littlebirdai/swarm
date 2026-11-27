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
  write: (event: CanonicalEvent) => Promise<void>,
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
  let watch: Watch | undefined;
  let closed = false;
  const persist = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteFile(file, JSON.stringify(journal), { mode: 0o600 });
  };
  function ordered<T>(work: () => Promise<T>) {
    const result = tail.then(work);
    tail = result.then(() => {});
    void tail.catch(() => {});
    return result;
  }
  const envelope = (): Omit<End, "kind" | "body"> => ({
    v,
    session,
    run,
    seq: ++seq,
    at: Date.now(),
    turn: null,
    source: "observed",
  });
  async function end(outcome: End["body"]["outcome"]) {
    const pane = journal.open;
    if (!pane) return;
    if (pane.run > run)
      throw new Error("Terminal reservation belongs to a later run");
    await write({
      ...envelope(),
      kind: "terminal.ended",
      body: { pane_instance: pane.instance, started_run: pane.run, outcome },
    });
    journal.open = undefined;
    watch = undefined;
    persist();
  }
  const observe: ObservePane = (identity, actor) =>
    ordered(async () => {
      if (writers.get(session) !== observe) return;
      if (watch?.identity !== identity) {
        await end({ kind: "replaced" });
        const last = Math.max(journal.last, claim.last_pane_instance);
        if (last >= Number.MAX_SAFE_INTEGER)
          throw new Error("Terminal pane numbers are exhausted");
        const reservation = { run, instance: last + 1 };
        journal.last = reservation.instance;
        journal.open = reservation;
        persist();
        await write({
          ...envelope(),
          kind: "terminal.started",
          body: {
            pane_instance: reservation.instance,
            actor: { kind: "person", id: actor },
          },
        });
        watch = { identity, viewers: 0 };
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
        await write({ ...event, seq: ++seq });
        providerSeq = event.seq;
      });
    },
    async startWatching() {
      await ordered(() =>
        end({ kind: journal.open?.run === run ? "lost" : "replaced" }),
      );
      if (!closed) writers.set(session, observe);
    },
    close() {
      closed = true;
      if (writers.get(session) === observe) writers.delete(session);
      return ordered(() => end({ kind: "lost" }));
    },
  };
}
