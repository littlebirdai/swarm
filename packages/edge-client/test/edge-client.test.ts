import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import { Clock } from "effect/Clock";
import * as Effect from "effect/Effect";
import { join } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import claimFixture from "../../edge-contract/test/fixtures/claim.json";
import heartbeatFixture from "../../edge-contract/test/fixtures/heartbeat.json";
import helloFixture from "../../edge-contract/test/fixtures/hello.json";
import releaseFixture from "../../edge-contract/test/fixtures/release.json";
import renewFixture from "../../edge-contract/test/fixtures/renew.json";
import { EdgeClient } from "../src/effect";
import type { EdgeRequests, EdgeTransport } from "../src";
import { reply, scriptedTransport } from "./scripted-transport";

const claimRequest = {
  ...claimFixture.request,
  v: 1,
} satisfies EdgeRequests["claim"];
const heartbeatRequest = {
  ...heartbeatFixture.request,
  v: 1,
} satisfies EdgeRequests["heartbeat"];
const helloRequest = helloFixture.request;
const grant = {
  ...claimFixture.response,
  v: 1 as const,
  status: "granted" as const,
  expires_at: 1_000,
};
const timing = { maxServerClockLeadMs: 0 };
const stale = { v: 1, status: "stale" };

function withTransport<A, E, R>(
  transport: EdgeTransport,
  run: (client: EdgeClient["Service"]) => Effect.Effect<A, E, R>,
  timeouts = {},
) {
  return Effect.flatMap(EdgeClient, run).pipe(
    Effect.provide(EdgeClient.layer({ transport, ...timeouts })),
  );
}

it.effect(
  "hello forwards capabilities and rejects an unoffered or refused version",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply(helloFixture.response),
        reply({ ...helloFixture.response, version: 2 }),
        reply(helloFixture.response),
        reply({ status: "server_behind", supported_versions: [1] }, 409),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          expect(yield* client.hello(helloRequest)).toEqual({
            ...helloFixture.response,
            status: "ok",
          });
          expect(calls[0]?.request).toEqual(helloRequest);
          expect(
            yield* Effect.flip(
              client.hello({ ...helloRequest, versions: [1, 2] }),
            ),
          ).toMatchObject({
            _tag: "EdgeVersionRejected",
            reason: "unexpected_version",
          });
          expect(
            yield* Effect.flip(
              client.hello({ ...helloRequest, versions: [2] }),
            ),
          ).toMatchObject({
            _tag: "EdgeVersionRejected",
            reason: "unexpected_version",
          });
          expect(
            yield* Effect.flip(
              client.hello({ ...helloRequest, versions: [2] }),
            ),
          ).toMatchObject({
            _tag: "EdgeVersionRejected",
            reason: "server_behind",
            supportedVersions: [1],
          });
        }),
      );
    }),
);

it.effect("retry preserves a claim ID after the kernel loses the answer", () =>
  Effect.gen(function* () {
    const { transport, calls } = scriptedTransport(
      async () => {
        throw new TypeError("connection lost after grant");
      },
      reply({ ...grant, future_response_field: true }),
    );
    yield* withTransport(transport, (client) =>
      Effect.gen(function* () {
        const original = { ...claimRequest };
        const input = { ...original };
        const fiber = yield* Effect.forkChild(client.claim(input), {
          startImmediately: true,
        });
        yield* adjust(99);
        expect(calls).toHaveLength(1);
        input.claim_id = "next-attempt";
        yield* adjust(1);
        expect(yield* join(fiber)).toEqual(grant);
        expect(calls.map((call) => call.request)).toEqual([original, original]);
      }),
    );
  }),
);

it.effect("retry_after_ms delays retries for wire errors and busy claims", () =>
  Effect.gen(function* () {
    const { transport, calls } = scriptedTransport(
      reply(
        {
          v: 1,
          status: "error",
          code: "rate_limited",
          retryable: true,
          retry_after_ms: 550,
        },
        429,
      ),
      reply({ v: 1, status: "busy", retry_after_ms: 650 }),
      reply(grant),
    );
    yield* withTransport(transport, (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.claim(claimRequest), {
          startImmediately: true,
        });
        yield* adjust(549);
        expect(calls).toHaveLength(1);
        yield* adjust(1);
        expect(calls).toHaveLength(2);
        yield* adjust(649);
        expect(calls).toHaveLength(2);
        yield* adjust(1);
        expect(yield* join(fiber)).toEqual(grant);
      }),
    );
  }),
);

it.effect(
  "per-attempt timeout aborts transport and the whole call cuts off retry_after_ms",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        () => new Promise(() => {}),
        reply(
          {
            v: 1,
            status: "error",
            code: "unavailable",
            retryable: true,
            retry_after_ms: 5_000,
          },
          503,
        ),
      );
      yield* withTransport(
        transport,
        (client) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              Effect.flip(client.heartbeat(heartbeatRequest)),
              { startImmediately: true },
            );
            yield* adjust(99);
            expect(calls[0]?.signal.aborted).toBe(false);
            yield* adjust(1);
            expect(calls[0]?.signal.aborted).toBe(true);
            yield* adjust(100);
            expect(calls).toHaveLength(2);
            yield* adjust(300);
            expect(yield* join(fiber)).toMatchObject({
              _tag: "EdgeUnavailable",
              code: "timeout",
            });
            expect(calls).toHaveLength(2);
          }),
        { attemptTimeoutMs: 100, callTimeoutMs: 500 },
      );
    }),
);

it.effect(
  "retry count is bounded and non-retryable failures stop immediately",
  () =>
    Effect.gen(function* () {
      const unavailable = reply(undefined, 503);
      const { transport, calls } = scriptedTransport(
        unavailable,
        unavailable,
        unavailable,
        unavailable,
        reply(
          { v: 1, status: "error", code: "unauthorized", retryable: false },
          401,
        ),
        reply({ v: 1, policy_revision: "wrong" }),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const heartbeat = client.heartbeat(heartbeatRequest);
          const fiber = yield* Effect.forkChild(Effect.flip(heartbeat), {
            startImmediately: true,
          });
          yield* adjust(700);
          expect(yield* join(fiber)).toMatchObject({
            _tag: "EdgeUnavailable",
            code: "http_503",
          });
          expect(calls).toHaveLength(4);
          expect(yield* Effect.flip(heartbeat)).toMatchObject({
            _tag: "EdgeRejected",
            code: "unauthorized",
          });
          expect(yield* Effect.flip(heartbeat)).toMatchObject({
            _tag: "EdgeParseError",
            path: "$.policy_revision",
          });
          expect(calls).toHaveLength(6);
        }),
      );
    }),
);

it.effect(
  "a duplicate scoped claim cannot start work or release the active token",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply(grant),
        reply(releaseFixture.response),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const finish = "done";
          const holder = yield* Effect.forkChild(
            client.withClaim(claimRequest, timing, () =>
              Effect.as(Effect.sleep(10), finish),
            ),
            { startImmediately: true },
          );
          yield* adjust(0);
          expect(
            yield* Effect.flip(
              client.withClaim(
                { ...claimRequest, claim_id: "second-attempt" },
                timing,
                () => Effect.die("duplicate work"),
              ),
            ),
          ).toMatchObject({ _tag: "ClaimLost", reason: "already_held" });
          expect(calls.map(({ operation }) => operation)).toEqual(["claim"]);
          yield* adjust(10);
          expect(yield* join(holder)).toBe(finish);
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "release",
          ]);
        }),
      );
    }),
);

it.effect(
  "a refused renew interrupts work before release with the original fence",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const { transport, calls } = scriptedTransport(
        reply(grant),
        reply(stale, 409),
        async () => {
          events.push("release");
          return { status: 200, body: releaseFixture.response };
        },
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            Effect.flip(
              client.withClaim(claimRequest, timing, () =>
                Effect.andThen(
                  Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      events.push("stopped");
                    }),
                  ),
                  Effect.never,
                ),
              ),
            ),
            { startImmediately: true },
          );
          yield* adjust(500);
          expect(events).toEqual(["stopped", "release"]);
          expect(yield* join(holder)).toMatchObject({
            _tag: "ClaimLost",
            operation: "renew",
            reason: "stale",
          });
          expect(calls.slice(1).map((call) => call.request)).toEqual([
            { ...renewFixture.request, v: 1 as const },
            { ...releaseFixture.request, v: 1 as const },
          ]);
        }),
      );
    }),
);

it.effect(
  "a backward wall-clock jump cannot extend the lease while renew is silent",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply(grant),
        () => new Promise(() => {}),
        reply(releaseFixture.response),
      );
      const clock = yield* Clock;
      let wallOffset = 0;
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            Effect.flip(
              client.withClaim(claimRequest, timing, () => Effect.never),
            ),
            { startImmediately: true },
          );
          yield* adjust(400);
          wallOffset = -300;
          yield* adjust(100);
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "renew",
          ]);
          yield* adjust(499);
          expect(calls[1]?.signal.aborted).toBe(false);
          yield* adjust(1);
          expect(calls[1]?.signal.aborted).toBe(true);
          expect(calls[2]?.operation).toBe("release");
          expect(yield* join(holder)).toMatchObject({
            _tag: "ClaimLost",
            reason: "expired",
          });
        }),
      ).pipe(
        Effect.provideService(Clock, {
          ...clock,
          currentTimeMillis: Effect.map(
            clock.currentTimeMillis,
            (wall) => wall + wallOffset,
          ),
        }),
      );
    }),
);

it.effect(
  "a confirmed renew extends work and a late grant never starts it",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply(grant),
        reply({ ...renewFixture.response, expires_at: 2_000 }),
        reply(releaseFixture.response),
        reply(grant),
        reply(releaseFixture.response),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            client.withClaim(claimRequest, timing, () =>
              Effect.as(Effect.sleep(1_100), "done"),
            ),
            { startImmediately: true },
          );
          yield* adjust(1_100);
          expect(yield* join(running)).toBe("done");
          expect(
            yield* Effect.flip(
              client.withClaim(claimRequest, timing, () =>
                Effect.die("expired work"),
              ),
            ),
          ).toMatchObject({
            _tag: "ClaimLost",
            operation: "claim",
            reason: "expired",
          });
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "renew",
            "release",
            "claim",
            "release",
          ]);
        }),
      );
    }),
);

it.effect("work cannot report success after the lease becomes unprovable", () =>
  Effect.gen(function* () {
    const { transport, calls } = scriptedTransport(
      reply(grant),
      reply(releaseFixture.response),
    );
    const clock = yield* Clock;
    let wallOffset = 0;
    yield* withTransport(transport, (client) =>
      Effect.gen(function* () {
        const holder = yield* Effect.forkChild(
          Effect.flip(
            client.withClaim(claimRequest, timing, () =>
              Effect.as(Effect.sleep(100), "done"),
            ),
          ),
          { startImmediately: true },
        );
        yield* adjust(50);
        wallOffset = 1_000;
        yield* adjust(50);
        expect(yield* join(holder)).toMatchObject({
          _tag: "ClaimLost",
          operation: "claim",
          reason: "expired",
        });
        expect(calls.map(({ operation }) => operation)).toEqual([
          "claim",
          "release",
        ]);
      }),
    ).pipe(
      Effect.provideService(Clock, {
        ...clock,
        currentTimeMillis: Effect.map(
          clock.currentTimeMillis,
          (wall) => wall + wallOffset,
        ),
      }),
    );
  }),
);
