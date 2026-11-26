import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { interrupt, join } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import hello from "../../edge-contract/test/fixtures/hello.json";
import type { EdgeSteerOutcome } from "../src";
import { EdgeClient } from "../src/effect";
import { reply, scriptedTransport } from "./scripted-transport";
import {
  connected,
  fence,
  helloReply,
  machine,
  recorded,
  run,
  started,
  startRequest,
  steer,
} from "./steer-testkit";

it.effect(
  "a conflicting fence cannot block the new holder or poison the real fence replay",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const newHolder = {
        ...steer,
        baton_token: 1,
        sender: { kind: "person", id: "ben" },
      };
      yield* connected(
        m.host,
        [
          reply(fence),
          reply(recorded),
          reply({ ...fence, baton_token: 1, new_baton_token: 2 }),
          reply(newHolder),
          reply({ ...started, sender: newHolder.sender }),
          reply(recorded),
          reply(fence),
          reply(recorded),
        ],
        (client) =>
          Effect.gen(function* () {
            expect(yield* client.deliverNext(run)).toMatchObject({
              status: "takeover",
            });
            expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
              code: "takeover_fence_conflict",
            });
            expect(yield* client.deliverNext(run)).toMatchObject({
              outcome: "applied",
            });
            expect(yield* client.deliverNext(run)).toEqual({
              status: "takeover",
              receipt: recorded,
            });
          }),
      );
      expect(m.handed).toEqual(["attempt"]);
      expect(m.journal()?.fences).toEqual([{ ...fence, acknowledged: true }]);
    }),
);

it.effect(
  "a hello that revokes steering during the journal write leaves no unhanded steer to recover",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const saving = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const save = m.host.journal.save;
      m.host.journal.save = async (scope, state, signal) => {
        if (state.handovers.length) {
          saving.resolve();
          await release.promise;
        }
        await save(scope, state, signal);
      };
      const noSteering = {
        ...helloReply,
        policy: { ...helloReply.policy, capabilities: [] },
      };
      yield* connected(
        m.host,
        [
          reply(steer),
          reply(started),
          reply(noSteering),
          reply(helloReply),
          reply(fence),
          reply(recorded),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            const work = yield* Effect.forkChild(client.deliverNext(run), {
              startImmediately: true,
            });
            try {
              yield* Effect.promise(() => saving.promise);
              yield* client.hello(hello.request);
            } finally {
              release.resolve();
            }
            expect(yield* join(work)).toEqual({ status: "fenced" });
            expect(m.journal()?.handovers).toEqual([]);
            yield* client.hello(hello.request);
            expect(yield* client.deliverNext(run)).toEqual({
              status: "takeover",
              receipt: recorded,
            });
            expect(calls.at(-1)?.operation).toBe("takeover.ack");
          }),
      );
      expect(m.handed).toEqual([]);
    }),
);

it.effect("blank recovery evidence keeps the handover in doubt", () =>
  Effect.gen(function* () {
    const m = machine();
    m.host.recover = async () => ({
      outcome: "applied",
      resolution_evidence: " \t",
    });
    yield* connected(
      m.host,
      [reply({ ...steer, state: "started" }), reply(recorded)],
      (client, calls) =>
        Effect.gen(function* () {
          expect(yield* client.deliverNext(run)).toMatchObject({
            outcome: "in_doubt",
          });
          expect(calls.at(-1)?.request).toEqual({
            ...startRequest,
            outcome: "in_doubt",
          });
        }),
    );
    expect(m.journal()?.handovers).toHaveLength(1);
    expect(m.handed).toEqual([]);
  }),
);

it.effect(
  "a turn change during fence recovery prevents ack of the old turn",
  () =>
    Effect.gen(function* () {
      const m = machine();
      m.host.recover = async () => ({ outcome: "in_doubt" });
      yield* connected(
        m.host,
        [
          reply({ ...steer, state: "started" }),
          reply(recorded),
          reply(fence),
          reply(recorded),
          reply(recorded),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* client.deliverNext(run)).toMatchObject({
              outcome: "in_doubt",
            });
            m.host.recover = async () => {
              m.turn("next-turn");
              return {
                outcome: "applied",
                resolution_evidence: "provider receipt",
              };
            };
            expect(yield* client.deliverNext(run)).toEqual({
              status: "fenced",
            });
            expect(calls.slice(-2).map((call) => call.operation)).toEqual([
              "permits.next",
              "delivery.settle",
            ]);
            expect(calls.at(-1)?.request).toMatchObject({ outcome: "applied" });
          }),
      );
      expect(m.journal()?.handovers).toEqual([]);
    }),
);

it.effect(
  "failed preparation is retryable on the same turn and stale after it changes",
  () =>
    Effect.gen(function* () {
      for (const current of ["turn", "next-turn"]) {
        const m = machine();
        m.host.prepare = async () => {
          m.turn(current);
          throw new Error("blob unavailable");
        };
        const settlement =
          current === "turn"
            ? {
                outcome: "failed",
                retryable: true,
                detail: "steer_preparation_failed",
              }
            : { outcome: "stale", observed: { kind: "turn", turn: current } };
        yield* connected(
          m.host,
          [reply(steer), reply(started), reply(recorded)],
          (client, calls) =>
            Effect.gen(function* () {
              expect(yield* client.deliverNext(run)).toMatchObject({
                outcome: settlement.outcome,
              });
              expect(calls.at(-1)?.request).toEqual({
                ...startRequest,
                ...settlement,
              });
            }),
        );
        expect(m.journal()).toBeUndefined();
      }
    }),
);

it.effect(
  "without a steering host the client passes queue, empty and stale and rejects unsolicited steering",
  () => {
    const queue = {
      ...startRequest,
      status: "permit",
      state: "new",
      intent: "queue",
      input: steer.input,
    } as const;
    const empty = { v: 1, status: "empty" } as const;
    const stale = { v: 1, status: "stale" } as const;
    const { transport, calls } = scriptedTransport(
      reply(helloReply),
      reply(queue),
      reply(empty),
      reply(stale),
      reply(steer),
      reply(fence),
    );
    return Effect.gen(function* () {
      const client = yield* EdgeClient;
      yield* client.hello(hello.request);
      expect(calls[0]?.request).toMatchObject({
        capabilities: ["delivery-permit-v1", "expected"],
      });
      for (const result of [queue, empty, stale])
        expect(yield* client.deliverNext(run)).toEqual(result);
      for (const _ of [steer, fence])
        expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
          code: "steer_not_negotiated",
        });
      expect(calls.slice(1).map((call) => call.operation)).toEqual(
        Array.from({ length: 5 }, () => "permits.next"),
      );
    }).pipe(Effect.provide(EdgeClient.layer({ transport })));
  },
);

it.effect(
  "a throwing agent handoff is settled in doubt with evidence retained",
  () =>
    Effect.gen(function* () {
      const m = machine();
      m.host.prepare = async () => async () => {
        throw new Error("agent disconnected");
      };
      yield* connected(
        m.host,
        [reply(steer), reply(started), reply(recorded)],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* client.deliverNext(run)).toMatchObject({
              outcome: "in_doubt",
            });
            expect(calls.at(-1)?.request).toEqual({
              ...startRequest,
              outcome: "in_doubt",
            });
          }),
      );
      expect(m.journal()?.handovers).toHaveLength(1);
    }),
);

it.effect(
  "interrupting an agent handoff aborts its signal and retains the recovery record",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const handed = Promise.withResolvers<AbortSignal>();
      const landed = Promise.withResolvers<EdgeSteerOutcome>();
      m.host.prepare = async () => async (signal) => {
        signal.addEventListener(
          "abort",
          () => landed.resolve({ outcome: "in_doubt" }),
          { once: true },
        );
        handed.resolve(signal);
        return landed.promise;
      };
      yield* connected(
        m.host,
        [reply(steer), reply(started)],
        (client, calls) =>
          Effect.gen(function* () {
            const active = yield* Effect.forkChild(client.deliverNext(run), {
              startImmediately: true,
            });
            const signal = yield* Effect.promise(() => handed.promise);
            const canceled = yield* Effect.forkChild(interrupt(active), {
              startImmediately: true,
            });
            try {
              yield* adjust(1);
              expect(signal.aborted).toBe(true);
            } finally {
              landed.resolve({ outcome: "in_doubt" });
            }
            yield* join(canceled);
            expect(calls.at(-1)?.operation).toBe("delivery.start");
          }),
      );
      expect(m.journal()?.handovers).toHaveLength(1);
    }),
);
