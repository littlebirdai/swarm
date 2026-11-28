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
        server.startedElsewhere();
        const outcome = yield* delivery.deliverNext(run);
        expect(outcome).toMatchObject({
          status: "in_doubt",
          attempt_id: "attempt-1",
          receipt_status: "recorded",
        });
        expect(server.head()?.state).toBe("ambiguous");
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

const fence = {
  v: 1 as const,
  status: "takeover_fence" as const,
  session: "session-1",
  run: 1,
  fencing_token: "lease-1",
  fence_id: "fence-1",
  turn: "turn-1",
  baton_token: null,
  new_baton_token: 1,
};

it.effect(
  "a takeover waits while its covered handover settlement is busy",
  () =>
    Effect.gen(function* () {
      const permit = makeSteerPermit({ state: "started" });
      const journal = makeMemorySteerJournal({
        fences: [],
        handovers: [toHandover(permit as SteerPermit)],
      });
      const server = makeFakeServer([permit]);
      server.fenceTakeover(fence);
      let busy = true;
      const harness = makeTestHarness(server, {
        onRecover: (req) =>
          Effect.succeed({
            status: "delivered",
            receipt: {
              delivery_id: req.delivery_id,
              provider_item_id: "item-1",
              turn: "turn-1",
            },
          }),
        settleFailure: () =>
          busy
            ? {
                ok: false,
                retryable: true,
                code: "delivery_bridge_busy",
                retry_after_ms: 250,
              }
            : undefined,
      });

      yield* Effect.gen(function* () {
        yield* harness.attach;
        const delivery = yield* Delivery;
        const outcome = yield* delivery.deliverNext(run);
        expect(outcome).toMatchObject({
          status: "retry_scheduled",
          code: "delivery_bridge_busy",
        });
        expect(server.acks).toHaveLength(0);

        busy = false;
        const next = yield* delivery.deliverNext(run);
        expect(next).toMatchObject({
          status: "takeover",
          receipt: { status: "recorded" },
        });
        expect(server.settles).toMatchObject([
          { attempt_id: "attempt-1", outcome: "applied" },
        ]);
        expect(server.acks).toHaveLength(1);
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

it.effect("a stale takeover acknowledgement is pending, not a takeover", () =>
  Effect.gen(function* () {
    const journal = makeMemorySteerJournal();
    const server = makeFakeServer([makeSteerPermit({ state: "started" })]);
    server.fenceTakeover(fence);
    const harness = makeTestHarness(server);

    yield* Effect.gen(function* () {
      yield* harness.attach;
      const delivery = yield* Delivery;
      const outcome = yield* delivery.deliverNext(run);
      expect(outcome).toEqual({ status: "pending" });
      expect(server.acks).toHaveLength(1);
      expect(journal.state()?.fences.some((item) => item.acknowledged)).toBe(
        false,
      );
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
