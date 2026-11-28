import { expect } from "bun:test";
import type {
  DeliverySettleRequest,
  PermitsNextRequest,
  PermitsNextResponse,
} from "@codecast/edge-contract";
import {
  SupervisorBus,
  type BusMessageOf,
  type ProviderDeliverOutcome,
  type ProviderRecoverOutcome,
} from "@codecast/edge-supervisor/effect";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { adjust } from "effect/testing/TestClock";
import { Delivery } from "../src/effect";
import type { DeliveryReceipt, ReceiptJournal } from "../src/types";

const run: PermitsNextRequest = {
  v: 1,
  session: "session-1",
  run: 1,
  fencing_token: "lease-1",
};

function makePermit(
  overrides: Partial<Extract<PermitsNextResponse, { status: "permit" }>> = {},
): Extract<PermitsNextResponse, { status: "permit" }> {
  return {
    v: 1,
    status: "permit",
    session: "session-1",
    run: 1,
    fencing_token: "lease-1",
    delivery_id: "delivery-1",
    attempt_id: "attempt-1",
    seq: 1,
    intent: "queue",
    sender: { kind: "person", id: "user-1" },
    state: "new",
    input: [{ type: "text", text: "hello" }],
    ...overrides,
  } as Extract<PermitsNextResponse, { status: "permit" }>;
}

function makeMemoryReceiptJournal(
  seed: Array<[string, DeliveryReceipt]> = [],
): ReceiptJournal & {
  records: Map<string, DeliveryReceipt>;
} {
  const records = new Map<string, DeliveryReceipt>(
    seed.map(([session, receipt]) => [
      `${session}:${receipt.delivery_id}`,
      receipt,
    ]),
  );
  return {
    records,
    async find(session, deliveryId) {
      return records.get(`${session}:${deliveryId}`);
    },
    async record(session, receipt) {
      records.set(`${session}:${receipt.delivery_id}`, receipt);
    },
    async forget(session, deliveryId) {
      records.delete(`${session}:${deliveryId}`);
    },
  };
}

function makeTestHarness(handlers: {
  onPermitsNext: () => BusMessageOf<"edge.permits.next.result"> extends infer R
    ? Omit<R, "kind" | "request_id">
    : never;
  onStart?: (
    req: BusMessageOf<"edge.delivery.start">,
  ) => Omit<BusMessageOf<"edge.delivery.start.result">, "kind" | "request_id">;
  onSettle?: (
    req: DeliverySettleRequest,
  ) => Omit<BusMessageOf<"edge.delivery.settle.result">, "kind" | "request_id">;
  onDeliver?: (
    req: BusMessageOf<"provider.deliver">,
  ) => Effect.Effect<ProviderDeliverOutcome>;
  onRecover?: (
    req: BusMessageOf<"provider.recover">,
  ) => Effect.Effect<ProviderRecoverOutcome>;
}) {
  const calls: string[] = [];
  const settles: DeliverySettleRequest[] = [];
  const deliveries: BusMessageOf<"provider.deliver">[] = [];
  const recoveries: BusMessageOf<"provider.recover">[] = [];

  const attach = Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const sub = yield* bus.subscribe();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const message = yield* PubSub.take(sub);
          switch (message.kind) {
            case "edge.permits.next": {
              calls.push("permits.next");
              const result = handlers.onPermitsNext();
              yield* bus.publish({
                kind: "edge.permits.next.result",
                request_id: message.request_id,
                ...result,
              } as BusMessageOf<"edge.permits.next.result">);
              break;
            }
            case "edge.delivery.start": {
              calls.push(`delivery.start:${message.request.attempt_id}`);
              const result = handlers.onStart
                ? handlers.onStart(message)
                : {
                    ok: true as const,
                    response: {
                      ...message.request,
                      status: "started" as const,
                    },
                  };
              yield* bus.publish({
                kind: "edge.delivery.start.result",
                request_id: message.request_id,
                ...result,
              } as BusMessageOf<"edge.delivery.start.result">);
              break;
            }
            case "edge.delivery.settle": {
              calls.push(
                `delivery.settle:${message.request.attempt_id}:${message.request.outcome}`,
              );
              settles.push(message.request);
              const result = handlers.onSettle
                ? handlers.onSettle(message.request)
                : {
                    ok: true as const,
                    response: { v: 1 as const, status: "recorded" as const },
                  };
              yield* bus.publish({
                kind: "edge.delivery.settle.result",
                request_id: message.request_id,
                ...result,
              } as BusMessageOf<"edge.delivery.settle.result">);
              break;
            }
            case "provider.deliver": {
              calls.push(`provider.deliver:${message.attempt_id}`);
              deliveries.push(message);
              yield* Effect.forkChild(
                Effect.gen(function* () {
                  const outcome: ProviderDeliverOutcome = handlers.onDeliver
                    ? yield* handlers.onDeliver(message)
                    : {
                        status: "delivered",
                        receipt: {
                          delivery_id: message.delivery_id,
                          provider_item_id: `item-${message.attempt_id}`,
                          turn: "turn-1",
                        },
                      };
                  yield* bus.publish({
                    kind: "provider.deliver.result",
                    request_id: message.request_id,
                    delivery_id: message.delivery_id,
                    attempt_id: message.attempt_id,
                    outcome,
                  });
                }),
                { startImmediately: true },
              );
              break;
            }
            case "provider.recover": {
              calls.push(`provider.recover:${message.attempt_id}`);
              recoveries.push(message);
              yield* Effect.forkChild(
                Effect.gen(function* () {
                  const outcome: ProviderRecoverOutcome = handlers.onRecover
                    ? yield* handlers.onRecover(message)
                    : {
                        status: "in_doubt",
                        code: "unknown",
                        message: "still uncertain",
                      };
                  yield* bus.publish({
                    kind: "provider.recover.result",
                    request_id: message.request_id,
                    delivery_id: message.delivery_id,
                    attempt_id: message.attempt_id,
                    outcome,
                  });
                }),
                { startImmediately: true },
              );
              break;
            }
          }
        }),
      ),
      { startImmediately: true },
    );
  });

  return { calls, settles, deliveries, recoveries, attach };
}

it.effect(
  "exactly once: concurrent wakes deliver and settle a permit once",
  () =>
    Effect.gen(function* () {
      const queue: PermitsNextResponse[] = [makePermit()];
      const gate = yield* Deferred.make<void>();
      const journal = makeMemoryReceiptJournal();
      const harness = makeTestHarness({
        onPermitsNext: () => ({
          ok: true,
          response: queue.shift() ?? { v: 1, status: "empty" },
        }),
        onDeliver: (req) =>
          Effect.gen(function* () {
            yield* Deferred.await(gate);
            return {
              status: "delivered",
              receipt: {
                delivery_id: req.delivery_id,
                provider_item_id: "item-1",
                turn: "turn-1",
              },
            };
          }),
      });

      const deliveryLayer = Delivery.layer({ receiptJournal: journal });
      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const first = yield* Effect.forkChild(delivery.deliverNext(run), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(delivery.deliverNext(run), {
          startImmediately: true,
        });
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        const firstOutcome = yield* Fiber.await(first);
        const secondOutcome = yield* Fiber.await(second);
        expect(firstOutcome._tag).toBe("Success");
        expect(secondOutcome._tag).toBe("Success");
        expect(harness.deliveries).toHaveLength(1);
        expect(harness.settles).toHaveLength(1);
        expect(harness.settles[0]).toMatchObject({
          delivery_id: "delivery-1",
          outcome: "applied",
        });
        expect(journal.records.size).toBe(0);
      }).pipe(
        Effect.provide(Layer.provideMerge(deliveryLayer, SupervisorBus.layer)),
      );
    }),
);

it.effect(
  "duplicate: settles existing journal receipt without re-delivering and handles provider duplicate outcome",
  () =>
    Effect.gen(function* () {
      const receipt: DeliveryReceipt = {
        delivery_id: "delivery-1",
        provider_item_id: "item-1",
        turn: "turn-1",
      };
      const journal = makeMemoryReceiptJournal([["session-1", receipt]]);
      const queue: PermitsNextResponse[] = [
        makePermit({ delivery_id: "delivery-1", attempt_id: "attempt-1" }),
        makePermit({ delivery_id: "delivery-2", attempt_id: "attempt-2" }),
      ];
      const harness = makeTestHarness({
        onPermitsNext: () => ({
          ok: true,
          response: queue.shift() ?? { v: 1, status: "empty" },
        }),
        onSettle: () => ({
          ok: true,
          response: { v: 1, status: "duplicate" },
        }),
        onDeliver: (req) =>
          Effect.succeed({
            status: "duplicate",
            receipt: {
              delivery_id: req.delivery_id,
              provider_item_id: "item-2",
              turn: "turn-1",
            },
          }),
      });

      const deliveryLayer = Delivery.layer({ receiptJournal: journal });
      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const first = yield* delivery.deliverNext(run);
        expect(first).toEqual({
          status: "duplicate",
          delivery_id: "delivery-1",
          attempt_id: "attempt-1",
          receipt,
          receipt_status: "duplicate",
        });
        expect(harness.deliveries).toHaveLength(0);
        expect(harness.calls).not.toContain("delivery.start:attempt-1");

        const second = yield* delivery.deliverNext(run);
        expect(second).toEqual({
          status: "duplicate",
          delivery_id: "delivery-2",
          attempt_id: "attempt-2",
          receipt: {
            delivery_id: "delivery-2",
            provider_item_id: "item-2",
            turn: "turn-1",
          },
          receipt_status: "duplicate",
        });
        expect(harness.deliveries).toHaveLength(1);
        expect(harness.settles).toHaveLength(2);
        expect(journal.records.size).toBe(0);
      }).pipe(
        Effect.provide(Layer.provideMerge(deliveryLayer, SupervisorBus.layer)),
      );
    }),
);

it.effect(
  "in doubt: settles in_doubt without resending and resolves on late provider.receipt",
  () =>
    Effect.gen(function* () {
      const queue: PermitsNextResponse[] = [
        makePermit({ state: "new" }),
        makePermit({ state: "started" }),
      ];
      const journal = makeMemoryReceiptJournal();
      let cleared = false;
      const harness = makeTestHarness({
        onPermitsNext: () => ({
          ok: true,
          response: queue.shift() ?? { v: 1, status: "empty" },
        }),
        onDeliver: () =>
          Effect.succeed({
            status: "in_doubt",
            reason: "unknown",
            code: "rpc_timeout",
            message: "Turn start timed out",
          }),
      });

      const deliveryLayer = Delivery.layer({
        receiptJournal: journal,
        clearArtifacts: async () => {
          cleared = true;
        },
      });
      yield* Effect.gen(function* () {
        yield* harness.attach;
        const bus = yield* SupervisorBus;
        const delivery = yield* Delivery;
        const first = yield* delivery.deliverNext(run);
        expect(first).toMatchObject({
          status: "in_doubt",
          delivery_id: "delivery-1",
          attempt_id: "attempt-1",
          code: "rpc_timeout",
          receipt_status: "recorded",
        });
        expect(cleared).toBe(false);
        expect(harness.settles[0]).toMatchObject({ outcome: "in_doubt" });

        const sub = yield* bus.subscribe();
        yield* bus.publish({
          kind: "provider.receipt",
          session: "session-1",
          run: 1,
          delivery_id: "delivery-1",
          provider_item_id: "item-late",
          turn: "turn-2",
        });
        while (true) {
          const event = yield* PubSub.take(sub);
          if (
            event.kind === "delivery.settled" &&
            event.outcome === "delivered" &&
            event.delivery_id === "delivery-1"
          ) {
            break;
          }
        }
        expect(harness.deliveries).toHaveLength(1);
        expect(harness.settles).toHaveLength(2);
        expect(harness.settles[1]).toMatchObject({
          delivery_id: "delivery-1",
          outcome: "applied",
          resolution_evidence: JSON.stringify({
            delivery_id: "delivery-1",
            provider_item_id: "item-late",
            turn: "turn-2",
          }),
        });
        expect(cleared).toBe(true);
        expect(journal.records.size).toBe(0);
      }).pipe(
        Effect.provide(Layer.provideMerge(deliveryLayer, SupervisorBus.layer)),
      );
    }),
);

it.effect(
  "retry after: honors retry_after_ms on TestClock before retrying",
  () =>
    Effect.gen(function* () {
      let attempts = 0;
      const harness = makeTestHarness({
        onPermitsNext: () => {
          attempts += 1;
          if (attempts === 1) {
            return {
              ok: false,
              retryable: true,
              code: "rate_limited",
              retry_after_ms: 5_000,
            };
          }
          if (attempts === 2) {
            return { ok: true, response: makePermit() };
          }
          return { ok: true, response: { v: 1, status: "empty" } };
        },
      });

      const deliveryLayer = Delivery.layer({
        baseRetryMs: 100,
        maxRetryMs: 10_000,
      });
      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const fiber = yield* Effect.forkChild(delivery.drain(run), {
          startImmediately: true,
        });
        yield* adjust(4_999);
        expect(attempts).toBe(1);
        expect(harness.deliveries).toHaveLength(0);

        yield* adjust(1);
        const result = yield* Fiber.await(fiber);
        expect(result._tag).toBe("Success");
        expect(attempts).toBe(3);
        expect(harness.deliveries).toHaveLength(1);
        expect(harness.settles).toHaveLength(1);
        expect(harness.settles[0]).toMatchObject({ outcome: "applied" });
      }).pipe(
        Effect.provide(Layer.provideMerge(deliveryLayer, SupervisorBus.layer)),
      );
    }),
);

it.effect(
  "shutdown during delivery completes start, deliver, and settle as one uninterruptible step",
  () =>
    Effect.gen(function* () {
      const queue: PermitsNextResponse[] = [
        makePermit({ delivery_id: "delivery-1", attempt_id: "attempt-1" }),
        makePermit({ delivery_id: "delivery-2", attempt_id: "attempt-2" }),
      ];
      const enteredDeliver = yield* Deferred.make<void>();
      const releaseDeliver = yield* Deferred.make<void>();
      const harness = makeTestHarness({
        onPermitsNext: () => ({
          ok: true,
          response: queue.shift() ?? { v: 1, status: "empty" },
        }),
        onDeliver: (req) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(enteredDeliver, undefined);
            yield* Deferred.await(releaseDeliver);
            return {
              status: "delivered",
              receipt: {
                delivery_id: req.delivery_id,
                provider_item_id: "item-1",
                turn: "turn-1",
              },
            };
          }),
      });

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const bus = yield* SupervisorBus;
        const deliveryScope = yield* Scope.make();
        yield* Delivery.layer().pipe(
          Layer.buildWithScope(deliveryScope),
          Effect.provideService(SupervisorBus, bus),
        );

        yield* bus.publish({
          kind: "delivery.wake",
          session: "session-1",
          run: 1,
          fencing_token: "lease-1",
        });
        yield* Deferred.await(enteredDeliver);

        let closed = false;
        const closing = yield* Effect.forkChild(
          Scope.close(deliveryScope, Exit.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;
        expect(closed).toBe(false);
        expect(harness.settles).toHaveLength(0);

        yield* Deferred.succeed(releaseDeliver, undefined);
        yield* Fiber.await(closing);
        expect(closed).toBe(true);
        expect(harness.settles).toHaveLength(1);
        expect(harness.settles[0]).toMatchObject({
          delivery_id: "delivery-1",
          outcome: "applied",
        });
        expect(harness.deliveries).toHaveLength(1);
      }).pipe(Effect.provide(SupervisorBus.layer));
    }),
);

it.effect(
  "restart settles started deliveries from receipt journal or provider.recover without resending",
  () =>
    Effect.gen(function* () {
      const journal = makeMemoryReceiptJournal([
        [
          "session-1",
          {
            delivery_id: "delivery-1",
            provider_item_id: "item-1",
            turn: "turn-1",
          },
        ],
      ]);
      const queue: PermitsNextResponse[] = [
        makePermit({
          delivery_id: "delivery-1",
          attempt_id: "attempt-1",
          state: "started",
        }),
        makePermit({
          delivery_id: "delivery-2",
          attempt_id: "attempt-2",
          state: "started",
        }),
      ];
      const harness = makeTestHarness({
        onPermitsNext: () => ({
          ok: true,
          response: queue.shift() ?? { v: 1, status: "empty" },
        }),
        onRecover: (req) =>
          Effect.succeed({
            status: "delivered",
            receipt: {
              delivery_id: req.delivery_id,
              provider_item_id: "recovered-item-2",
              turn: "turn-2",
            },
          }),
      });

      const restartedLayer = Delivery.layer({ receiptJournal: journal });
      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const outcome = yield* delivery.drain(run);
        expect(outcome).toEqual({ status: "empty" });
        expect(harness.deliveries).toHaveLength(0);
        expect(harness.calls).not.toContain("delivery.start:attempt-1");
        expect(harness.calls).not.toContain("delivery.start:attempt-2");
        expect(harness.recoveries.map((r) => r.delivery_id)).toEqual([
          "delivery-2",
        ]);
        expect(harness.settles).toHaveLength(2);
        expect(harness.settles[0]).toMatchObject({
          delivery_id: "delivery-1",
          outcome: "applied",
        });
        expect(harness.settles[1]).toMatchObject({
          delivery_id: "delivery-2",
          outcome: "applied",
          resolution_evidence: JSON.stringify({
            delivery_id: "delivery-2",
            provider_item_id: "recovered-item-2",
            turn: "turn-2",
          }),
        });
        expect(journal.records.size).toBe(0);
      }).pipe(
        Effect.provide(Layer.provideMerge(restartedLayer, SupervisorBus.layer)),
      );
    }),
);
