import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import { findDefect } from "effect/Cause";
import { Clock } from "effect/Clock";
import * as Effect from "effect/Effect";
import { join } from "effect/Fiber";
import { Random } from "effect/Random";
import { adjust, setTime } from "effect/testing/TestClock";
import claimFixture from "../../edge-contract/test/fixtures/claim.json";
import heartbeatFixture from "../../edge-contract/test/fixtures/heartbeat.json";
import helloFixture from "../../edge-contract/test/fixtures/hello.json";
import releaseFixture from "../../edge-contract/test/fixtures/release.json";
import renewFixture from "../../edge-contract/test/fixtures/renew.json";
import { EdgeClient } from "../src/effect";
import {
  EdgeTransportError,
  type EdgeRequests,
  type EdgeTransport,
} from "../src";
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
  lease_ms: 1_000,
};
const renewReply = { ...renewFixture.response, lease_ms: 1_000 };
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

it.effect(
  "retry preserves the claim ID and adds jitter after a lost answer",
  () =>
    Effect.gen(function* () {
      const cause = new TypeError("connection lost after grant");
      const { transport, calls } = scriptedTransport(
        async () => {
          throw new EdgeTransportError(cause);
        },
        reply({ ...grant, future_response_field: true }),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const input = { ...claimRequest };
          const fiber = yield* Effect.forkChild(client.claim(input), {
            startImmediately: true,
          });
          yield* adjust(139);
          expect(calls).toHaveLength(1);
          input.claim_id = "next-attempt";
          yield* adjust(1);
          expect(calls).toHaveLength(2);
          expect(yield* join(fiber)).toEqual(grant);
          expect(calls.map((call) => call.request)).toEqual([
            claimRequest,
            claimRequest,
          ]);
        }),
      ).pipe(
        Effect.provideService(Random, {
          nextIntUnsafe: () => 0,
          nextDoubleUnsafe: () => 0.8,
        }),
      );
    }),
);

it.effect(
  "busy on 429 keeps its hint and a body hint overrides the HTTP header",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply({ v: 1, status: "busy", retry_after_ms: 550 }, 429),
        reply(
          {
            v: 1,
            status: "error",
            code: "rate_limited",
            retryable: true,
            retry_after_ms: 650,
          },
          429,
          "20",
        ),
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
  "HTTP Retry-After seconds and dates survive an exhausted call budget",
  () =>
    Effect.gen(function* () {
      yield* setTime(10_000);
      const { transport, calls } = scriptedTransport(
        reply(undefined, 503, "5"),
        reply(
          { v: 1, status: "error", code: "rate_limited", retryable: true },
          429,
          new Date(13_000).toUTCString(),
        ),
        reply({ v: 1, status: "busy", retry_after_ms: 4_000 }, 503),
      );
      yield* withTransport(
        transport,
        (client) =>
          Effect.gen(function* () {
            const claim = client.claim(claimRequest);
            for (const [code, retry_after_ms] of [
              ["http_503", 5_000],
              ["rate_limited", 3_000],
              ["busy", 4_000],
            ]) {
              const fiber = yield* Effect.forkChild(Effect.flip(claim), {
                startImmediately: true,
              });
              yield* adjust(0);
              expect(fiber.pollUnsafe()).toBeDefined();
              expect(yield* join(fiber)).toMatchObject({
                _tag: "EdgeUnavailable",
                code,
                retry_after_ms,
              });
            }
            expect(calls).toHaveLength(3);
          }),
        { callTimeoutMs: 500 },
      );
    }),
);

it.effect(
  "heartbeat sends once while claims have bounded retries and attempt timeouts",
  () =>
    Effect.gen(function* () {
      const failed = reply(undefined, 503);
      const { transport, calls } = scriptedTransport(
        failed,
        () => new Promise(() => {}),
        failed,
        failed,
        failed,
        reply(heartbeatFixture.response),
      );
      yield* withTransport(
        transport,
        (client) =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(client.heartbeat(heartbeatRequest)),
            ).toMatchObject({ code: "http_503" });
            expect(calls).toHaveLength(1);
            const claim = yield* Effect.forkChild(
              Effect.flip(client.claim(claimRequest)),
              { startImmediately: true },
            );
            yield* adjust(99);
            expect(calls[1]?.signal.aborted).toBe(false);
            yield* adjust(1);
            expect(calls[1]?.signal.aborted).toBe(true);
            yield* adjust(1_100);
            expect(yield* join(claim)).toMatchObject({ code: "http_503" });
            expect(calls.map(({ operation }) => operation)).toEqual([
              "heartbeat",
              "claim",
              "claim",
              "claim",
              "claim",
            ]);
            expect(yield* client.heartbeat(heartbeatRequest)).toEqual({
              ...heartbeatFixture.response,
              v: 1,
            });
          }),
        { attemptTimeoutMs: 100 },
      );
    }),
);

it.effect(
  "only declared transport failures are retryable and retain their cause",
  () =>
    Effect.gen(function* () {
      const cause = new TypeError("socket reset");
      const bug = new TypeError("programming defect");
      const { transport, calls } = scriptedTransport(
        async () => {
          throw new EdgeTransportError(cause);
        },
        async () => {
          throw bug;
        },
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const failing = yield* Effect.flip(
            client.heartbeat(heartbeatRequest),
          );
          expect(failing).toMatchObject({
            _tag: "EdgeUnavailable",
            code: "network",
          });
          expect(failing.cause).toBe(cause);
          const exit = yield* Effect.exit(client.claim(claimRequest));
          expect(
            exit._tag === "Failure" && findDefect(exit.cause),
          ).toMatchObject({ _tag: "Success", success: bug });
          expect(calls).toHaveLength(2);
        }),
      );
    }),
);

it.effect(
  "scoped claim rejects stale and mismatched grants without starting work",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply(stale, 409),
        reply({ ...grant, session: "wrong" }),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const held = client.withClaim(claimRequest, () =>
            Effect.die("unexpected work"),
          );
          expect(yield* Effect.flip(held)).toMatchObject({
            _tag: "ClaimLost",
            reason: "stale",
          });
          expect(yield* Effect.flip(held)).toMatchObject({
            _tag: "EdgeParseError",
            path: "$.session",
          });
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "claim",
          ]);
        }),
      );
    }),
);

it.effect(
  "the claim clock starts before the successful attempt and leaves a stop margin",
  () =>
    Effect.gen(function* () {
      yield* setTime(60_000);
      const answer = Promise.withResolvers<{ status: number; body: unknown }>();
      const { transport, calls } = scriptedTransport(
        () => answer.promise,
        reply(releaseFixture.response),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            Effect.flip(
              client.withClaim(claimRequest, () =>
                Effect.die("late claim began work"),
              ),
            ),
            { startImmediately: true },
          );
          yield* adjust(900);
          answer.resolve({ status: 200, body: grant });
          yield* adjust(0);
          expect(holder.pollUnsafe()).toBeDefined();
          expect(yield* join(holder)).toMatchObject({
            reason: "expired",
            operation: "claim",
          });
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "release",
          ]);
        }),
      );
    }),
);

it.effect(
  "a lost claim answer uses the start of the retry, not the first attempt",
  () =>
    Effect.gen(function* () {
      const { transport } = scriptedTransport(
        reply({ v: 1, status: "busy", retry_after_ms: 950 }, 429),
        reply(grant),
        reply(releaseFixture.response),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            client.withClaim(claimRequest, () => Effect.succeed("ran")),
            { startImmediately: true },
          );
          yield* adjust(950);
          expect(yield* join(holder)).toBe("ran");
        }),
      );
    }),
);

it.effect(
  "a suspended machine uses wall elapsed time and stops before the next renew",
  () =>
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
            Effect.flip(client.withClaim(claimRequest, () => Effect.never)),
            { startImmediately: true },
          );
          yield* adjust(400);
          wallOffset = 600;
          yield* adjust(50);
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "release",
          ]);
          expect(yield* join(holder)).toMatchObject({
            reason: "expired",
            operation: "renew",
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
  "a backward wall jump cannot extend work past the renewal stop margin",
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
            Effect.flip(client.withClaim(claimRequest, () => Effect.never)),
            { startImmediately: true },
          );
          yield* adjust(400);
          wallOffset = -300;
          yield* adjust(499);
          expect(calls[1]?.operation).toBe("renew");
          expect(calls[1]?.signal.aborted).toBe(false);
          yield* adjust(1);
          expect(calls[1]?.signal.aborted).toBe(true);
          expect(yield* join(holder)).toMatchObject({
            reason: "expired",
            operation: "renew",
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
  "a renew response cannot revive work after its own lease expires in flight",
  () =>
    Effect.gen(function* () {
      const answer = Promise.withResolvers<{ status: number; body: unknown }>();
      const { transport, calls } = scriptedTransport(
        reply(grant),
        () => answer.promise,
        reply(releaseFixture.response),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            Effect.flip(client.withClaim(claimRequest, () => Effect.never)),
            { startImmediately: true },
          );
          yield* adjust(550);
          expect(calls[1]?.operation).toBe("renew");
          answer.resolve({
            status: 200,
            body: { ...renewReply, lease_ms: 100 },
          });
          yield* adjust(0);
          expect(calls[2]?.operation).toBe("release");
          expect(yield* join(holder)).toMatchObject({
            reason: "expired",
            operation: "renew",
          });
        }),
      );
    }),
);

const wireRefusal = {
  v: 1,
  status: "error",
  code: "unauthorized",
  retryable: false,
};
for (const [body, status, tag] of [
  [stale, 503, "ClaimLost"],
  [wireRefusal, 403, "EdgeRejected"],
  [{ v: 1, status: "renewed", lease_ms: "bad" }, 200, "EdgeParseError"],
  [
    {
      v: 1,
      status: "error",
      code: "busy",
      retryable: true,
      retry_after_ms: 1_000,
    },
    503,
    "EdgeUnavailable",
  ],
] as const) {
  it.effect(
    `scoped renewal handles ${tag} and releases only if it still has the token`,
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const { transport, calls } = scriptedTransport(
          reply(grant),
          reply(body, status),
          async () => {
            events.push("release");
            return { status: 200, body: releaseFixture.response };
          },
        );
        yield* withTransport(transport, (client) =>
          Effect.gen(function* () {
            const holder = yield* Effect.forkChild(
              Effect.flip(
                client.withClaim(claimRequest, () =>
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
            yield* adjust(450);
            expect(events).toEqual(
              tag === "ClaimLost" ? ["stopped"] : ["stopped", "release"],
            );
            const failure = yield* join(holder);
            expect(failure).toMatchObject({
              _tag: "ClaimLost",
              operation: "renew",
              reason: tag === "ClaimLost" ? "stale" : "unconfirmed",
            });
            if (tag !== "ClaimLost")
              expect(failure.cause).toMatchObject({ _tag: tag });
            expect(calls[1]?.request).toEqual({
              ...renewFixture.request,
              v: 1,
            });
          }),
        );
      }),
  );
}

it.effect(
  "transient renew retries within the margin, confirms a second cycle, then expires",
  () =>
    Effect.gen(function* () {
      const { transport, calls } = scriptedTransport(
        reply(grant),
        reply(undefined, 503, "0"),
        reply(renewReply),
        reply(renewReply),
        () => new Promise(() => {}),
        reply(releaseFixture.response),
      );
      yield* withTransport(
        transport,
        (client) =>
          Effect.gen(function* () {
            const holder = yield* Effect.forkChild(
              Effect.flip(client.withClaim(claimRequest, () => Effect.never)),
              { startImmediately: true },
            );
            yield* adjust(549);
            expect(calls).toHaveLength(2);
            yield* adjust(1);
            expect(calls).toHaveLength(3);
            yield* adjust(450);
            expect(calls).toHaveLength(4);
            yield* adjust(899);
            expect(calls).toHaveLength(5);
            expect(calls[4]?.signal.aborted).toBe(false);
            yield* adjust(1);
            expect(calls[4]?.signal.aborted).toBe(true);
            expect(yield* join(holder)).toMatchObject({
              reason: "expired",
              operation: "renew",
            });
            expect(calls[5]?.request).toEqual({
              ...releaseFixture.request,
              v: 1,
            });
          }),
        { attemptTimeoutMs: 2_000 },
      ).pipe(
        Effect.provideService(Random, {
          nextIntUnsafe: () => 0,
          nextDoubleUnsafe: () => 0,
        }),
      );
    }),
);

it.effect("short leases do not spin and cleanup has one short attempt", () =>
  Effect.gen(function* () {
    const { transport, calls } = scriptedTransport(
      reply({ ...grant, lease_ms: 20 }),
      () => new Promise(() => {}),
    );
    yield* withTransport(transport, (client) =>
      Effect.gen(function* () {
        const holder = yield* Effect.forkChild(
          Effect.flip(client.withClaim(claimRequest, () => Effect.never)),
          { startImmediately: true },
        );
        yield* adjust(17);
        expect(calls).toHaveLength(1);
        yield* adjust(1);
        expect(calls.map(({ operation }) => operation)).toEqual([
          "claim",
          "release",
        ]);
        yield* adjust(249);
        expect(calls[1]?.signal.aborted).toBe(false);
        yield* adjust(1);
        expect(calls[1]?.signal.aborted).toBe(true);
        expect(holder.pollUnsafe()).toBeDefined();
        expect(yield* join(holder)).toMatchObject({ reason: "expired" });
        expect(calls).toHaveLength(2);
      }),
    );
  }),
);

it.effect(
  "scoped renewal still retries after four transient failures when time remains",
  () =>
    Effect.gen(function* () {
      const unavailable = reply(undefined, 503);
      const { transport, calls } = scriptedTransport(
        reply({ ...grant, lease_ms: 20_000 }),
        unavailable,
        unavailable,
        unavailable,
        unavailable,
        reply({ ...renewReply, lease_ms: 20_000 }),
        reply(releaseFixture.response),
      );
      yield* withTransport(transport, (client) =>
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            client.withClaim(claimRequest, () =>
              Effect.as(Effect.sleep(11_500), "finished"),
            ),
            { startImmediately: true },
          );
          yield* adjust(11_500);
          expect(calls.map(({ operation }) => operation)).toEqual([
            "claim",
            "renew",
            "renew",
            "renew",
            "renew",
            "renew",
            "release",
          ]);
          expect(yield* join(holder)).toBe("finished");
        }),
      ).pipe(
        Effect.provideService(Random, {
          nextIntUnsafe: () => 0,
          nextDoubleUnsafe: () => 0,
        }),
      );
    }),
);

it.effect("a retryable cleanup release failure makes no second attempt", () =>
  Effect.gen(function* () {
    const { transport, calls } = scriptedTransport(
      reply(grant),
      reply(undefined, 503),
      reply(releaseFixture.response),
    );
    yield* withTransport(transport, (client) =>
      Effect.gen(function* () {
        const holder = yield* Effect.forkChild(
          client.withClaim(claimRequest, () => Effect.succeed("finished")),
          { startImmediately: true },
        );
        yield* adjust(0);
        expect(holder.pollUnsafe()).toBeDefined();
        expect(yield* join(holder)).toBe("finished");
        yield* adjust(250);
        expect(calls.map(({ operation }) => operation)).toEqual([
          "claim",
          "release",
        ]);
      }),
    );
  }),
);
