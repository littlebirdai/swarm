import {
  matchesExpected,
  type PermitsNextRequest,
} from "@codecast/edge-contract";
import {
  BusTimeoutError,
  BusValidationError,
  SupervisorBus,
  type ProviderDeliverInput,
  type ProviderDeliverOutcome,
} from "@codecast/edge-supervisor/effect";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import { toMillis } from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import {
  DeliveryError,
  makeJournalStore,
  permitIdentity,
  requestId,
  sameAttempt,
  sameLease,
  setBoundedMap,
  toHandover,
} from "./journals";
import { makeSettlement } from "./settlement";
import type {
  DeliveryOptions,
  DeliveryPermit,
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

        const sessionLocks = new Map<string, Semaphore.Semaphore>();
        const activeAttempts = new Set<string>();
        const activeDeliveries = new Set<string>();
        const activeDrains = new Map<
          string,
          Fiber.Fiber<DeliveryStepOutcome, DeliveryError>
        >();
        const awaitingReceiptRuns = new Map<string, PermitsNextRequest>();

        const lockFor = (session: string) => {
          let lock = sessionLocks.get(session);
          if (!lock) {
            lock = Semaphore.makeUnsafe(1);
            setBoundedMap(sessionLocks, session, lock);
          }
          return lock;
        };

        const attemptKey = (
          run: Pick<PermitsNextRequest, "session" | "run">,
          attemptId: string,
        ) => JSON.stringify([run.session, run.run, attemptId]);

        const deliveryKey = (
          run: Pick<PermitsNextRequest, "session" | "run">,
          deliveryId: string,
        ) => JSON.stringify([run.session, run.run, deliveryId]);

        const mapBusError = (
          operation: DeliveryError["operation"],
          error: BusValidationError | BusTimeoutError,
        ) =>
          new DeliveryError({
            operation,
            code:
              error._tag === "BusTimeoutError"
                ? "bus_timeout"
                : "bus_validation_failed",
            retryable: error._tag === "BusTimeoutError",
            cause: error,
          });

        const journals = makeJournalStore(options);
        const settlement = makeSettlement({
          bus,
          options,
          journals,
          activeAttempts,
          attemptKey,
          awaitingReceiptRuns,
        });

        const prepareInputs = Effect.fnUntraced(function* (
          permit: DeliveryPermit,
          parts: DeliveryPermit["input"],
        ) {
          const prepared: ProviderDeliverInput[] = [];
          for (const part of parts) {
            if (part.type === "text") {
              const text = options.prepareText
                ? yield* Effect.tryPromise({
                    try: (signal) =>
                      options.prepareText!(part.text, permit, signal),
                    catch: (cause) =>
                      new DeliveryError({
                        operation: "blobs.get",
                        code: "input_preparation_failed",
                        retryable: true,
                        cause,
                      }),
                  })
                : part.text;
              prepared.push({ type: "text", text });
              continue;
            }
            const reqId = requestId();
            const blobReply = yield* bus
              .request(
                {
                  kind: "edge.blob.get",
                  request_id: reqId,
                  request: {
                    v: 1,
                    session: permit.session,
                    run: permit.run,
                    fencing_token: permit.fencing_token,
                    attempt_id: permit.attempt_id,
                    blob_id: part.blob_id,
                  },
                },
                "edge.blob.get.result",
                (reply) => reply.request_id === reqId,
              )
              .pipe(
                Effect.mapError((error) => mapBusError("blobs.get", error)),
              );
            if (!blobReply.ok) {
              return yield* new DeliveryError({
                operation: "blobs.get",
                code: blobReply.code,
                retryable: blobReply.retryable,
                retry_after_ms: blobReply.retry_after_ms,
              });
            }
            if (blobReply.content_type !== part.content_type) {
              return yield* new DeliveryError({
                operation: "blobs.get",
                code: "blob_content_type_mismatch",
                retryable: false,
              });
            }
            if (!options.saveBlob) {
              return yield* new DeliveryError({
                operation: "blobs.get",
                code: "blob_storage_unavailable",
                retryable: true,
              });
            }
            const localPath = yield* Effect.tryPromise({
              try: (signal) =>
                options.saveBlob!(
                  permit,
                  prepared.length,
                  blobReply.content_type,
                  blobReply.bytes,
                  signal,
                ),
              catch: (cause) =>
                new DeliveryError({
                  operation: "blobs.get",
                  code: "blob_save_failed",
                  retryable: true,
                  cause,
                }),
            });
            prepared.push({ type: "local-image", path: localPath });
          }
          return prepared;
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
            return yield* settlement.recoverStarted(
              run,
              permit.intent === "steer"
                ? toHandover(permit)
                : permitIdentity(permit),
            );
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
          const providerReply = yield* bus
            .request(
              {
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
              },
              "provider.deliver.result",
              (reply) =>
                reply.request_id === deliverReqId &&
                reply.attempt_id === permit.attempt_id,
            )
            .pipe(
              Effect.catchTag("BusTimeoutError", () => {
                const timedOut: { readonly outcome: ProviderDeliverOutcome } = {
                  outcome: {
                    status: "in_doubt",
                    reason: "unknown",
                    code: "provider_timeout",
                    message: "Provider delivery timed out",
                  },
                };
                return Effect.succeed(timedOut);
              }),
              Effect.mapError((error) => mapBusError("bus", error)),
            );

          const { outcome } = providerReply;
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

        const deliverNext = Effect.fn("Delivery.deliverNext")(function* (
          run: PermitsNextRequest,
          drainOptions: DrainOptions = {},
        ): Effect.fn.Return<DeliveryStepOutcome, DeliveryError> {
          return yield* lockFor(run.session).withPermit(
            Effect.gen(function* () {
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
                  Effect.mapError((error) =>
                    mapBusError("permits.next", error),
                  ),
                );
              if (!permitsReply.ok) {
                if (permitsReply.retryable) {
                  return {
                    status: "retry_scheduled" as const,
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
              if (permit.status === "stale")
                return { status: "lease_stale" as const };
              if (permit.status === "empty") {
                if (options.steerJournal) yield* journals.loadPrunedSteer(run);
                return { status: "empty" as const };
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

              const aKey = attemptKey(run, permit.attempt_id);
              const dKey = deliveryKey(run, permit.delivery_id);
              if (activeAttempts.has(aKey) || activeDeliveries.has(dKey)) {
                const pending: DeliveryStepOutcome = { status: "pending" };
                return pending;
              }

              const existingReceipt = yield* journals.findReceipt(
                permit.session,
                permit.delivery_id,
              );
              if (existingReceipt) {
                activeAttempts.add(aKey);
                activeDeliveries.add(dKey);
                return yield* Effect.uninterruptible(
                  settlement.settleApplied(
                    run,
                    permit,
                    existingReceipt,
                    permit.state === "started" ? "delivered" : "duplicate",
                  ),
                ).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      activeAttempts.delete(aKey);
                      activeDeliveries.delete(dKey);
                    }),
                  ),
                );
              }

              if (permit.state === "started") {
                activeAttempts.add(aKey);
                activeDeliveries.add(dKey);
                return yield* Effect.uninterruptible(
                  settlement.recoverStarted(
                    run,
                    permit.intent === "steer"
                      ? toHandover(permit)
                      : permitIdentity(permit),
                  ),
                ).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      activeAttempts.delete(aKey);
                      activeDeliveries.delete(dKey);
                    }),
                  ),
                );
              }

              if (
                drainOptions.sendNew === false ||
                (options.canSendNew && !options.canSendNew(permit))
              ) {
                const held: DeliveryStepOutcome = { status: "held" };
                return held;
              }

              if (permit.intent === "steer") {
                const steerJournal = yield* journals.loadPrunedSteer(run);
                const hand = toHandover(permit);
                if (journals.isBlockedByFence(steerJournal, hand)) {
                  const fenced: DeliveryStepOutcome = { status: "fenced" };
                  return fenced;
                }
                const turn = journals.observedTurn(run);
                if (!matchesExpected(permit.expected, turn)) {
                  activeAttempts.add(aKey);
                  activeDeliveries.add(dKey);
                  return yield* Effect.uninterruptible(
                    settlement.settleNonApplied(run, permit, {
                      status: "stale",
                      observed: turn,
                    }),
                  ).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        activeAttempts.delete(aKey);
                        activeDeliveries.delete(dKey);
                      }),
                    ),
                  );
                }
              }

              activeAttempts.add(aKey);
              activeDeliveries.add(dKey);
              return yield* Effect.uninterruptible(
                runNewDelivery(run, permit),
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    activeAttempts.delete(aKey);
                    activeDeliveries.delete(dKey);
                  }),
                ),
              );
            }),
          );
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

        const triggerWake = Effect.fnUntraced(function* (
          run: PermitsNextRequest,
          drainOptions: DrainOptions,
        ) {
          const previous = activeDrains.get(run.session);
          if (previous) {
            yield* Fiber.interrupt(previous);
          }
          const fiber = yield* Effect.forkIn(
            drain(run, drainOptions).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  options.log?.(
                    `[delivery] drain failed for ${run.session}: ${error.code}`,
                  );
                }).pipe(Effect.as({ status: "empty" } as DeliveryStepOutcome)),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (activeDrains.get(run.session) === fiber) {
                    activeDrains.delete(run.session);
                  }
                }),
              ),
            ),
            scope,
            { startImmediately: true },
          );
          activeDrains.set(run.session, fiber);
        });

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const message = yield* PubSub.take(subscription);
              switch (message.kind) {
                case "delivery.wake": {
                  yield* triggerWake(
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
                  const fiber = activeDrains.get(message.session);
                  if (fiber) {
                    yield* Fiber.interrupt(fiber);
                  }
                  break;
                }
                case "provider.receipt": {
                  yield* journals
                    .saveReceipt(message.session, {
                      delivery_id: message.delivery_id,
                      provider_item_id: message.provider_item_id,
                      turn: message.turn,
                    })
                    .pipe(Effect.catch(() => Effect.void));
                  const pendingRun = awaitingReceiptRuns.get(message.session);
                  if (pendingRun && pendingRun.run === message.run) {
                    awaitingReceiptRuns.delete(message.session);
                    yield* triggerWake(pendingRun, {});
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
