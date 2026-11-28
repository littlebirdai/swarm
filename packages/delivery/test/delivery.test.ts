import { expect } from "bun:test";
import { SupervisorBus } from "@codecast/edge-supervisor/effect";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { adjust } from "effect/testing/TestClock";
import { Delivery } from "../src/effect";
import type { DeliveryOptions, DeliveryReceipt } from "../src/types";
import {
  makeFakeServer,
  makeMemoryReceiptJournal,
  makePermit,
  makeTestHarness,
  pause,
  run,
  watchSettled,
  within,
  type HarnessHandlers,
} from "./fake-edge";

function withDelivery<A, E>(
  options: DeliveryOptions,
  body: Effect.Effect<A, E, Delivery | SupervisorBus | Scope.Scope>,
) {
  return body.pipe(
    Effect.provide(
      Layer.provideMerge(Delivery.layer(options), SupervisorBus.layer),
    ),
  );
}

function setup(
  permits: Parameters<typeof makeFakeServer>[0],
  handlers?: HarnessHandlers,
) {
  const server = makeFakeServer(permits);
  return { server, harness: makeTestHarness(server, handlers) };
}

it.effect(
  "exactly once: concurrent wakes deliver and settle a permit once",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const journal = makeMemoryReceiptJournal();
      const { server, harness } = setup([makePermit()], {
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

      yield* withDelivery(
        { receiptJournal: journal },
        Effect.gen(function* () {
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
          expect((yield* Fiber.await(first))._tag).toBe("Success");
          expect((yield* Fiber.await(second))._tag).toBe("Success");
          expect(harness.deliveries).toHaveLength(1);
          expect(server.settles).toHaveLength(1);
          expect(server.settles[0]).toMatchObject({
            delivery_id: "delivery-1",
            outcome: "applied",
          });
          expect(journal.records.size).toBe(0);
        }),
      );
    }),
);

it.effect(
  "duplicate: a new permit with a journal receipt starts, then settles without re-delivering",
  () =>
    Effect.gen(function* () {
      const receipt: DeliveryReceipt = {
        delivery_id: "delivery-1",
        provider_item_id: "item-1",
        turn: "turn-1",
      };
      const journal = makeMemoryReceiptJournal([["session-1", receipt]]);
      const { server, harness } = setup(
        [
          makePermit({ delivery_id: "delivery-1", attempt_id: "attempt-1" }),
          makePermit({ delivery_id: "delivery-2", attempt_id: "attempt-2" }),
        ],
        {
          onDeliver: (req) =>
            Effect.succeed({
              status: "duplicate",
              receipt: {
                delivery_id: req.delivery_id,
                provider_item_id: "item-2",
                turn: "turn-1",
              },
            }),
        },
      );

      yield* withDelivery(
        { receiptJournal: journal },
        Effect.gen(function* () {
          yield* harness.attach;
          const delivery = yield* Delivery;
          const first = yield* delivery.deliverNext(run);
          expect(first).toEqual({
            status: "duplicate",
            delivery_id: "delivery-1",
            attempt_id: "attempt-1",
            receipt,
            receipt_status: "recorded",
          });
          expect(harness.deliveries).toHaveLength(0);
          expect(harness.calls).toEqual([
            "permits.next",
            "delivery.start:attempt-1",
            "delivery.settle:attempt-1:applied",
          ]);

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
            receipt_status: "recorded",
          });
          expect(harness.deliveries).toHaveLength(1);
          expect(server.settles).toHaveLength(2);
          expect(server.head()).toBeUndefined();
          expect(journal.records.size).toBe(0);
        }),
      );
    }),
);

it.effect(
  "in doubt: settles in_doubt, then a late provider.receipt settles it without sending the next message",
  () =>
    Effect.gen(function* () {
      const journal = makeMemoryReceiptJournal();
      let cleared = false;
      const { server, harness } = setup(
        [
          makePermit(),
          makePermit({ delivery_id: "delivery-2", attempt_id: "attempt-2" }),
        ],
        {
          onDeliver: () =>
            Effect.succeed({
              status: "in_doubt",
              reason: "unknown",
              code: "rpc_timeout",
              message: "Turn start timed out",
            }),
        },
      );

      yield* withDelivery(
        {
          receiptJournal: journal,
          clearArtifacts: async () => {
            cleared = true;
          },
        },
        Effect.gen(function* () {
          yield* harness.attach;
          const bus = yield* SupervisorBus;
          const delivery = yield* Delivery;
          const settled = yield* watchSettled;
          const first = yield* delivery.deliverNext(run);
          expect(first).toMatchObject({
            status: "in_doubt",
            delivery_id: "delivery-1",
            attempt_id: "attempt-1",
            code: "rpc_timeout",
            receipt_status: "recorded",
          });
          expect(cleared).toBe(false);
          expect(server.head()?.state).toBe("ambiguous");

          yield* bus.publish({
            kind: "provider.receipt",
            session: "session-1",
            run: 1,
            delivery_id: "delivery-1",
            provider_item_id: "item-late",
            turn: "turn-2",
          });
          yield* within(
            settled("session-1", "delivered", "delivery-1"),
            "the late receipt settles delivery-1",
          );
          yield* pause(20);
          expect(harness.deliveries).toHaveLength(1);
          expect(server.settles).toHaveLength(2);
          expect(server.settles[1]).toMatchObject({
            delivery_id: "delivery-1",
            outcome: "applied",
            resolution_evidence: JSON.stringify({
              delivery_id: "delivery-1",
              provider_item_id: "item-late",
              turn: "turn-2",
            }),
          });
          expect(server.head()?.permit.delivery_id).toBe("delivery-2");
          expect(cleared).toBe(true);
          expect(journal.records.size).toBe(0);
        }),
      );
    }),
);

it.effect(
  "retry after: honors retry_after_ms on TestClock before retrying",
  () =>
    Effect.gen(function* () {
      let attempts = 0;
      const { server, harness } = setup([makePermit()], {
        permitsFailure: () => {
          attempts += 1;
          return attempts === 1
            ? {
                ok: false,
                retryable: true,
                code: "rate_limited",
                retry_after_ms: 5_000,
              }
            : undefined;
        },
      });

      yield* withDelivery(
        { baseRetryMs: 100, maxRetryMs: 10_000 },
        Effect.gen(function* () {
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
          expect(server.settles).toMatchObject([{ outcome: "applied" }]);
        }),
      );
    }),
);

it.effect(
  "shutdown during delivery completes start, deliver, and settle as one uninterruptible step",
  () =>
    Effect.gen(function* () {
      const enteredDeliver = yield* Deferred.make<void>();
      const releaseDeliver = yield* Deferred.make<void>();
      const { server, harness } = setup(
        [
          makePermit({ delivery_id: "delivery-1", attempt_id: "attempt-1" }),
          makePermit({ delivery_id: "delivery-2", attempt_id: "attempt-2" }),
        ],
        {
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
        },
      );

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
        yield* within(Deferred.await(enteredDeliver), "the provider call");

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
        expect(server.settles).toHaveLength(0);

        yield* Deferred.succeed(releaseDeliver, undefined);
        yield* within(Fiber.await(closing), "the delivery scope to close");
        expect(closed).toBe(true);
        expect(server.settles).toMatchObject([
          { delivery_id: "delivery-1", outcome: "applied" },
        ]);
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
      const { server, harness } = setup(
        [
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
        ],
        {
          onRecover: (req) =>
            Effect.succeed({
              status: "delivered",
              receipt: {
                delivery_id: req.delivery_id,
                provider_item_id: "recovered-item-2",
                turn: "turn-2",
              },
            }),
        },
      );

      yield* withDelivery(
        { receiptJournal: journal },
        Effect.gen(function* () {
          yield* harness.attach;
          const delivery = yield* Delivery;
          const outcome = yield* delivery.drain(run);
          expect(outcome).toEqual({ status: "empty" });
          expect(harness.deliveries).toHaveLength(0);
          expect(server.starts).toHaveLength(0);
          expect(harness.recoveries.map((r) => r.delivery_id)).toEqual([
            "delivery-2",
          ]);
          expect(server.settles).toMatchObject([
            { delivery_id: "delivery-1", outcome: "applied" },
            {
              delivery_id: "delivery-2",
              outcome: "applied",
              resolution_evidence: JSON.stringify({
                delivery_id: "delivery-2",
                provider_item_id: "recovered-item-2",
                turn: "turn-2",
              }),
            },
          ]);
          expect(journal.records.size).toBe(0);
        }),
      );
    }),
);
