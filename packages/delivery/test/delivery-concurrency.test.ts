import { expect } from "bun:test";
import {
  SupervisorBus,
  type ProviderDeliverOutcome,
} from "@codecast/edge-supervisor/effect";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { adjust } from "effect/testing/TestClock";
import { Delivery } from "../src/effect";
import { deliveryServiceLayer } from "../src/service-layer";
import {
  fakeServerBridge,
  makeFakeServer,
  makeMemoryReceiptJournal,
  makePermit,
  makeTestHarness,
  pause,
  run,
  runFor,
  watchSettled,
  within,
} from "./fake-edge";

const receiptFor = (deliveryId: string) => ({
  delivery_id: deliveryId,
  provider_item_id: `item-${deliveryId}`,
  turn: "turn-1",
});

const deliveredFor = (deliveryId: string): ProviderDeliverOutcome => ({
  status: "delivered",
  receipt: receiptFor(deliveryId),
});

const wake = (session: string) =>
  Effect.flatMap(SupervisorBus, (bus) =>
    bus.publish({
      kind: "delivery.wake",
      session,
      run: 1,
      fencing_token: "lease-1",
    }),
  );

it.effect(
  "a session lock in use is never dropped while other sessions come and go",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const server = makeFakeServer([makePermit()]);
      const harness = makeTestHarness(server, {
        onDeliver: (req) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return deliveredFor(req.delivery_id);
          }),
      });

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const first = yield* Effect.forkChild(delivery.deliverNext(run), {
          startImmediately: true,
        });
        yield* within(Deferred.await(entered), "the first delivery");
        for (let index = 0; index < 1_100; index++) {
          yield* delivery.deliverNext(runFor(`other-${index}`));
        }
        const second = yield* Effect.forkChild(delivery.deliverNext(run), {
          startImmediately: true,
        });
        yield* pause(20);
        expect(server.permitReads()).toBe(1);

        yield* Deferred.succeed(release, undefined);
        expect(yield* within(Fiber.join(first), "the first delivery")).toEqual(
          expect.objectContaining({ status: "delivered" }),
        );
        expect(yield* within(Fiber.join(second), "the second step")).toEqual({
          status: "empty",
        });
        expect(server.permitReads()).toBe(2);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(
          Layer.provideMerge(Delivery.layer(), SupervisorBus.layer),
        ),
      );
    }),
);

it.effect(
  "a wake for a session inside its uninterruptible step does not stall other sessions",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const server = makeFakeServer([
        makePermit(),
        makePermit({ session: "session-2" }),
      ]);
      const harness = makeTestHarness(server, {
        onDeliver: (req) =>
          req.session === "session-1"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return deliveredFor(req.delivery_id);
              })
            : Effect.succeed(deliveredFor(req.delivery_id)),
      });

      yield* Effect.gen(function* () {
        yield* harness.attach;
        yield* Delivery;
        const settled = yield* watchSettled;
        yield* wake("session-1");
        yield* within(Deferred.await(entered), "session-1 to deliver");
        yield* wake("session-1");
        yield* Effect.yieldNow;
        yield* wake("session-2");
        yield* within(
          settled("session-2", "delivered"),
          "session-2 to settle while session-1 is busy",
        );
        expect(server.head("session-1")?.state).toBe("delivery-started");

        yield* Deferred.succeed(release, undefined);
        yield* within(settled("session-1", "delivered"), "session-1 to settle");
        expect(harness.deliveries).toHaveLength(2);
        expect(
          server.settles.map(({ session, outcome }) => [session, outcome]),
        ).toEqual([
          ["session-2", "applied"],
          ["session-1", "applied"],
        ]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(
          Layer.provideMerge(Delivery.layer(), SupervisorBus.layer),
        ),
      );
    }),
);

it.effect(
  "closing the service layer keeps the bridge until the running step settles",
  () =>
    Effect.gen(function* () {
      const server = makeFakeServer([makePermit()]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const layerScope = yield* Scope.make();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => release.resolve()).pipe(
          Effect.andThen(Scope.close(layerScope, Exit.void)),
        ),
      );
      const context = yield* Layer.buildWithScope(
        deliveryServiceLayer({
          bridge: fakeServerBridge(server, async (request) => {
            entered.resolve();
            await release.promise;
            return deliveredFor(request.delivery_id);
          }),
        }),
        layerScope,
      );
      yield* wake("session-1").pipe(Effect.provide(context));
      yield* within(
        Effect.promise(() => entered.promise),
        "the bridge to deliver",
      );

      const closing = yield* Effect.forkChild(
        Scope.close(layerScope, Exit.void),
        { startImmediately: true },
      );
      yield* Effect.yieldNow;
      release.resolve();
      yield* within(Fiber.await(closing), "the layer to close");
      expect(server.settles).toMatchObject([
        { delivery_id: "delivery-1", outcome: "applied" },
      ]);
      expect(server.head()).toBeUndefined();
    }),
);

it.effect("a bus timeout on an edge call is retried inside the drain", () =>
  Effect.gen(function* () {
    let dropped = 0;
    const server = makeFakeServer([makePermit()]);
    const harness = makeTestHarness(server, {
      dropReply: (message) =>
        message.kind === "edge.permits.next" && dropped++ === 0,
    });

    yield* Effect.gen(function* () {
      yield* harness.attach;
      const delivery = yield* Delivery;
      const drained = yield* Effect.forkChild(delivery.drain(run), {
        startImmediately: true,
      });
      yield* adjust(30_000);
      yield* adjust(1_000);
      const exit = yield* within(Fiber.await(drained), "the drain");
      expect(exit).toEqual(Exit.succeed({ status: "empty" }));
      expect(harness.calls[0]).toBe("dropped:edge.permits.next");
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
);

it.effect(
  "a provider call that outlives its request is cancelled, and its late result settles the delivery",
  () =>
    Effect.gen(function* () {
      const answer = yield* Deferred.make<void>();
      const journal = makeMemoryReceiptJournal();
      const server = makeFakeServer([
        makePermit(),
        makePermit({ delivery_id: "delivery-2", attempt_id: "attempt-2" }),
      ]);
      const harness = makeTestHarness(server, {
        onDeliver: (req) =>
          Deferred.await(answer).pipe(Effect.as(deliveredFor(req.delivery_id))),
      });

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const settled = yield* watchSettled;
        const step = yield* Effect.forkChild(delivery.deliverNext(run), {
          startImmediately: true,
        });
        yield* adjust(30_000);
        expect(yield* within(Fiber.join(step), "the timed out step")).toEqual(
          expect.objectContaining({
            status: "in_doubt",
            code: "provider_timeout",
          }),
        );
        expect(server.head()?.state).toBe("ambiguous");
        expect(
          harness.calls.some((call) =>
            call.startsWith("provider.deliver.cancel:"),
          ),
        ).toBe(true);

        yield* Deferred.succeed(answer, undefined);
        yield* within(
          settled("session-1", "delivered", "delivery-1"),
          "the late result to settle delivery-1",
        );
        expect(server.settles).toMatchObject([
          { delivery_id: "delivery-1", outcome: "in_doubt" },
          {
            delivery_id: "delivery-1",
            outcome: "applied",
            resolution_evidence: JSON.stringify(receiptFor("delivery-1")),
          },
        ]);
        expect(harness.deliveries).toHaveLength(1);
        expect(journal.records.size).toBe(0);
      }).pipe(
        Effect.ensuring(Deferred.succeed(answer, undefined)),
        Effect.provide(
          Layer.provideMerge(
            Delivery.layer({ receiptJournal: journal }),
            SupervisorBus.layer,
          ),
        ),
      );
    }),
);
