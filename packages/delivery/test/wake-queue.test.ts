import { expect } from "bun:test";
import {
  SupervisorBus,
  type ProviderDeliverOutcome,
} from "@codecast/edge-supervisor/effect";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Delivery } from "../src/effect";
import type { DeliveryOptions } from "../src/types";
import {
  makeFakeServer,
  makeMemoryReceiptJournal,
  makePermit,
  makeTestHarness,
  pause,
  runFor,
  watchSettled,
  within,
  type FakeServer,
} from "./fake-edge";

const deliveredFor = (deliveryId: string): ProviderDeliverOutcome => ({
  status: "delivered",
  receipt: {
    delivery_id: deliveryId,
    provider_item_id: `item-${deliveryId}`,
    turn: "turn-1",
  },
});

const inDoubt: ProviderDeliverOutcome = {
  status: "in_doubt",
  reason: "unknown",
  code: "rpc_timeout",
  message: "Turn start timed out",
};

const wake = (
  session: string,
  run = 1,
  sendNew?: boolean,
): Effect.Effect<void, unknown, SupervisorBus> =>
  Effect.flatMap(SupervisorBus, (bus) =>
    bus.publish({
      kind: "delivery.wake",
      session,
      run,
      fencing_token: `lease-${run}`,
      ...(sendNew === undefined ? {} : { send_new: sendNew }),
    }),
  );

const receiptFor = (session: string) =>
  Effect.flatMap(SupervisorBus, (bus) =>
    bus.publish({
      kind: "provider.receipt",
      session,
      run: 1,
      delivery_id: "delivery-1",
      provider_item_id: `late-${session}`,
      turn: "turn-2",
    }),
  );

const untilTrue = (check: () => boolean, what: string, ms = 5_000) =>
  within(Effect.repeat(Effect.sleep(1), { until: check }), what, ms);

const settledAll = (server: FakeServer, session: string) =>
  untilTrue(() => !server.head(session), `${session} to settle`, 10_000);

function provideDelivery(options: DeliveryOptions) {
  return Effect.provide(
    Layer.provideMerge(Delivery.layer(options), SupervisorBus.layer),
  );
}

function blockingHarness(server: FakeServer, release: Deferred.Deferred<void>) {
  const entered = new Set<string>();
  const harness = makeTestHarness(server, {
    onDeliver: (req) =>
      req.session === "live" || req.session.startsWith("stale-")
        ? Effect.succeed(inDoubt)
        : Effect.sync(() => entered.add(req.session)).pipe(
            Effect.andThen(
              req.session.startsWith("blocked")
                ? Deferred.await(release)
                : Effect.void,
            ),
            Effect.as(deliveredFor(req.delivery_id)),
          ),
  });
  return { harness, entered };
}

function fillTheQueue() {
  return Effect.gen(function* () {
    for (let index = 0; index < 1_024; index++) {
      yield* wake(`queued-${index}`);
    }
  });
}

for (const clearing of ["stop", "settle"] as const) {
  it.effect(
    `receipt wakes cleared by ${clearing} never push a live refused receipt wake out`,
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const stale = Array.from({ length: 1_024 }, (_, i) => `stale-${i}`);
        const server = makeFakeServer([
          makePermit({ session: "live" }),
          ...stale.map((session) => makePermit({ session })),
          makePermit({ session: "blocked" }),
        ]);
        const { harness, entered } = blockingHarness(server, release);
        const logs: string[] = [];

        yield* Effect.gen(function* () {
          yield* harness.attach;
          const delivery = yield* Delivery;
          const bus = yield* SupervisorBus;
          yield* delivery.deliverNext(runFor("live"));
          yield* wake("blocked");
          yield* untilTrue(() => entered.has("blocked"), "the busy drain");
          yield* fillTheQueue();
          yield* receiptFor("live");
          yield* untilTrue(
            () =>
              logs.includes("[delivery] wake dropped for live: too many wakes"),
            "the live receipt wake to be refused",
          );
          for (const session of stale) {
            yield* delivery.deliverNext(runFor(session));
            yield* receiptFor(session);
            yield* untilTrue(
              () =>
                logs.includes(
                  `[delivery] wake dropped for ${session}: too many wakes`,
                ),
              `the ${session} receipt wake to be refused`,
            );
            if (clearing === "stop") {
              yield* bus.publish({ kind: "delivery.stop", session });
            } else {
              yield* delivery.deliverNext(runFor(session));
            }
          }
          yield* Deferred.succeed(release, undefined);
          yield* settledAll(server, "live");
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          provideDelivery({
            maxActiveDrains: 1,
            receiptJournal: makeMemoryReceiptJournal(),
            log: (line) => logs.push(line),
          }),
        );
      }),
    30_000,
  );
}

it.effect(
  "stopping a queued session gives its queue room to a refused receipt wake",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const server = makeFakeServer([
        makePermit({ session: "live" }),
        makePermit({ session: "blocked" }),
        makePermit({ session: "extra" }),
      ]);
      const { harness, entered } = blockingHarness(server, release);
      const logs: string[] = [];

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const bus = yield* SupervisorBus;
        yield* delivery.deliverNext(runFor("live"));
        yield* wake("blocked");
        yield* untilTrue(() => entered.has("blocked"), "the busy drain");
        yield* fillTheQueue();
        yield* receiptFor("live");
        yield* untilTrue(
          () =>
            logs.includes("[delivery] wake dropped for live: too many wakes"),
          "the live receipt wake to be refused",
        );
        yield* bus.publish({ kind: "delivery.stop", session: "queued-0" });
        yield* pause(20);
        yield* wake("extra");
        yield* pause(20);
        expect(logs).toContain(
          "[delivery] wake dropped for extra: too many wakes",
        );
        yield* Deferred.succeed(release, undefined);
        yield* settledAll(server, "live");
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        provideDelivery({ maxActiveDrains: 1, log: (line) => logs.push(line) }),
      );
    }),
  30_000,
);

it.effect(
  "a late wake for an older run never replaces a queued newer run",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const server = makeFakeServer([
        makePermit({ session: "blocked" }),
        makePermit({ session: "session-2", run: 2, fencing_token: "lease-2" }),
      ]);
      const { harness, entered } = blockingHarness(server, release);

      yield* Effect.gen(function* () {
        yield* harness.attach;
        yield* Delivery;
        const settled = yield* watchSettled;
        yield* wake("blocked");
        yield* untilTrue(() => entered.has("blocked"), "the busy drain");
        yield* wake("session-2", 2);
        yield* wake("session-2", 1);
        yield* Deferred.succeed(release, undefined);
        yield* within(
          settled("session-2", "delivered"),
          "session-2 to deliver on its newer lease",
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        provideDelivery({ maxActiveDrains: 1 }),
      );
    }),
);

for (const late of [
  { label: "a wake for an older run", run: 1, sendNew: undefined },
  { label: "a wake that does not send", run: 2, sendNew: false },
] as const) {
  it.effect(
    `${late.label} does not stop a running drain from sending its next message`,
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const server = makeFakeServer([
          makePermit({
            session: "blocked-1",
            run: 2,
            fencing_token: "lease-2",
          }),
          makePermit({
            session: "blocked-1",
            run: 2,
            fencing_token: "lease-2",
            delivery_id: "delivery-2",
            attempt_id: "attempt-2",
          }),
        ]);
        const { harness, entered } = blockingHarness(server, release);

        yield* Effect.gen(function* () {
          yield* harness.attach;
          yield* Delivery;
          yield* wake("blocked-1", 2);
          yield* untilTrue(
            () => entered.has("blocked-1"),
            "the first delivery",
          );
          yield* wake("blocked-1", late.run, late.sendNew);
          yield* pause(10);
          yield* Deferred.succeed(release, undefined);
          yield* settledAll(server, "blocked-1");
          expect(
            harness.deliveries.map(({ delivery_id }) => delivery_id),
          ).toEqual(["delivery-1", "delivery-2"]);
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          provideDelivery({}),
        );
      }),
  );
}
