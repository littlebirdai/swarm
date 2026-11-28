import {
  matchesExpected,
  type DeliveryStartRequest,
  type PermitsNextRequest,
  type TakeoverFence,
} from "@codecast/edge-contract";
import type {
  BusTimeoutError,
  BusValidationError,
} from "@codecast/edge-supervisor/effect";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  DeliveryOptions,
  DeliveryReceipt,
  DeliverySteerHandover,
  DeliverySteerJournal,
  SteerPermit,
} from "./types";

export class DeliveryError extends TaggedError("DeliveryError")<{
  readonly operation:
    | "permits.next"
    | "delivery.start"
    | "delivery.settle"
    | "takeover.ack"
    | "blobs.get"
    | "journal"
    | "bus";
  readonly code: string;
  readonly retryable?: boolean;
  readonly retry_after_ms?: number;
  readonly cause?: unknown;
}> {}

export function mapBusError(
  operation: DeliveryError["operation"],
  error: BusValidationError | BusTimeoutError,
): DeliveryError {
  return new DeliveryError({
    operation,
    code:
      error._tag === "BusTimeoutError"
        ? "bus_timeout"
        : "bus_validation_failed",
    retryable: error._tag === "BusTimeoutError",
    cause: error,
  });
}

export const emptySteerJournal: DeliverySteerJournal = {
  fences: [],
  handovers: [],
};

export function requestId(): string {
  return crypto.randomUUID();
}

export function permitIdentity(permit: Omit<DeliveryStartRequest, "v">) {
  return {
    v: 1 as const,
    session: permit.session,
    run: permit.run,
    fencing_token: permit.fencing_token,
    delivery_id: permit.delivery_id,
    attempt_id: permit.attempt_id,
    seq: permit.seq,
    intent: permit.intent,
    sender: { ...permit.sender },
  };
}

export function sameLease(
  a: Pick<PermitsNextRequest, "session" | "run" | "fencing_token">,
  b: Pick<PermitsNextRequest, "session" | "run" | "fencing_token">,
): boolean {
  return (
    a.session === b.session &&
    a.run === b.run &&
    a.fencing_token === b.fencing_token
  );
}

export function sameAttempt(
  a: DeliveryStartRequest,
  b: DeliveryStartRequest,
): boolean {
  return (
    a.session === b.session &&
    a.run === b.run &&
    a.attempt_id === b.attempt_id &&
    a.delivery_id === b.delivery_id &&
    a.seq === b.seq &&
    a.intent === b.intent &&
    a.sender.id === b.sender.id &&
    a.sender.kind === b.sender.kind
  );
}

export function covers(
  fence: TakeoverFence,
  hand: DeliverySteerHandover,
): boolean {
  return (
    fence.session === hand.session &&
    fence.run === hand.run &&
    fence.turn === hand.expected.turn &&
    fence.baton_token === hand.baton_token
  );
}

export function toHandover(permit: SteerPermit): DeliverySteerHandover {
  return {
    ...permitIdentity(permit),
    intent: "steer",
    expected: { ...permit.expected },
    baton_token: permit.baton_token,
  };
}

const MAX_IN_MEMORY_ENTRIES = 1024;

export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  while (map.size >= MAX_IN_MEMORY_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}

export function makeJournalStore(options: DeliveryOptions) {
  const unrecordedFences = new Map<string, TakeoverFence>();
  const appendedReceipts = new Map<string, DeliveryReceipt>();
  const receiptKey = (session: string, deliveryId: string) =>
    JSON.stringify([session, deliveryId]);

  const observedTurn = (run: Pick<PermitsNextRequest, "session" | "run">) => ({
    kind: "turn" as const,
    turn: options.runningTurn ? options.runningTurn(run) : null,
  });

  const loadSteer = Effect.fnUntraced(function* (
    run: Pick<PermitsNextRequest, "session" | "run">,
  ) {
    if (!options.steerJournal) return emptySteerJournal;
    const loaded = yield* Effect.tryPromise({
      try: (signal) => options.steerJournal!.load(run, signal),
      catch: (cause) =>
        new DeliveryError({
          operation: "journal",
          code: "steer_journal_read_failed",
          cause,
        }),
    });
    return loaded ?? emptySteerJournal;
  });

  const saveSteer = Effect.fnUntraced(function* (
    run: Pick<PermitsNextRequest, "session" | "run">,
    state: DeliverySteerJournal,
  ) {
    if (!options.steerJournal) return;
    yield* Effect.tryPromise({
      try: (signal) => options.steerJournal!.save(run, state, signal),
      catch: (cause) =>
        new DeliveryError({
          operation: "journal",
          code: "steer_journal_write_failed",
          cause,
        }),
    });
  });

  const withoutClosedFences = (
    run: Pick<PermitsNextRequest, "session" | "run">,
    journal: DeliverySteerJournal,
  ): DeliverySteerJournal => {
    if (!journal.fences.length) return journal;
    const { turn } = observedTurn(run);
    const fences = journal.fences.filter(
      (fence) =>
        !fence.acknowledged ||
        fence.turn === turn ||
        journal.handovers.some((hand) => covers(fence, hand)),
    );
    return fences.length === journal.fences.length
      ? journal
      : { ...journal, fences };
  };

  const loadPrunedSteer = Effect.fnUntraced(function* (
    run: Pick<PermitsNextRequest, "session" | "run">,
  ) {
    const saved = yield* loadSteer(run);
    const pruned = withoutClosedFences(run, saved);
    if (pruned !== saved) yield* saveSteer(run, pruned);
    return pruned;
  });

  const isBlockedByFence = (
    journal: DeliverySteerJournal,
    hand: DeliverySteerHandover,
  ) =>
    journal.fences.some((item) => covers(item, hand)) ||
    [...unrecordedFences.values()].some((item) => covers(item, hand));

  const recordHandover = Effect.fnUntraced(function* (
    run: Pick<PermitsNextRequest, "session" | "run">,
    journal: DeliverySteerJournal,
    hand: DeliverySteerHandover,
  ) {
    const previous = journal.handovers.find(
      (item) => item.attempt_id === hand.attempt_id,
    );
    if (previous) {
      if (
        !sameAttempt(previous, hand) ||
        previous.expected.turn !== hand.expected.turn ||
        previous.baton_token !== hand.baton_token
      ) {
        return yield* new DeliveryError({
          operation: "journal",
          code: "steer_journal_conflict",
        });
      }
      return journal;
    }
    const next = { ...journal, handovers: [...journal.handovers, hand] };
    yield* saveSteer(run, next);
    return next;
  });

  const findReceipt = Effect.fnUntraced(function* (
    session: string,
    deliveryId: string,
  ) {
    const memory = appendedReceipts.get(receiptKey(session, deliveryId));
    if (memory) {
      if (memory.delivery_id !== deliveryId) {
        return yield* new DeliveryError({
          operation: "journal",
          code: "receipt_mismatch",
        });
      }
      return memory;
    }
    if (!options.receiptJournal) return undefined;
    const stored = yield* Effect.tryPromise({
      try: (signal) =>
        options.receiptJournal!.find(session, deliveryId, signal),
      catch: (cause) =>
        new DeliveryError({
          operation: "journal",
          code: "receipt_journal_read_failed",
          cause,
        }),
    });
    if (stored && stored.delivery_id !== deliveryId) {
      return yield* new DeliveryError({
        operation: "journal",
        code: "receipt_mismatch",
      });
    }
    return stored;
  });

  const saveReceipt = Effect.fnUntraced(function* (
    session: string,
    receipt: DeliveryReceipt,
  ) {
    setBoundedMap(
      appendedReceipts,
      receiptKey(session, receipt.delivery_id),
      receipt,
    );
    if (!options.receiptJournal) return;
    yield* Effect.tryPromise({
      try: (signal) => options.receiptJournal!.record(session, receipt, signal),
      catch: (cause) =>
        new DeliveryError({
          operation: "journal",
          code: "receipt_journal_write_failed",
          cause,
        }),
    });
  });

  const forgetReceipt = Effect.fnUntraced(function* (
    session: string,
    deliveryId: string,
  ) {
    appendedReceipts.delete(receiptKey(session, deliveryId));
    if (!options.receiptJournal) return;
    yield* Effect.tryPromise({
      try: (signal) =>
        options.receiptJournal!.forget(session, deliveryId, signal),
      catch: (cause) =>
        new DeliveryError({
          operation: "journal",
          code: "receipt_journal_write_failed",
          cause,
        }),
    }).pipe(Effect.catch(() => Effect.void));
  });

  const matchesTurn = (
    expected: SteerPermit["expected"],
    run: Pick<PermitsNextRequest, "session" | "run">,
  ) => matchesExpected(expected, observedTurn(run));

  return {
    unrecordedFences,
    observedTurn,
    matchesTurn,
    loadSteer,
    saveSteer,
    withoutClosedFences,
    loadPrunedSteer,
    isBlockedByFence,
    recordHandover,
    findReceipt,
    saveReceipt,
    forgetReceipt,
  };
}
