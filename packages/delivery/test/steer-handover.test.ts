import { expect } from "bun:test";
import { SupervisorBus } from "@codecast/edge-supervisor/effect";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Delivery } from "../src/effect";
import { toHandover } from "../src/journals";
import type { SteerPermit } from "../src/types";
import {
  makeFakeServer,
  makeMemorySteerJournal,
  makeSteerPermit,
  makeTestHarness,
  run,
} from "./fake-edge";

const steerOptions = (journal: ReturnType<typeof makeMemorySteerJournal>) => ({
  steerJournal: journal,
  runningTurn: () => "turn-1",
});

it.effect("a started steer permit records its handover before recovery", () =>
  Effect.gen(function* () {
    const permit = makeSteerPermit({ state: "started" });
    const journal = makeMemorySteerJournal();
    const server = makeFakeServer([permit]);
    const harness = makeTestHarness(server);

    yield* Effect.gen(function* () {
      yield* harness.attach;
      const delivery = yield* Delivery;
      const outcome = yield* delivery.deliverNext(run);
      expect(outcome).toMatchObject({ status: "in_doubt" });
      expect(harness.recoveries).toHaveLength(1);
      expect(harness.deliveries).toHaveLength(0);
      expect(journal.state()?.handovers).toEqual([
        toHandover(permit as SteerPermit),
      ]);
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Delivery.layer(steerOptions(journal)),
          SupervisorBus.layer,
        ),
      ),
    );
  }),
);

it.effect("an already started steer records its handover before recovery", () =>
  Effect.gen(function* () {
    const permit = makeSteerPermit();
    const journal = makeMemorySteerJournal();
    const server = makeFakeServer([permit]);
    const harness = makeTestHarness(server);

    yield* Effect.gen(function* () {
      yield* harness.attach;
      const delivery = yield* Delivery;
      server.startedElsewhere();
      const outcome = yield* delivery.deliverNext(run);
      expect(outcome).toMatchObject({ status: "in_doubt" });
      expect(server.starts).toHaveLength(1);
      expect(harness.recoveries).toHaveLength(1);
      expect(harness.deliveries).toHaveLength(0);
      expect(journal.state()?.handovers).toEqual([
        toHandover(permit as SteerPermit),
      ]);
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Delivery.layer(steerOptions(journal)),
          SupervisorBus.layer,
        ),
      ),
    );
  }),
);

it.effect(
  "a replayed new steer permit that was already handed over is recovered, never resent",
  () =>
    Effect.gen(function* () {
      const permit = makeSteerPermit();
      const journal = makeMemorySteerJournal({
        fences: [],
        handovers: [toHandover(permit as SteerPermit)],
      });
      const server = makeFakeServer([permit]);
      const harness = makeTestHarness(server);

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        yield* delivery.deliverNext(run);
        expect(harness.recoveries).toHaveLength(1);
        expect(server.starts).toHaveLength(0);
        expect(harness.deliveries).toHaveLength(0);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Delivery.layer(steerOptions(journal)),
            SupervisorBus.layer,
          ),
        ),
      );
    }),
);
