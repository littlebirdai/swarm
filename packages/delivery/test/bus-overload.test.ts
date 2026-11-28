import { expect } from "bun:test";
import { SupervisorBus } from "@codecast/edge-supervisor/effect";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { adjust } from "effect/testing/TestClock";
import { Delivery } from "../src/effect";
import type { ReceiptJournal } from "../src/types";
import {
  makeFakeServer,
  makePermit,
  makeTestHarness,
  run,
  within,
} from "./fake-edge";

const WAITING_LIMIT = 4_096;

const fillTheWaitingRequests = Effect.gen(function* () {
  const bus = yield* SupervisorBus;
  const fillers: Fiber.Fiber<unknown, unknown>[] = [];
  for (let index = 0; index < WAITING_LIMIT; index++) {
    fillers.push(
      yield* Effect.forkChild(
        bus.request(
          {
            kind: "edge.blob.get",
            request_id: `filler-${index}`,
            request: {
              v: 1,
              session: "filler",
              run: 1,
              fencing_token: "lease-1",
              attempt_id: "attempt-filler",
              blob_id: "blob-filler",
            },
          },
          "edge.blob.get.result",
          (reply) => reply.request_id === `filler-${index}`,
        ),
        { startImmediately: true },
      ),
    );
  }
  return fillers;
});

it.effect(
  "a drain whose settlement meets an overloaded bus backs off, then settles",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      const server = makeFakeServer([makePermit()]);
      const harness = makeTestHarness(server, {
        onDeliver: (req) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(go)),
            Effect.as({
              status: "delivered" as const,
              receipt: {
                delivery_id: req.delivery_id,
                provider_item_id: "item-1",
                turn: "turn-1",
              },
            }),
          ),
      });

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const drained = yield* Effect.forkChild(delivery.drain(run), {
          startImmediately: true,
        });
        yield* within(Deferred.await(entered), "the provider call");
        const fillers = yield* fillTheWaitingRequests;
        yield* Deferred.succeed(go, undefined);
        yield* within(
          Effect.repeat(Effect.yieldNow, {
            until: () => server.head()?.state === "delivery-started",
          }),
          "the refused settlement",
        );
        expect(server.settles).toHaveLength(0);
        yield* Fiber.interruptAll(fillers);
        yield* adjust(1_000);
        expect(yield* within(Fiber.join(drained), "the drain")).toEqual({
          status: "empty",
        });
        expect(harness.deliveries).toHaveLength(1);
        expect(server.settles).toMatchObject([{ outcome: "applied" }]);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Delivery.layer({ baseRetryMs: 100 }),
            SupervisorBus.layer,
          ),
        ),
      );
    }),
  20_000,
);

it.effect(
  "a recovery that meets an overloaded bus is a retry, not an in-doubt settlement",
  () =>
    Effect.gen(function* () {
      const server = makeFakeServer([makePermit({ state: "started" })]);
      const harness = makeTestHarness(server);
      const reading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const journal: ReceiptJournal = {
        find: async () => {
          reading.resolve();
          await release.promise;
          return undefined;
        },
        record: async () => {},
        forget: async () => {},
      };

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const step = yield* Effect.forkChild(delivery.deliverNext(run), {
          startImmediately: true,
        });
        yield* within(
          Effect.promise(() => reading.promise),
          "the receipt journal read",
        );
        const fillers = yield* fillTheWaitingRequests;
        release.resolve();
        const outcome = yield* within(Fiber.join(step), "the delivery step");
        expect(outcome).toMatchObject({
          status: "retry_scheduled",
          code: "bus_overloaded",
        });
        expect(harness.recoveries).toHaveLength(0);
        expect(server.settles).toEqual([]);
        expect(server.head()?.state).toBe("delivery-started");
        yield* Fiber.interruptAll(fillers);
      }).pipe(
        Effect.ensuring(Effect.sync(() => release.resolve())),
        Effect.provide(
          Layer.provideMerge(
            Delivery.layer({ receiptJournal: journal }),
            SupervisorBus.layer,
          ),
        ),
      );
    }),
  20_000,
);
