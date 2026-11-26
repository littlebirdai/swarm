import { expect } from "bun:test";
import {
  STEER_BATON_CAPABILITY,
  type DeliveryResolutionRequest,
} from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { join } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import { EdgeTransportError, type EdgeSteerOutcome } from "../src";
import { reply } from "./scripted-transport";
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

const duplicate = { v: 1, status: "duplicate" } as const;
const stale = { v: 1, status: "stale" } as const;

it.effect(
  "a host offer does not enable a steer or fence the server did not negotiate",
  () =>
    Effect.gen(function* () {
      const m = machine();
      yield* connected(
        m.host,
        [reply(steer)],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
              code: "steer_not_negotiated",
            });
            expect(calls.map((call) => call.operation)).toEqual([
              "hello",
              "permits.next",
            ]);
          }),
        { ...helloReply, policy: { ...helloReply.policy, capabilities: [] } },
      );
      yield* connected(
        m.host,
        [reply(fence)],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
              code: "takeover_not_negotiated",
            });
            expect(calls.map((call) => call.operation)).toEqual([
              "hello",
              "permits.next",
            ]);
          }),
        {
          ...helloReply,
          policy: {
            ...helloReply.policy,
            capabilities: [STEER_BATON_CAPABILITY],
          },
        },
      );
      expect(m.journal()).toBeUndefined();
      expect(m.prepared).toEqual([]);
    }),
);

it.effect(
  "a different or absent running turn settles stale without starting the permit",
  () =>
    Effect.gen(function* () {
      for (const current of ["replacement", null]) {
        const m = machine();
        m.turn(current);
        yield* connected(
          m.host,
          [reply(steer), reply(recorded)],
          (client, calls) =>
            Effect.gen(function* () {
              expect(yield* client.deliverNext(run)).toEqual({
                status: "settled",
                outcome: "stale",
                receipt: recorded,
              });
              expect(calls.map((call) => call.operation)).toEqual([
                "hello",
                "permits.next",
                "delivery.settle",
              ]);
              expect(calls.at(-1)?.request).toEqual({
                ...startRequest,
                outcome: "stale",
                observed: { kind: "turn", turn: current },
              });
            }),
        );
        expect(m.prepared).toEqual([]);
        expect(m.journal()).toBeUndefined();
      }
    }),
);

it.effect(
  "a replaced turn after the journal write still settles stale before touching the agent",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const save = m.host.journal.save;
      m.host.journal.save = async (scope, journal, signal) => {
        await save(scope, journal, signal);
        if (journal.handovers.length) m.turn("next-turn");
      };
      yield* connected(
        m.host,
        [reply(steer), reply(started), reply(recorded)],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* client.deliverNext(run)).toMatchObject({
              outcome: "stale",
            });
            expect(calls.at(-1)?.request).toMatchObject({
              observed: { kind: "turn", turn: "next-turn" },
            });
          }),
      );
      expect(m.prepared).toEqual(["attempt"]);
      expect(m.handed).toEqual([]);
      expect(m.journal()?.handovers).toEqual([]);
    }),
);

it.effect(
  "a persisted fence blocks an old start response still preparing for handoff",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const prepare = m.host.prepare;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      m.host.prepare = async (permit, signal) => {
        if (permit.attempt_id === "attempt") {
          entered.resolve();
          await release.promise;
        }
        return prepare(permit, signal);
      };
      const newSteer = {
        ...steer,
        attempt_id: "new-attempt",
        delivery_id: "new-send",
        seq: 3,
        sender: { kind: "person", id: "ben" },
        baton_token: 1,
      };
      yield* connected(
        m.host,
        [
          reply(steer),
          reply(started),
          reply(fence),
          reply(recorded),
          reply(newSteer),
          reply({ ...newSteer, status: "started" }),
          reply(recorded),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            const old = yield* Effect.forkChild(client.deliverNext(run), {
              startImmediately: true,
            });
            yield* Effect.promise(() => entered.promise);
            expect(yield* client.deliverNext(run)).toEqual({
              status: "takeover",
              receipt: recorded,
            });
            expect(m.journal()?.fences).toEqual([
              { ...fence, acknowledged: true },
            ]);
            expect(calls.at(-1)?.request).toEqual({
              ...run,
              fence_id: fence.fence_id,
              turn: fence.turn,
              baton_token: null,
            });
            release.resolve();
            expect(yield* join(old)).toEqual({ status: "fenced" });
            expect(m.handed).toEqual([]);
            expect(yield* client.deliverNext(run)).toMatchObject({
              status: "settled",
              outcome: "applied",
            });
            expect(m.handed).toEqual(["new-attempt"]);
          }),
      );
    }),
);

it.effect(
  "restart keeps a fence blocked until the journaled handover settles",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const handed = Promise.withResolvers<void>();
      const landed = Promise.withResolvers<EdgeSteerOutcome>();
      m.host.prepare = async () => async () => {
        handed.resolve();
        expect(m.journal()?.handovers).toHaveLength(1);
        return landed.promise;
      };
      yield* connected(
        m.host,
        [reply(steer), reply(started), reply(fence), reply(recorded)],
        (client, calls) =>
          Effect.gen(function* () {
            const active = yield* Effect.forkChild(client.deliverNext(run), {
              startImmediately: true,
            });
            try {
              yield* Effect.promise(() => handed.promise);
              expect(yield* client.deliverNext(run)).toEqual({
                status: "pending",
              });
              expect(m.journal()?.fences).toEqual([fence]);
              expect(calls.map((call) => call.operation)).not.toContain(
                "takeover.ack",
              );
            } finally {
              landed.resolve({ outcome: "in_doubt" });
            }
            expect(yield* join(active)).toMatchObject({ outcome: "in_doubt" });
          }),
      );
      expect(m.journal()?.handovers).toHaveLength(1);
      let evidence = false;
      m.host.recover = async () =>
        evidence
          ? {
              outcome: "failed",
              resolution_evidence: "provider journal: no effect",
            }
          : { outcome: "in_doubt" };
      yield* connected(
        m.host,
        [
          reply(fence),
          reply(duplicate),
          reply(fence),
          reply(recorded),
          reply(stale),
          reply(steer),
          reply(fence),
          reply(duplicate),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* client.deliverNext(run)).toEqual({
              status: "pending",
            });
            expect(calls.map((call) => call.operation)).not.toContain(
              "takeover.ack",
            );
            evidence = true;
            expect(yield* client.deliverNext(run)).toEqual({
              status: "takeover",
              receipt: stale,
            });
            const resolved: DeliveryResolutionRequest = {
              ...startRequest,
              outcome: "failed",
              retryable: false,
              resolution_evidence: "provider journal: no effect",
            };
            expect(calls.at(-2)?.request).toEqual(resolved);
            expect(m.journal()).toEqual({ handovers: [], fences: [fence] });
            expect(yield* client.deliverNext(run)).toEqual({
              status: "fenced",
            });
            expect(yield* client.deliverNext(run)).toEqual({
              status: "takeover",
              receipt: duplicate,
            });
            expect(
              calls
                .filter((call) => call.operation === "takeover.ack")
                .map((call) => call.request),
            ).toEqual(
              Array.from({ length: 2 }, () => ({
                ...run,
                fence_id: fence.fence_id,
                turn: fence.turn,
                baton_token: null,
              })),
            );
          }),
      );
    }),
);

it.effect(
  "a lost takeover acknowledgment is retried with the same wire identity",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const firstAck = Promise.withResolvers<void>();
      yield* connected(
        m.host,
        [
          reply(fence),
          async () => {
            expect(m.journal()?.fences).toEqual([fence]);
            firstAck.resolve();
            throw new EdgeTransportError(new Error("lost response"));
          },
          reply(duplicate),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            const work = yield* Effect.forkChild(client.deliverNext(run), {
              startImmediately: true,
            });
            yield* Effect.promise(() => firstAck.promise);
            expect(calls).toHaveLength(3);
            yield* adjust(1_000);
            expect(yield* join(work)).toEqual({
              status: "takeover",
              receipt: duplicate,
            });
            expect(calls[2]?.request).toEqual(calls[3]?.request);
          }),
      );
    }),
);

it.effect(
  "journal write failure prevents both handoff and takeover acknowledgment",
  () =>
    Effect.gen(function* () {
      const m = machine();
      m.host.journal.save = async () => {
        throw new Error("disk unavailable");
      };
      yield* connected(
        m.host,
        [reply(steer), reply(started), reply(fence)],
        (client, calls) =>
          Effect.gen(function* () {
            for (const _ of [1, 2]) {
              expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject(
                { code: "steer_journal_write_failed" },
              );
            }
            expect(calls.map((call) => call.operation)).toEqual([
              "hello",
              "permits.next",
              "delivery.start",
              "permits.next",
            ]);
          }),
      );
      expect(m.handed).toEqual([]);
    }),
);

it.effect(
  "a fence stays closed to a prepared steer when its first durable write fails",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const prepare = m.host.prepare;
      const save = m.host.journal.save;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      m.host.prepare = async (permit, signal) => {
        entered.resolve();
        await release.promise;
        return prepare(permit, signal);
      };
      let diskIsWritable = false;
      m.host.journal.save = async (scope, journal, signal) => {
        if (!diskIsWritable) throw new Error("disk unavailable");
        await save(scope, journal, signal);
      };
      yield* connected(
        m.host,
        [
          reply(steer),
          reply(started),
          reply(fence),
          reply({ ...fence, new_baton_token: 2 }),
          reply(fence),
          reply(recorded),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            const old = yield* Effect.forkChild(client.deliverNext(run), {
              startImmediately: true,
            });
            yield* Effect.promise(() => entered.promise);
            const failed = yield* Effect.flip(client.deliverNext(run));
            expect(failed).toMatchObject({
              code: "steer_journal_write_failed",
            });
            expect(calls.at(-1)?.operation).toBe("permits.next");
            expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
              code: "takeover_fence_conflict",
            });
            diskIsWritable = true;
            release.resolve();
            expect(yield* join(old)).toEqual({ status: "fenced" });
            expect(m.handed).toEqual([]);
            expect(yield* client.deliverNext(run)).toEqual({
              status: "takeover",
              receipt: recorded,
            });
            expect(m.journal()?.fences).toEqual([
              { ...fence, acknowledged: true },
            ]);
          }),
      );
    }),
);

it.effect("a fence for another lease or turn makes no durable change", () =>
  Effect.gen(function* () {
    const m = machine();
    yield* connected(
      m.host,
      [
        reply({ ...fence, fencing_token: "other" }),
        reply({ ...fence, turn: "previous" }),
      ],
      (client, calls) =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
            code: "delivery_lease_mismatch",
          });
          expect(yield* client.deliverNext(run)).toEqual({ status: "fenced" });
          expect(calls).toHaveLength(3);
        }),
    );
    expect(m.journal()).toBeUndefined();
  }),
);

it.effect(
  "a start replay goes to recovery and a mismatched start never reaches the host",
  () =>
    Effect.gen(function* () {
      const m = machine();
      const recovered: string[] = [];
      m.host.recover = async (hand) => {
        recovered.push(hand.attempt_id);
        return { outcome: "applied", resolution_evidence: "provider receipt" };
      };
      yield* connected(
        m.host,
        [
          reply(steer),
          reply({ ...started, attempt_id: "unexpected" }),
          reply(steer),
          reply({ ...started, status: "already_started" }),
          reply(recorded),
        ],
        (client, calls) =>
          Effect.gen(function* () {
            expect(yield* Effect.flip(client.deliverNext(run))).toMatchObject({
              code: "delivery_start_mismatch",
            });
            expect(yield* client.deliverNext(run)).toMatchObject({
              status: "settled",
              outcome: "applied",
            });
            expect(calls.at(-1)?.request).toMatchObject({
              outcome: "applied",
              resolution_evidence: "provider receipt",
            });
          }),
      );
      expect(recovered).toEqual(["attempt"]);
      expect(m.prepared).toEqual([]);
      expect(m.handed).toEqual([]);
    }),
);
