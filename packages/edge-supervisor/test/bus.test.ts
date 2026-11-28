import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { adjust, withLive } from "effect/testing/TestClock";
import {
  BusTimeoutError,
  BusValidationError,
  SupervisorBus,
  type BusMessage,
} from "../src/effect";

it.effect("publishes and delivers schema-validated messages by kind", () =>
  Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const received: BusMessage[] = [];
    const sub = yield* bus.subscribe();

    yield* bus.publish({
      kind: "delivery.wake",
      session: "session-1",
      run: 1,
      fencing_token: "lease-1",
      send_new: true,
    });
    yield* bus.publish({
      kind: "provider.receipt",
      session: "session-1",
      run: 1,
      delivery_id: "delivery-1",
      provider_item_id: "item-1",
      turn: "turn-1",
    });

    received.push(yield* PubSub.take(sub));
    received.push(yield* PubSub.take(sub));
    expect(received).toEqual([
      {
        kind: "delivery.wake",
        session: "session-1",
        run: 1,
        fencing_token: "lease-1",
        send_new: true,
      },
      {
        kind: "provider.receipt",
        session: "session-1",
        run: 1,
        delivery_id: "delivery-1",
        provider_item_id: "item-1",
        turn: "turn-1",
      },
    ]);
  }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect("rejects malformed messages against the kind schema", () =>
  Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const error = yield* Effect.flip(
      bus.publish({
        kind: "delivery.wake",
        session: "",
        run: 0,
        fencing_token: "lease-1",
      }),
    );
    expect(error).toBeInstanceOf(BusValidationError);
    expect(error.kind).toBe("delivery.wake");
  }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect("stream filters messages to the requested kind", () =>
  Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const settled: string[] = [];
    const sub = yield* bus.subscribe();

    yield* Effect.forkScoped(
      Stream.runForEach(bus.stream("delivery.settled"), (message) =>
        Effect.sync(() => {
          settled.push(message.delivery_id);
        }),
      ),
      { startImmediately: true },
    );

    yield* bus.publish({
      kind: "delivery.wake",
      session: "session-1",
      run: 1,
      fencing_token: "lease-1",
    });
    yield* bus.publish({
      kind: "delivery.settled",
      session: "session-1",
      run: 1,
      delivery_id: "delivery-a",
      attempt_id: "attempt-a",
      outcome: "delivered",
    });

    yield* PubSub.take(sub);
    yield* PubSub.take(sub);
    yield* Effect.yieldNow;
    expect(settled).toEqual(["delivery-a"]);
  }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect("request correlates request_id across concurrent messages", () =>
  Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const sub = yield* bus.subscribe();

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const message = yield* PubSub.take(sub);
          if (message.kind === "edge.permits.next") {
            yield* bus.publish({
              kind: "edge.permits.next.result",
              request_id: "other-request",
              ok: true,
              response: { v: 1, status: "stale" },
            });
            yield* bus.publish({
              kind: "edge.permits.next.result",
              request_id: message.request_id,
              ok: true,
              response: { v: 1, status: "empty" },
            });
          }
        }),
      ),
      { startImmediately: true },
    );

    const reply = yield* bus.request(
      {
        kind: "edge.permits.next",
        request_id: "req-1",
        request: {
          v: 1,
          session: "session-1",
          run: 1,
          fencing_token: "lease-1",
        },
      },
      "edge.permits.next.result",
      (response) => response.request_id === "req-1",
    );

    expect(reply).toEqual({
      kind: "edge.permits.next.result",
      request_id: "req-1",
      ok: true,
      response: { v: 1, status: "empty" },
    });
  }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect(
  "request fails with BusTimeoutError when no response arrives in time",
  () =>
    Effect.gen(function* () {
      const bus = yield* SupervisorBus;
      const fiber = yield* Effect.forkChild(
        Effect.result(
          bus.request(
            {
              kind: "edge.permits.next",
              request_id: "req-timeout",
              request: {
                v: 1,
                session: "session-1",
                run: 1,
                fencing_token: "lease-1",
              },
            },
            "edge.permits.next.result",
            (response) => response.request_id === "req-timeout",
            2_500,
          ),
        ),
        { startImmediately: true },
      );

      yield* adjust(2_499);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* adjust(1);
      const outcome = yield* Fiber.join(fiber);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toBeInstanceOf(BusTimeoutError);
      }
    }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect(
  "requests far past the bus capacity all get their replies after a stalled responder resumes",
  () =>
    Effect.gen(function* () {
      const bus = yield* SupervisorBus;
      const count = 2_100;
      const resume = yield* Deferred.make<void>();
      const sub = yield* bus.subscribe();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(
          Effect.andThen(
            Effect.forever(
              Effect.gen(function* () {
                const message = yield* PubSub.take(sub);
                if (message.kind !== "edge.permits.next") return;
                yield* Effect.forkChild(
                  bus.publish({
                    kind: "edge.permits.next.result",
                    request_id: message.request_id,
                    ok: true,
                    response: { v: 1, status: "empty" },
                  }),
                  { startImmediately: true },
                );
              }),
            ),
          ),
        ),
        { startImmediately: true },
      );
      const requests = yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => `request-${index}`),
        (requestId) =>
          Effect.forkChild(
            Effect.result(
              bus.request(
                {
                  kind: "edge.permits.next",
                  request_id: requestId,
                  request: {
                    v: 1,
                    session: "session-1",
                    run: 1,
                    fencing_token: "lease-1",
                  },
                },
                "edge.permits.next.result",
                (reply) => reply.request_id === requestId,
              ),
            ),
            { startImmediately: true },
          ),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(resume, undefined);
      const results = yield* withLive(
        Effect.forEach(requests, (request) => Fiber.join(request)).pipe(
          Effect.timeoutOrElse({
            duration: 5_000,
            orElse: () =>
              Effect.die(new Error("timed out waiting for the replies")),
          }),
        ),
      );
      expect(
        results.filter((result) => result._tag === "Success"),
      ).toHaveLength(count);
    }).pipe(Effect.provide(SupervisorBus.layer)),
  20_000,
);

const permitsRequest = (requestId: string) =>
  ({
    kind: "edge.permits.next",
    request_id: requestId,
    request: { v: 1, session: "session-1", run: 1, fencing_token: "lease-1" },
  }) as const;

const askPermits = (bus: SupervisorBus["Service"], requestId: string) =>
  bus.request(
    permitsRequest(requestId),
    "edge.permits.next.result",
    (reply) => reply.request_id === requestId,
  );

const live = <A, E>(effect: Effect.Effect<A, E>, what: string) =>
  withLive(
    effect.pipe(
      Effect.timeoutOrElse({
        duration: 2_000,
        orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
      }),
    ),
  );

it.effect("closing the bus fails waiting and later requests at once", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(SupervisorBus.layer, scope);
    const bus = Context.get(context, SupervisorBus);
    const waiting = yield* Effect.forkChild(
      Effect.result(askPermits(bus, "waiting")),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    const result = yield* live(Fiber.join(waiting), "the waiting request");
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "BusUnavailableError",
        kind: "edge.permits.next",
        reason: "closed",
      },
    });
    const later = yield* live(
      Effect.result(askPermits(bus, "later")),
      "the later request",
    );
    expect(later).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BusUnavailableError", reason: "closed" },
    });
  }),
);

it.effect("a second request with a waiting request id fails at once", () =>
  Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    yield* Effect.forkChild(askPermits(bus, "same"), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    const second = yield* live(
      Effect.result(askPermits(bus, "same")),
      "the duplicate request",
    );
    expect(second).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BusValidationError" },
    });
  }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect("an interrupted request leaves no waiting entry behind", () =>
  Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const first = yield* Effect.forkChild(askPermits(bus, "reused"), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    const sub = yield* bus.subscribe();
    yield* Effect.forkChild(
      PubSub.take(sub).pipe(
        Effect.andThen(
          bus.publish({
            kind: "edge.permits.next.result",
            request_id: "reused",
            ok: true,
            response: { v: 1, status: "empty" },
          }),
        ),
      ),
      { startImmediately: true },
    );
    const reply = yield* live(askPermits(bus, "reused"), "the reused id");
    expect(reply).toMatchObject({ ok: true });
  }).pipe(Effect.provide(SupervisorBus.layer)),
);

it.effect(
  "requests past the waiting limit are refused as overloaded",
  () =>
    Effect.gen(function* () {
      const bus = yield* SupervisorBus;
      for (let index = 0; index < 4_096; index++) {
        yield* Effect.forkChild(askPermits(bus, `held-${index}`), {
          startImmediately: true,
        });
      }
      const refused = yield* live(
        Effect.result(askPermits(bus, "one-too-many")),
        "the refused request",
      );
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BusUnavailableError", reason: "overloaded" },
      });
    }).pipe(Effect.provide(SupervisorBus.layer)),
  20_000,
);

it.effect(
  "a request whose publish waits on a full bus fails as closed when the bus closes",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(SupervisorBus.layer, scope);
      const bus = Context.get(context, SupervisorBus);
      yield* bus.subscribe();
      for (let index = 0; index < 1_024; index++) {
        yield* bus.publish({
          kind: "provider.receipt",
          session: "session-1",
          run: 1,
          delivery_id: `delivery-${index}`,
          provider_item_id: "item-1",
          turn: "turn-1",
        });
      }
      const blocked = yield* Effect.forkChild(
        Effect.result(askPermits(bus, "blocked")),
        { startImmediately: true },
      );
      yield* Effect.yieldNow;
      expect(blocked.pollUnsafe()).toBeUndefined();
      yield* Scope.close(scope, Exit.void);
      const result = yield* live(Fiber.join(blocked), "the blocked request");
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "BusUnavailableError",
          kind: "edge.permits.next",
          reason: "closed",
        },
      });
    }),
);
