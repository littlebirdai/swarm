import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { join, type Fiber } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import traces from "../../../tests/models/fixtures/lease-traces.json";
import { modelOnlyActions } from "../../../tests/models/trace-cases";
import claimFixture from "../../edge-contract/test/fixtures/claim.json";
import { EdgeClient, type EdgeError } from "../src/effect";
import type { EdgeRequests, EdgeTransport } from "../src";
import { reply, type Step } from "./scripted-transport";

type Worker = "w1" | "w2";
type State = typeof traces.complete.initial;
type Client = EdgeClient["Service"];
const workers: Worker[] = ["w1", "w2"];
const duration = 1_000;
const stopAt = 900;
const wire = { v: 1, session: claimFixture.request.session, run: 3 } as const;
const fence = (token: number) => ({ ...wire, fencing_token: `token-${token}` });
const stale = { v: 1, status: "stale" };
const renewed = { v: 1, status: "renewed", lease_ms: duration } as const;

type Holder = {
  stop: Deferred.Deferred<void>;
  fiber: Fiber<void, EdgeError>;
};

for (const [name, trace] of Object.entries(traces)) {
  it.effect(`Lease/${name}`, () =>
    Effect.gen(function* () {
      const active = new Map<Worker, string>();
      const holders = new Map<Worker, Holder>();
      const clients = new Map<Worker, Client>();
      const script: Step[] = [];
      const exchanges: Parameters<Step>[0][] = [];
      const transportFailures: unknown[] = [];
      const transport: EdgeTransport = (operation, request, signal) => {
        const exchange = { operation, request, signal };
        exchanges.push(exchange);
        try {
          const step = script.shift();
          if (!step) throw new Error(`Unexpected ${operation}`);
          return step(exchange);
        } catch (error) {
          transportFailures.push(error);
          throw error;
        }
      };
      for (const worker of workers) {
        clients.set(
          worker,
          yield* EdgeClient.pipe(
            Effect.provide(
              EdgeClient.layer({ transport, attemptTimeoutMs: 2_000 }),
            ),
          ),
        );
      }

      const queue = (
        operation: keyof EdgeRequests,
        request: EdgeRequests[keyof EdgeRequests],
        response: Step,
      ) => {
        script.push((exchange) => {
          expect(exchange.operation).toBe(operation);
          expect(exchange.request).toEqual(request);
          return response(exchange);
        });
      };
      const release = (worker: Worker, token: number, expired = false) => {
        queue("release", fence(token), (exchange) => {
          expect(active.has(worker)).toBe(false);
          return expired
            ? reply(stale, 409)(exchange)
            : reply({ v: 1, status: "released" })(exchange);
        });
      };
      const stop = (worker: Worker, token: number) =>
        Effect.gen(function* () {
          const holder = holders.get(worker);
          if (!holder) return;
          if (!holder.fiber.pollUnsafe()) {
            release(worker, token);
            yield* Deferred.succeed(holder.stop, undefined);
            yield* adjust(0);
            expect(holder.fiber.pollUnsafe()).toBeDefined();
            yield* join(holder.fiber);
          }
          holders.delete(worker);
        });

      const transitions = {
        Claim: (before: State, after: State, worker: Worker) =>
          Effect.gen(function* () {
            const request = {
              ...claimFixture.request,
              v: 1 as const,
              machine: worker,
              claim_id: `claim-${after.token}`,
            };
            queue(
              "claim",
              request,
              reply({
                ...claimFixture.response,
                ...fence(after.token),
                lease_ms: duration,
              }),
            );
            const done = yield* Deferred.make<void>();
            const client = clients.get(worker)!;
            const fiber = yield* Effect.forkChild(
              client.withClaim(request, ({ fencing_token }) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    active.set(worker, fencing_token);
                  }),
                  () =>
                    Effect.sync(() => {
                      active.delete(worker);
                    }),
                ).pipe(Effect.andThen(Deferred.await(done))),
              ),
              { startImmediately: true },
            );
            holders.set(worker, { fiber, stop: done });
            yield* adjust(0);

            const former = workers.find(
              (candidate) =>
                candidate !== worker && before.mine[candidate] !== 0,
            );
            if (former) {
              const oldFence = fence(before.mine[former]);
              queue("renew", oldFence, reply(stale, 409));
              const rejected = yield* Effect.result(
                clients.get(former)!.renew(oldFence),
              );
              expect(rejected).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "ClaimLost", reason: "stale" },
              });
            }
          }),
        LeaseRunsOut: (before: State, _after: State, worker: Worker) =>
          Effect.gen(function* () {
            const holder = holders.get(worker)!;
            const exchangeIndex = exchanges.length;
            queue("renew", fence(before.token), () => new Promise(() => {}));
            release(worker, before.token, true);

            yield* adjust(stopAt - 1);
            expect(active.get(worker)).toBe(fence(before.token).fencing_token);
            const pendingRenew = exchanges[exchangeIndex];
            expect(pendingRenew?.operation).toBe("renew");
            expect(pendingRenew?.signal.aborted).toBe(false);
            yield* adjust(1);
            expect(pendingRenew?.signal.aborted).toBe(true);
            expect(active.has(worker)).toBe(false);
            expect(holder.fiber.pollUnsafe()).toBeDefined();
            const stopped = yield* Effect.result(join(holder.fiber));
            expect(stopped).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "ClaimLost", reason: "expired" },
            });
            yield* adjust(duration - stopAt);
          }),
        Renew: (before: State, _after: State, worker: Worker) =>
          Effect.gen(function* () {
            queue("renew", fence(before.token), reply(renewed));
            expect(
              yield* clients.get(worker)!.renew(fence(before.token)),
            ).toEqual(renewed);
            expect(holders.get(worker)?.fiber.pollUnsafe()).toBeDefined();
          }),
        Complete: (before: State, _after: State, worker: Worker) =>
          stop(worker, before.mine[worker]),
        GiveBack: (before: State, _after: State, worker: Worker) =>
          stop(worker, before.mine[worker]),
        Finished: () => Effect.void,
        OutOfTokens: () => Effect.void,
      };

      let before = trace.initial;
      expect([...active]).toEqual([]);
      for (const { action, state } of trace.steps) {
        yield* Effect.gen(function* () {
          const handler = transitions[action as keyof typeof transitions];
          expect(handler).toBeDefined();
          const worker =
            workers.find(
              (candidate) => before.mine[candidate] !== state.mine[candidate],
            ) ??
            workers.find(
              (candidate) =>
                before.mine[candidate] === before.token && before.token !== 0,
            ) ??
            "w1";
          const exchangeCount = exchanges.length;
          const shouldDriveCode =
            !modelOnlyActions.Lease.includes(action) &&
            (action !== "Complete" ||
              (before.live && before.mine[worker] === before.token));
          yield* handler(before, state, worker);
          expect(transportFailures).toEqual([]);
          expect(exchanges.length > exchangeCount, action).toBe(
            shouldDriveCode,
          );
          const modelWorker = workers.find(
            (candidate) =>
              state.live &&
              state.item === "held" &&
              state.mine[candidate] === state.token,
          );
          const expected: [Worker, string][] =
            modelWorker && action !== "Renew"
              ? [[modelWorker, fence(state.token).fencing_token]]
              : [];
          expect([...active]).toEqual(expected);
          expect(script).toHaveLength(0);
        }).pipe(Effect.withSpan(action));
        before = state;
      }
      for (const worker of holders.keys()) {
        yield* stop(worker, before.mine[worker]);
      }
      expect([...active]).toEqual([]);
      expect(script).toHaveLength(0);
      expect(transportFailures).toEqual([]);
    }),
  );
}
