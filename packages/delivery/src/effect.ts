import {
  matchesExpected,
  type PermitsNextRequest,
} from "@codecast/edge-contract";
import {
  SupervisorBus,
  type ProviderDeliverOutcome,
} from "@codecast/edge-supervisor/effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import { TaggedError } from "effect/Data";
import { toMillis } from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import { makeInputPreparation } from "./inputs";
import {
  DeliveryError,
  makeJournalStore,
  mapBusError,
  permitIdentity,
  requestId,
  sameAttempt,
  sameLease,
  setBoundedMap,
  toHandover,
} from "./journals";
import { makeSessionLocks } from "./session-locks";
import { makeSettlement } from "./settlement";
import { makeWakeScheduler } from "./wakes";
import type {
  DeliveryOptions,
  DeliveryPermit,
  DeliveryReceipt,
  DeliveryStepOutcome,
  DrainOptions,
} from "./types";

export { DeliveryError } from "./journals";

class RetryableDrainStep extends TaggedError("RetryableDrainStep")<{
  readonly outcome: DeliveryStepOutcome;
  readonly retryAfterMs?: number;
}> {}

function retryAfterOf(outcome: DeliveryStepOutcome): number | undefined {
  return "retry_after_ms" in outcome ? outcome.retry_after_ms : undefined;
}

function shouldRetryOutcome(outcome: DeliveryStepOutcome): boolean {
  if (outcome.status === "retry_scheduled" || outcome.status === "pending") {
    return true;
  }
  if (outcome.status === "failed") {
    return outcome.retryable;
  }
  if (outcome.status === "in_doubt") {
    return outcome.retry_after_ms !== undefined;
  }
  return false;
}

function retryBusTimeout(
  error: DeliveryError,
): Effect.Effect<DeliveryStepOutcome, DeliveryError> {
  if (error.code !== "bus_timeout") return Effect.fail(error);
  return Effect.succeed({
    status: "retry_scheduled",
    retryable: true,
    code: "bus_timeout",
  });
}

const PROVIDER_TIMEOUT_MS = 30_000;

type PendingDelivery = {
  readonly session: string;
  readonly run: number;
  readonly delivery_id: string;
  readonly attempt_id: string;
  readonly answer: Deferred.Deferred<ProviderDeliverOutcome>;
  timedOut: boolean;
  result?: ProviderDeliverOutcome;
};

export class Delivery extends Context.Service<
  Delivery,
  {
    deliverNext(
      run: PermitsNextRequest,
      options?: DrainOptions,
    ): Effect.Effect<DeliveryStepOutcome, DeliveryError>;
    drain(
      run: PermitsNextRequest,
      options?: DrainOptions,
    ): Effect.Effect<DeliveryStepOutcome, DeliveryError>;
  }
>()("@codecast/delivery/Delivery") {
  static layer(options: DeliveryOptions = {}) {
    const maxPermitsPerDrain = options.maxPermitsPerDrain ?? 1024;
    const baseRetryMs = options.baseRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 30_000;
    const maxRetryAttempts = options.maxRetryAttempts ?? 16;

    return Layer.effect(
      Delivery,
      Effect.gen(function* () {
        const bus = yield* SupervisorBus;
        const scope = yield* Effect.scope;
        const subscription = yield* bus.subscribe();

        const locks = makeSessionLocks();
        const activeAttempts = new Set<string>();
        const activeDeliveries = new Set<string>();
        const awaitingReceiptRuns = new Map<string, PermitsNextRequest>();
        const pendingDeliveries = new Map<string, PendingDelivery>();

        const attemptKey = (
          run: Pick<PermitsNextRequest, "session" | "run">,
          attemptId: string,
        ) => JSON.stringify([run.session, run.run, attemptId]);

        const deliveryKey = (
          run: Pick<PermitsNextRequest, "session" | "run">,
          deliveryId: string,
        ) => JSON.stringify([run.session, run.run, deliveryId]);

        const journals = makeJournalStore(options);
        const settlement = makeSettlement({
          bus,
          options,
          journals,
          activeAttempts,
          attemptKey,
          awaitingReceiptRuns,
        });
        const prepareInputs = makeInputPreparation(bus, options);

        const inLayerScope = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.forkIn(effect, scope, { startImmediately: true }).pipe(
            Effect.flatMap((fiber) =>
              Fiber.join(fiber).pipe(
                Effect.onInterrupt(() => Fiber.interrupt(fiber)),
              ),
            ),
          );

        const exclusive = (
          run: PermitsNextRequest,
          permit: Pick<DeliveryPermit, "attempt_id" | "delivery_id">,
          step: Effect.Effect<DeliveryStepOutcome, DeliveryError>,
        ) => {
          const aKey = attemptKey(run, permit.attempt_id);
          const dKey = deliveryKey(run, permit.delivery_id);
          return Effect.sync(() => {
            activeAttempts.add(aKey);
            activeDeliveries.add(dKey);
          }).pipe(
            Effect.flatMap(() => Effect.uninterruptible(step)),
            Effect.ensuring(
              Effect.sync(() => {
                activeAttempts.delete(aKey);
                activeDeliveries.delete(dKey);
              }),
            ),
          );
        };

        const recoverPermit = Effect.fnUntraced(function* (
          run: PermitsNextRequest,
          permit: DeliveryPermit,
        ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
          if (permit.intent !== "steer") {
            return yield* settlement.recoverStarted(
              run,
              permitIdentity(permit),
            );
          }
          const hand = toHandover(permit);
          const journal = yield* journals.loadSteer(run);
          yield* journals.recordHandover(run, journal, hand);
          return yield* settlement.recoverStarted(run, hand);
        });

        const runNewDelivery = Effect.fnUntraced(function* (
          run: PermitsNextRequest,
          permit: DeliveryPermit,
        ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
          const reqId = requestId();
          const startReply = yield* bus
            .request(
              {
                kind: "edge.delivery.start",
                request_id: reqId,
                request: permitIdentity(permit),
              },
              "edge.delivery.start.result",
              (reply) => reply.request_id === reqId,
            )
            .pipe(
              Effect.mapError((error) => mapBusError("delivery.start", error)),
            );
          if (!startReply.ok) {
            if (startReply.retryable) {
              return {
                status: "retry_scheduled",
                retryable: true,
                code: startReply.code,
                retry_after_ms: startReply.retry_after_ms,
              };
            }
            return yield* new DeliveryError({
              operation: "delivery.start",
              code: startReply.code,
            });
          }
          const started = startReply.response;
          if (started.status === "rejected") {
            return {
              status: "rejected",
              delivery_id: permit.delivery_id,
              attempt_id: permit.attempt_id,
              reason: started.reason,
            };
          }
          if (
            !sameLease(run, started) ||
            !sameAttempt(permitIdentity(permit), started)
          ) {
            return yield* new DeliveryError({
              operation: "delivery.start",
              code: "delivery_start_mismatch",
            });
          }
          if (started.status === "already_started") {
            return yield* recoverPermit(run, permit);
          }

          const existingReceipt = yield* journals.findReceipt(
            permit.session,
            permit.delivery_id,
          );
          if (existingReceipt) {
            return yield* settlement.settleApplied(
              run,
              permit,
              existingReceipt,
              "duplicate",
            );
          }

          const inputOutcome = yield* Effect.result(
            prepareInputs(permit, started.input ?? permit.input),
          );
          if (inputOutcome._tag === "Failure") {
            yield* settlement.clearArtifacts(permit.attempt_id);
            const failure = inputOutcome.failure;
            return yield* settlement.settleNonApplied(run, permit, {
              status: "failed",
              retryable: failure.retryable ?? true,
              code: failure.code,
              message: failure.code,
              retry_after_ms: failure.retry_after_ms,
            });
          }

          if (permit.intent === "steer") {
            const steerJournal = yield* journals.loadSteer(run);
            const hand = toHandover(permit);
            if (journals.isBlockedByFence(steerJournal, hand)) {
              yield* settlement.clearArtifacts(permit.attempt_id);
              return { status: "fenced" };
            }
            const before = journals.observedTurn(run);
            if (!matchesExpected(permit.expected, before)) {
              return yield* settlement.settleNonApplied(run, permit, {
                status: "stale",
                observed: before,
              });
            }
            yield* journals.recordHandover(run, steerJournal, hand);
            const current = journals.observedTurn(run);
            if (!matchesExpected(permit.expected, current)) {
              return yield* settlement.settleNonApplied(run, permit, {
                status: "stale",
                observed: current,
              });
            }
          }

          const deliverReqId = requestId();
          const answer = yield* Deferred.make<ProviderDeliverOutcome>();
          const pending: PendingDelivery = {
            session: permit.session,
            run: permit.run,
            delivery_id: permit.delivery_id,
            attempt_id: permit.attempt_id,
            answer,
            timedOut: false,
          };
          setBoundedMap(pendingDeliveries, deliverReqId, pending);
          const timedOut: ProviderDeliverOutcome = {
            status: "in_doubt",
            reason: "unknown",
            code: "provider_timeout",
            message: "Provider delivery timed out",
          };
          const outcome = yield* bus
            .publish({
              kind: "provider.deliver",
              request_id: deliverReqId,
              session: permit.session,
              run: permit.run,
              fencing_token: permit.fencing_token,
              delivery_id: permit.delivery_id,
              attempt_id: permit.attempt_id,
              seq: permit.seq,
              intent: permit.intent,
              sender: { ...permit.sender },
              ...(permit.intent === "steer"
                ? {
                    expected: { ...permit.expected },
                    baton_token: permit.baton_token,
                  }
                : {}),
              input: inputOutcome.success,
            })
            .pipe(
              Effect.flatMap(() => Deferred.await(answer)),
              Effect.timeoutOrElse({
                duration: options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS,
                orElse: () =>
                  Effect.gen(function* () {
                    if (pending.result) return pending.result;
                    pending.timedOut = true;
                    yield* bus
                      .publish({
                        kind: "provider.deliver.cancel",
                        request_id: deliverReqId,
                      })
                      .pipe(Effect.catch(() => Effect.void));
                    return timedOut;
                  }),
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  if (!pending.timedOut) pendingDeliveries.delete(deliverReqId);
                }),
              ),
              Effect.mapError((error) => mapBusError("bus", error)),
            );

          if (
            outcome.status === "delivered" ||
            outcome.status === "duplicate"
          ) {
            if (outcome.receipt.delivery_id !== permit.delivery_id) {
              return yield* settlement.settleNonApplied(run, permit, {
                status: "in_doubt",
                code: "receipt_mismatch",
                message: "Provider receipt did not match delivery_id",
              });
            }
            return yield* settlement.settleApplied(
              run,
              permit,
              outcome.receipt,
              outcome.status,
            );
          }
          if (outcome.status === "stale") {
            return yield* settlement.settleNonApplied(run, permit, {
              status: "stale",
              observed: outcome.observed,
            });
          }
          if (outcome.status === "failed") {
            return yield* settlement.settleNonApplied(run, permit, {
              status: "failed",
              retryable: outcome.retryable,
              code: outcome.code,
              message: outcome.message,
              retry_after_ms: outcome.retry_after_ms,
            });
          }
          return yield* settlement.settleNonApplied(run, permit, {
            status: "in_doubt",
            code: outcome.code,
            message: outcome.message,
            retry_after_ms: outcome.retry_after_ms,
          });
        });

        const selectStep = Effect.fnUntraced(function* (
          run: PermitsNextRequest,
          drainOptions: DrainOptions,
        ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
          const reqId = requestId();
          const permitsReply = yield* bus
            .request(
              {
                kind: "edge.permits.next",
                request_id: reqId,
                request: { ...run },
              },
              "edge.permits.next.result",
              (reply) => reply.request_id === reqId,
            )
            .pipe(
              Effect.mapError((error) => mapBusError("permits.next", error)),
            );
          if (!permitsReply.ok) {
            if (permitsReply.retryable) {
              return {
                status: "retry_scheduled",
                retryable: true,
                code: permitsReply.code,
                retry_after_ms: permitsReply.retry_after_ms,
              };
            }
            return yield* new DeliveryError({
              operation: "permits.next",
              code: permitsReply.code,
            });
          }

          const permit = permitsReply.response;
          if (permit.status === "stale") {
            return { status: "lease_stale", stage: "permits" };
          }
          if (permit.status === "empty") {
            if (options.steerJournal) yield* journals.loadPrunedSteer(run);
            return { status: "empty" };
          }
          if (!sameLease(run, permit)) {
            return yield* new DeliveryError({
              operation: "permits.next",
              code: "delivery_lease_mismatch",
            });
          }
          if (permit.status === "takeover_fence") {
            if (options.allowTakeover === false) {
              return yield* new DeliveryError({
                operation: "permits.next",
                code: "takeover_unsupported",
              });
            }
            return yield* settlement.receiveTakeoverFence(run, permit);
          }

          if (
            activeAttempts.has(attemptKey(run, permit.attempt_id)) ||
            activeDeliveries.has(deliveryKey(run, permit.delivery_id))
          ) {
            return { status: "pending" };
          }

          if (permit.state === "started") {
            return yield* exclusive(run, permit, recoverPermit(run, permit));
          }

          const steerJournal =
            permit.intent === "steer"
              ? yield* journals.loadPrunedSteer(run)
              : undefined;
          if (
            steerJournal?.handovers.some(
              (hand) => hand.attempt_id === permit.attempt_id,
            )
          ) {
            return yield* exclusive(run, permit, recoverPermit(run, permit));
          }

          const existingReceipt = yield* journals.findReceipt(
            permit.session,
            permit.delivery_id,
          );
          if (existingReceipt) {
            return yield* exclusive(run, permit, runNewDelivery(run, permit));
          }

          if (
            drainOptions.sendNew === false ||
            (options.canSendNew && !options.canSendNew(permit))
          ) {
            return { status: "held" };
          }

          if (permit.intent === "steer" && steerJournal) {
            if (journals.isBlockedByFence(steerJournal, toHandover(permit))) {
              return { status: "fenced" };
            }
            const turn = journals.observedTurn(run);
            if (!matchesExpected(permit.expected, turn)) {
              return yield* exclusive(
                run,
                permit,
                settlement.settleNonApplied(run, permit, {
                  status: "stale",
                  observed: turn,
                }),
              );
            }
          }

          return yield* exclusive(run, permit, runNewDelivery(run, permit));
        });

        const replayRecordedReceipt = Effect.fnUntraced(function* (
          run: PermitsNextRequest,
          deliveryId: string,
        ) {
          const receipt = yield* journals
            .findReceipt(run.session, deliveryId)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (!receipt) return;
          yield* bus
            .publish({
              kind: "provider.receipt",
              run: run.run,
              ...receipt,
              session: run.session,
            })
            .pipe(Effect.catch(() => Effect.void));
        });

        const deliverNext = Effect.fn("Delivery.deliverNext")(function* (
          run: PermitsNextRequest,
          drainOptions: DrainOptions = {},
        ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
          const outcome = yield* inLayerScope(
            locks
              .withSessionLock(run.session, selectStep(run, drainOptions))
              .pipe(Effect.catch(retryBusTimeout)),
          );
          if (
            outcome.status === "in_doubt" &&
            outcome.retry_after_ms === undefined
          ) {
            yield* replayRecordedReceipt(run, outcome.delivery_id);
          }
          return outcome;
        });

        const drain = Effect.fn("Delivery.drain")(function* (
          run: PermitsNextRequest,
          drainOptions: DrainOptions = {},
        ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
          const retrySchedule = Schedule.exponential(baseRetryMs).pipe(
            Schedule.modifyDelay(({ duration, input }) =>
              Effect.succeed(
                Math.max(
                  Math.min(toMillis(duration), maxRetryMs),
                  input instanceof RetryableDrainStep
                    ? (input.retryAfterMs ?? 0)
                    : 0,
                ),
              ),
            ),
            Schedule.upTo({ times: maxRetryAttempts }),
          );

          const singleRetryableStep = Effect.fnUntraced(function* () {
            const outcome = yield* deliverNext(run, drainOptions);
            if (shouldRetryOutcome(outcome)) {
              return yield* new RetryableDrainStep({
                outcome,
                retryAfterMs: retryAfterOf(outcome),
              });
            }
            return outcome;
          });

          let lastOutcome: DeliveryStepOutcome = { status: "empty" };
          for (let step = 0; step < maxPermitsPerDrain; step++) {
            const result = yield* Effect.result(
              singleRetryableStep().pipe(
                Effect.retry({
                  schedule: retrySchedule,
                  while: (error): error is RetryableDrainStep =>
                    error instanceof RetryableDrainStep,
                }),
              ),
            );
            if (result._tag === "Failure") {
              if (result.failure instanceof RetryableDrainStep) {
                return result.failure.outcome;
              }
              return yield* result.failure;
            }
            lastOutcome = result.success;
            if (
              lastOutcome.status === "delivered" ||
              lastOutcome.status === "duplicate" ||
              lastOutcome.status === "takeover"
            ) {
              continue;
            }
            return lastOutcome;
          }
          return lastOutcome;
        });

        const wakes = makeWakeScheduler({
          scope,
          maxActiveDrains: options.maxActiveDrains ?? 1024,
          drain,
          log: options.log,
        });

        const acceptReceipt = Effect.fnUntraced(function* (
          session: string,
          run: number,
          receipt: DeliveryReceipt,
        ) {
          yield* journals
            .saveReceipt(session, receipt)
            .pipe(Effect.catch(() => Effect.void));
          const pendingRun = awaitingReceiptRuns.get(session);
          if (pendingRun && pendingRun.run === run) {
            if (yield* wakes.wake(pendingRun, { sendNew: false })) {
              awaitingReceiptRuns.delete(session);
            }
          }
        });

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const message = yield* PubSub.take(subscription);
              switch (message.kind) {
                case "delivery.wake": {
                  yield* wakes.wake(
                    {
                      v: 1,
                      session: message.session,
                      run: message.run,
                      fencing_token: message.fencing_token,
                    },
                    { sendNew: message.send_new },
                  );
                  break;
                }
                case "delivery.stop": {
                  awaitingReceiptRuns.delete(message.session);
                  yield* wakes.stop(message.session);
                  break;
                }
                case "provider.receipt": {
                  yield* Effect.forkIn(
                    acceptReceipt(message.session, message.run, {
                      delivery_id: message.delivery_id,
                      provider_item_id: message.provider_item_id,
                      turn: message.turn,
                    }),
                    scope,
                  );
                  break;
                }
                case "provider.deliver.result": {
                  const pending = pendingDeliveries.get(message.request_id);
                  if (!pending || pending.attempt_id !== message.attempt_id) {
                    break;
                  }
                  if (!pending.timedOut) {
                    pending.result = message.outcome;
                    yield* Deferred.succeed(pending.answer, message.outcome);
                    break;
                  }
                  pendingDeliveries.delete(message.request_id);
                  const { outcome } = message;
                  if (
                    (outcome.status === "delivered" ||
                      outcome.status === "duplicate") &&
                    outcome.receipt.delivery_id === pending.delivery_id
                  ) {
                    yield* Effect.forkIn(
                      acceptReceipt(
                        pending.session,
                        pending.run,
                        outcome.receipt,
                      ),
                      scope,
                    );
                  }
                  break;
                }
              }
            }),
          ),
          { startImmediately: true },
        );

        return Delivery.of({
          deliverNext,
          drain,
        });
      }),
    );
  }
}
