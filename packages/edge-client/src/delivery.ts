import {
  matchesExpected,
  parseDeliverySettleResponse,
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  parseTakeoverAckResponse,
  STEER_BATON_CAPABILITY,
  TAKEOVER_FENCE_CAPABILITY,
  type DeliveryResolutionRequest,
  type DeliverySettleRequest,
  type DeliveryStartRequest,
  type PermitsNextRequest,
  type TakeoverFence,
} from "@codecast/edge-contract";
import * as Effect from "effect/Effect";
import { isFailure } from "effect/Exit";
import { makeUnsafe } from "effect/Semaphore";
import { EdgeRejected, type RequestFailure } from "./failures";
import type { makeRequest } from "./request";
import type {
  EdgeDeliveryStep,
  EdgeSteerHandover,
  EdgeSteerJournal,
  EdgeSteerOutcome,
  EdgeSteerPermit,
  EdgeSteeringHost,
} from "./types";

const pending = { status: "pending" } as const;
const fenced = { status: "fenced" } as const;
const emptyJournal: EdgeSteerJournal = { fences: [], handovers: [] };

function identity(permit: DeliveryStartRequest): DeliveryStartRequest {
  const {
    v,
    session,
    run,
    fencing_token,
    delivery_id,
    attempt_id,
    seq,
    intent,
    sender,
  } = permit;
  return {
    v,
    session,
    run,
    fencing_token,
    delivery_id,
    attempt_id,
    seq,
    intent,
    sender: { ...sender },
  };
}

function sameLease(a: PermitsNextRequest, b: PermitsNextRequest): boolean {
  return (
    a.session === b.session &&
    a.run === b.run &&
    a.fencing_token === b.fencing_token
  );
}

function sameAttempt(
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

function covers(fence: TakeoverFence, hand: EdgeSteerHandover): boolean {
  return (
    fence.session === hand.session &&
    fence.run === hand.run &&
    fence.turn === hand.expected.turn &&
    fence.baton_token === hand.baton_token
  );
}

export function makeDelivery(
  send: ReturnType<typeof makeRequest>,
  host: EdgeSteeringHost | undefined,
  policy: () => readonly string[],
) {
  const lock = makeUnsafe(1);
  const activeAttempts = new Set<string>();
  const unrecordedFences = new Map<string, TakeoverFence>();
  const blocked = (journal: EdgeSteerJournal, hand: EdgeSteerHandover) =>
    journal.fences.some((item) => covers(item, hand)) ||
    [...unrecordedFences.values()].some((item) => covers(item, hand));
  const keyOf = (hand: EdgeSteerHandover) =>
    JSON.stringify([hand.session, hand.run, hand.attempt_id]);
  const agreed = (capability: string) => policy().includes(capability);
  const reject = (
    code: string,
    operation:
      | "permits.next"
      | "delivery.start"
      | "takeover.ack" = "permits.next",
  ) => new EdgeRejected({ operation, code });

  const load = (run: PermitsNextRequest) =>
    Effect.tryPromise({
      try: (signal) =>
        host!.journal.load({ session: run.session, run: run.run }, signal),
      catch: () => reject("steer_journal_read_failed"),
    }).pipe(Effect.map((state) => state ?? emptyJournal));

  const save = (run: PermitsNextRequest, state: EdgeSteerJournal) =>
    Effect.tryPromise({
      try: (signal) =>
        host!.journal.save(
          { session: run.session, run: run.run },
          state,
          signal,
        ),
      catch: () => reject("steer_journal_write_failed"),
    });

  const observed = (run: PermitsNextRequest) => ({
    kind: "turn" as const,
    turn: host!.runningTurn(run),
  });

  const recordHand = Effect.fn("edgeClient.recordSteer")(function* (
    run: PermitsNextRequest,
    state: EdgeSteerJournal,
    hand: EdgeSteerHandover,
  ) {
    const previous = state.handovers.find(
      (item) => item.attempt_id === hand.attempt_id,
    );
    if (previous) {
      if (
        !sameAttempt(previous, hand) ||
        previous.expected.turn !== hand.expected.turn ||
        previous.baton_token !== hand.baton_token
      )
        return yield* reject("steer_journal_conflict");
      return state;
    }
    const next = { ...state, handovers: [...state.handovers, hand] };
    yield* save(run, next);
    return next;
  });

  const settle = Effect.fn("edgeClient.settleSteer")(function* (
    run: PermitsNextRequest,
    outcome: DeliverySettleRequest | DeliveryResolutionRequest,
    journal: EdgeSteerJournal,
  ) {
    const { value: receipt } = yield* send(
      "delivery.settle",
      { ...outcome, fencing_token: run.fencing_token },
      parseDeliverySettleResponse,
    );
    if (
      receipt.status !== "stale" &&
      outcome.outcome !== "in_doubt" &&
      journal.handovers.some((hand) => hand.attempt_id === outcome.attempt_id)
    ) {
      yield* save(run, {
        ...journal,
        handovers: journal.handovers.filter(
          (hand) => hand.attempt_id !== outcome.attempt_id,
        ),
      });
    }
    return { status: "settled", outcome: outcome.outcome, receipt } as const;
  });

  const recover = Effect.fn("edgeClient.recoverSteer")(function* (
    run: PermitsNextRequest,
    hand: EdgeSteerHandover,
    journal: EdgeSteerJournal,
  ) {
    const recovery = yield* Effect.tryPromise({
      try: (signal) =>
        host!.recover({ ...hand, fencing_token: run.fencing_token }, signal),
      catch: () => reject("steer_recovery_failed"),
    });
    const result =
      recovery.outcome === "in_doubt"
        ? recovery
        : !recovery.resolution_evidence.trim()
          ? { outcome: "in_doubt" as const }
          : recovery.outcome === "applied"
            ? {
                outcome: "applied" as const,
                resolution_evidence: recovery.resolution_evidence,
              }
            : {
                outcome: "failed" as const,
                retryable: false,
                resolution_evidence: recovery.resolution_evidence,
              };
    return yield* settle(run, { ...result, ...identity(hand) }, journal);
  });

  const receiveFence = Effect.fn("edgeClient.takeoverFence")(function* (
    run: PermitsNextRequest,
    fence: TakeoverFence,
  ) {
    if (observed(run).turn !== fence.turn) return fenced;
    const key = JSON.stringify([run.session, run.run, fence.fence_id]);
    const unrecorded = unrecordedFences.get(key);
    if (!unrecorded) unrecordedFences.set(key, fence);
    let journal = yield* load(run);
    const old = journal.fences.find((item) => item.fence_id === fence.fence_id);
    if (
      [old, unrecorded].some(
        (item) =>
          item &&
          (item.turn !== fence.turn ||
            item.run !== fence.run ||
            item.session !== fence.session ||
            item.baton_token !== fence.baton_token ||
            item.new_baton_token !== fence.new_baton_token),
      )
    ) {
      if (!unrecorded) unrecordedFences.delete(key);
      return yield* reject("takeover_fence_conflict", "takeover.ack");
    }
    if (!old || old.fencing_token !== fence.fencing_token) {
      journal = {
        ...journal,
        fences: [
          ...journal.fences.filter((item) => item.fence_id !== fence.fence_id),
          fence,
        ],
      };
      yield* save(run, journal);
    }
    unrecordedFences.delete(key);
    for (const hand of journal.handovers.filter((item) =>
      covers(fence, item),
    )) {
      if (activeAttempts.has(keyOf(hand))) return pending;
      const step = yield* recover(run, hand, journal);
      if (step.outcome === "in_doubt" || step.receipt.status === "stale")
        return pending;
      journal = yield* load(run);
    }
    if (observed(run).turn !== fence.turn) return fenced;
    const {
      v,
      session,
      run: epoch,
      fencing_token,
      fence_id,
      turn,
      baton_token,
    } = fence;
    const { value: receipt } = yield* send(
      "takeover.ack",
      { v, session, run: epoch, fencing_token, fence_id, turn, baton_token },
      parseTakeoverAckResponse,
    );
    return { status: "takeover", receipt } as const;
  });

  const select = Effect.fn("edgeClient.selectDelivery")(function* (
    run: PermitsNextRequest,
  ) {
    const { value } = yield* send(
      "permits.next",
      run,
      parsePermitsNextResponse,
    );
    if (value.status === "empty" || value.status === "stale") return value;
    if (!sameLease(run, value)) return yield* reject("delivery_lease_mismatch");
    if (value.status === "permit" && value.intent === "queue") return value;
    if (!host || !agreed(STEER_BATON_CAPABILITY))
      return yield* reject("steer_not_negotiated");
    if (value.status === "takeover_fence") {
      if (!agreed(TAKEOVER_FENCE_CAPABILITY))
        return yield* reject("takeover_not_negotiated");
      return yield* receiveFence(run, value);
    }

    const hand = {
      ...identity(value),
      expected: { ...value.expected },
      baton_token: value.baton_token,
    };
    if (activeAttempts.has(keyOf(hand))) return pending;
    const journal = yield* load(run);
    if (
      value.state === "started" ||
      journal.handovers.some((item) => item.attempt_id === hand.attempt_id)
    )
      return yield* recover(run, hand, yield* recordHand(run, journal, hand));
    if (blocked(journal, hand)) return fenced;
    const turn = observed(run);
    if (!matchesExpected(value.expected, turn))
      return yield* settle(
        run,
        { ...identity(hand), outcome: "stale", observed: turn },
        journal,
      );

    const { value: started } = yield* send(
      "delivery.start",
      identity(hand),
      parseDeliveryStartResponse,
    );
    if (started.status === "rejected") return started;
    if (!sameLease(run, started) || !sameAttempt(hand, started))
      return yield* reject("delivery_start_mismatch", "delivery.start");
    if (started.status === "already_started")
      return yield* recover(run, hand, yield* recordHand(run, journal, hand));
    return {
      status: "prepare" as const,
      hand,
      permit: { ...value, input: started.input ?? value.input },
    };
  });

  const handPrepared = Effect.fn("edgeClient.handPreparedSteer")(function* (
    run: PermitsNextRequest,
    hand: EdgeSteerHandover,
    handToAgent: (signal: AbortSignal) => Promise<EdgeSteerOutcome>,
  ) {
    const handed = yield* Effect.acquireUseRelease(
      lock.withPermit(
        Effect.gen(function* () {
          const journal = yield* load(run);
          if (!agreed(STEER_BATON_CAPABILITY) || blocked(journal, hand))
            return fenced;
          const before = observed(run);
          if (!matchesExpected(hand.expected, before))
            return yield* settle(
              run,
              { ...identity(hand), outcome: "stale", observed: before },
              journal,
            );
          const recorded = yield* recordHand(run, journal, hand);
          if (!agreed(STEER_BATON_CAPABILITY)) {
            if (recorded !== journal) yield* save(run, journal);
            return fenced;
          }
          const current = observed(run);
          if (!matchesExpected(hand.expected, current))
            return yield* settle(
              run,
              { ...identity(hand), outcome: "stale", observed: current },
              recorded,
            );
          const controller = new AbortController();
          const result = (async () => {
            try {
              return await handToAgent(controller.signal);
            } catch {
              return { outcome: "in_doubt" as const };
            }
          })();
          return { status: "handed" as const, controller, result };
        }),
      ),
      (item) =>
        Effect.gen(function* () {
          if (item.status !== "handed") return item;
          const outcome = yield* Effect.promise(() => item.result);
          return { status: "outcome" as const, outcome };
        }),
      (item, exit) =>
        item.status === "handed" && isFailure(exit)
          ? Effect.promise(async () => {
              item.controller.abort();
              await item.result;
            })
          : Effect.void,
    );
    if (handed.status !== "outcome") return handed;
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const journal = yield* load(run);
        return yield* settle(
          run,
          { ...handed.outcome, ...identity(hand) },
          journal,
        );
      }),
    );
  });

  return Effect.fn("edgeClient.deliverNext")(function* (
    request: PermitsNextRequest,
  ): Effect.fn.Return<EdgeDeliveryStep, RequestFailure> {
    const run = { ...request };
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const selected = yield* lock.withPermit(
          restore(select(run)).pipe(
            Effect.tap((item) =>
              Effect.sync(() => {
                if (item.status === "prepare")
                  activeAttempts.add(keyOf(item.hand));
              }),
            ),
          ),
        );
        if (selected.status !== "prepare") return selected;
        const { hand, permit } = selected;
        return yield* restore(
          Effect.gen(function* () {
            const prepared = yield* Effect.result(
              Effect.tryPromise({
                try: (signal) => host!.prepare(permit, signal),
                catch: () =>
                  reject("steer_preparation_failed", "delivery.start"),
              }),
            );
            if (prepared._tag === "Failure") {
              return yield* lock.withPermit(
                Effect.gen(function* () {
                  const journal = yield* load(run);
                  if (!agreed(STEER_BATON_CAPABILITY) || blocked(journal, hand))
                    return fenced;
                  const current = observed(run);
                  return yield* settle(
                    run,
                    {
                      ...identity(hand),
                      ...(matchesExpected(hand.expected, current)
                        ? ({
                            outcome: "failed",
                            retryable: true,
                            detail: prepared.failure.code,
                          } as const)
                        : ({ outcome: "stale", observed: current } as const)),
                    },
                    journal,
                  );
                }),
              );
            }
            return yield* handPrepared(run, hand, prepared.success);
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => activeAttempts.delete(keyOf(hand))),
          ),
        );
      }),
    );
  });
}
