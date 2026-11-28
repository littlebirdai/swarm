import {
  parseBlobsGetRequest,
  parseDeliverySettleRequest,
  parseDeliverySettleResponse,
  parseDeliveryStartRequest,
  parseDeliveryStartResponse,
  parsePermitsNextRequest,
  parsePermitsNextResponse,
  parseTakeoverAckRequest,
  parseTakeoverAckResponse,
  type EdgeParseResult,
} from "@codecast/edge-contract";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BusMessage, BusMessageKind, BusMessageOf } from "./bus-types";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

function contractSchema<T>(parse: (value: unknown) => EdgeParseResult<T>) {
  return Schema.declare(
    (value): value is T => parse(value).ok,
  ) as Schema.Codec<T>;
}

const edgeFailureFields = {
  ok: Schema.Literal(false),
  retryable: Schema.Boolean,
  code: nonEmpty,
  retry_after_ms: Schema.optionalKey(nonNegativeInt),
};

function edgeResultSchema<K extends BusMessageKind, T>(
  kind: K,
  parse: (value: unknown) => EdgeParseResult<T>,
) {
  return Schema.Union([
    Schema.Struct({
      kind: Schema.Literal(kind),
      request_id: nonEmpty,
      ok: Schema.Literal(true),
      response: contractSchema((value): EdgeParseResult<T> => parse(value)),
    }),
    Schema.Struct({
      kind: Schema.Literal(kind),
      request_id: nonEmpty,
      ...edgeFailureFields,
    }),
  ]);
}

const receiptSchema = Schema.Struct({
  delivery_id: nonEmpty,
  provider_item_id: nonEmpty,
  turn: nonEmpty,
});

const providerInputSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("local-image"), path: nonEmpty }),
]);

const providerDeliverOutcomeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("delivered"),
    receipt: receiptSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("duplicate"),
    receipt: receiptSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("in_doubt"),
    reason: Schema.Literals(["best-effort", "unknown"]),
    code: nonEmpty,
    message: Schema.String,
    retry_after_ms: Schema.optionalKey(nonNegativeInt),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    retryable: Schema.Boolean,
    code: nonEmpty,
    message: Schema.String,
    retry_after_ms: Schema.optionalKey(nonNegativeInt),
  }),
  Schema.Struct({
    status: Schema.Literal("stale"),
    observed: Schema.Struct({
      kind: Schema.Literal("turn"),
      turn: Schema.NullOr(Schema.String),
    }),
  }),
]);

const providerRecoverOutcomeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("delivered"),
    receipt: receiptSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    retryable: Schema.Literal(false),
    resolution_evidence: nonEmpty,
  }),
  Schema.Struct({
    status: Schema.Literal("in_doubt"),
    code: nonEmpty,
    message: Schema.String,
    retry_after_ms: Schema.optionalKey(nonNegativeInt),
  }),
  Schema.Struct({
    status: Schema.Literal("busy"),
    retry_after_ms: nonNegativeInt,
  }),
]);

const expectedTurnSchema = Schema.Struct({
  kind: Schema.Literal("turn"),
  turn: nonEmpty,
});

export const BusMessageSchemas = {
  "delivery.wake": Schema.Struct({
    kind: Schema.Literal("delivery.wake"),
    session: nonEmpty,
    run: positiveInt,
    fencing_token: nonEmpty,
    send_new: Schema.optionalKey(Schema.Boolean),
  }),
  "delivery.stop": Schema.Struct({
    kind: Schema.Literal("delivery.stop"),
    session: nonEmpty,
    run: Schema.optionalKey(positiveInt),
  }),
  "delivery.settled": Schema.Struct({
    kind: Schema.Literal("delivery.settled"),
    session: nonEmpty,
    run: positiveInt,
    delivery_id: nonEmpty,
    attempt_id: nonEmpty,
    outcome: Schema.Literals([
      "delivered",
      "duplicate",
      "in_doubt",
      "failed",
      "stale",
    ]),
    retry_after_ms: Schema.optionalKey(nonNegativeInt),
  }),
  "edge.permits.next": Schema.Struct({
    kind: Schema.Literal("edge.permits.next"),
    request_id: nonEmpty,
    request: contractSchema(parsePermitsNextRequest),
  }),
  "edge.permits.next.result": edgeResultSchema(
    "edge.permits.next.result",
    parsePermitsNextResponse,
  ),
  "edge.delivery.start": Schema.Struct({
    kind: Schema.Literal("edge.delivery.start"),
    request_id: nonEmpty,
    request: contractSchema(parseDeliveryStartRequest),
  }),
  "edge.delivery.start.result": edgeResultSchema(
    "edge.delivery.start.result",
    parseDeliveryStartResponse,
  ),
  "edge.delivery.settle": Schema.Struct({
    kind: Schema.Literal("edge.delivery.settle"),
    request_id: nonEmpty,
    request: contractSchema(parseDeliverySettleRequest),
  }),
  "edge.delivery.settle.result": edgeResultSchema(
    "edge.delivery.settle.result",
    parseDeliverySettleResponse,
  ),
  "edge.takeover.ack": Schema.Struct({
    kind: Schema.Literal("edge.takeover.ack"),
    request_id: nonEmpty,
    request: contractSchema(parseTakeoverAckRequest),
  }),
  "edge.takeover.ack.result": edgeResultSchema(
    "edge.takeover.ack.result",
    parseTakeoverAckResponse,
  ),
  "edge.blob.get": Schema.Struct({
    kind: Schema.Literal("edge.blob.get"),
    request_id: nonEmpty,
    request: contractSchema(parseBlobsGetRequest),
  }),
  "edge.blob.get.result": Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("edge.blob.get.result"),
      request_id: nonEmpty,
      ok: Schema.Literal(true),
      content_type: nonEmpty,
      bytes: Schema.Uint8Array,
    }),
    Schema.Struct({
      kind: Schema.Literal("edge.blob.get.result"),
      request_id: nonEmpty,
      ...edgeFailureFields,
    }),
  ]),
  "provider.deliver": Schema.Struct({
    kind: Schema.Literal("provider.deliver"),
    request_id: nonEmpty,
    session: nonEmpty,
    run: positiveInt,
    fencing_token: nonEmpty,
    delivery_id: nonEmpty,
    attempt_id: nonEmpty,
    seq: positiveInt,
    intent: Schema.Literals(["steer", "queue"]),
    sender: Schema.Struct({
      kind: Schema.Literals(["person", "agent"]),
      id: nonEmpty,
    }),
    expected: Schema.optionalKey(expectedTurnSchema),
    baton_token: Schema.optionalKey(Schema.NullOr(positiveInt)),
    input: Schema.Array(providerInputSchema),
  }),
  "provider.deliver.cancel": Schema.Struct({
    kind: Schema.Literal("provider.deliver.cancel"),
    request_id: nonEmpty,
  }),
  "provider.deliver.result": Schema.Struct({
    kind: Schema.Literal("provider.deliver.result"),
    request_id: nonEmpty,
    delivery_id: nonEmpty,
    attempt_id: nonEmpty,
    outcome: providerDeliverOutcomeSchema,
  }),
  "provider.recover": Schema.Struct({
    kind: Schema.Literal("provider.recover"),
    request_id: nonEmpty,
    session: nonEmpty,
    run: positiveInt,
    fencing_token: nonEmpty,
    delivery_id: nonEmpty,
    attempt_id: nonEmpty,
    expected: Schema.optionalKey(expectedTurnSchema),
    baton_token: Schema.optionalKey(Schema.NullOr(positiveInt)),
  }),
  "provider.recover.result": Schema.Struct({
    kind: Schema.Literal("provider.recover.result"),
    request_id: nonEmpty,
    delivery_id: nonEmpty,
    attempt_id: nonEmpty,
    outcome: providerRecoverOutcomeSchema,
  }),
  "provider.receipt": Schema.Struct({
    kind: Schema.Literal("provider.receipt"),
    session: nonEmpty,
    run: positiveInt,
    delivery_id: nonEmpty,
    provider_item_id: nonEmpty,
    turn: nonEmpty,
  }),
} as const;

export class BusValidationError extends TaggedError("BusValidationError")<{
  readonly kind: string;
  readonly cause: unknown;
}> {}

export class BusTimeoutError extends TaggedError("BusTimeoutError")<{
  readonly kind: string;
  readonly responseKind: string;
  readonly timeoutMs: number;
}> {}

export class BusUnavailableError extends TaggedError("BusUnavailableError")<{
  readonly kind: string;
  readonly reason: "closed" | "overloaded";
}> {}

export type BusRequestKind = {
  [K in BusMessageKind]: BusMessageOf<K> extends { readonly request_id: string }
    ? K
    : never;
}[BusMessageKind];

export type BusRequestError =
  | BusValidationError
  | BusTimeoutError
  | BusUnavailableError;

const BUS_CAPACITY = 1024;
const MAX_WAITING_REQUESTS = BUS_CAPACITY * 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class SupervisorBus extends Context.Service<
  SupervisorBus,
  {
    publish(message: BusMessage): Effect.Effect<void, BusValidationError>;
    subscribe(): Effect.Effect<
      PubSub.Subscription<BusMessage>,
      never,
      Scope.Scope
    >;
    stream<K extends BusMessageKind>(kind: K): Stream.Stream<BusMessageOf<K>>;
    request<K extends BusRequestKind, R extends BusRequestKind>(
      message: BusMessageOf<K>,
      responseKind: R,
      match: (response: BusMessageOf<R>) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<BusMessageOf<R>, BusRequestError>;
  }
>()("@codecast/edge-supervisor/SupervisorBus") {
  static readonly layer = Layer.effect(
    SupervisorBus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.bounded<BusMessage>(BUS_CAPACITY);
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));

      const decode = Effect.fn("SupervisorBus.decode")(function* (
        message: BusMessage,
      ) {
        const schema = BusMessageSchemas[
          message.kind
        ] as Schema.Codec<BusMessage>;
        if (!schema) {
          return yield* new BusValidationError({
            kind: String((message as { kind?: unknown }).kind ?? "unknown"),
            cause: new Error("Unknown bus message kind"),
          });
        }
        return yield* Schema.decodeUnknownEffect(schema)(message).pipe(
          Effect.mapError(
            (cause) =>
              new BusValidationError({
                kind: message.kind,
                cause,
              }),
          ),
        );
      });

      const publish = Effect.fn("SupervisorBus.publish")(function* (
        message: BusMessage,
      ) {
        const validated = yield* decode(message);
        yield* PubSub.publish(pubsub, validated);
      });

      const subscribe = () => PubSub.subscribe(pubsub);

      const stream = <K extends BusMessageKind>(
        kind: K,
      ): Stream.Stream<BusMessageOf<K>> =>
        Stream.fromPubSub(pubsub).pipe(
          Stream.filter(
            (message): message is BusMessageOf<K> => message.kind === kind,
          ),
        );

      type Waiter = {
        readonly requestKind: BusMessageKind;
        readonly responseKind: BusMessageKind;
        readonly match: (response: BusMessage) => boolean;
        readonly answer: Deferred.Deferred<BusMessage, BusUnavailableError>;
      };
      const waiters = new Map<string, Waiter>();
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          closed = true;
          const waiting = [...waiters.values()];
          waiters.clear();
          return Effect.forEach(
            waiting,
            (waiter) =>
              Deferred.fail(
                waiter.answer,
                new BusUnavailableError({
                  kind: waiter.requestKind,
                  reason: "closed",
                }),
              ),
            { discard: true },
          );
        }),
      );
      const responses = yield* PubSub.subscribe(pubsub);
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const next = yield* PubSub.take(responses);
            if (!("request_id" in next)) return;
            const waiter = waiters.get(next.request_id);
            if (
              !waiter ||
              next.kind !== waiter.responseKind ||
              !waiter.match(next)
            )
              return;
            waiters.delete(next.request_id);
            yield* Deferred.succeed(waiter.answer, next);
          }),
          { disableYield: true },
        ),
        { startImmediately: true },
      );

      const unavailable = (
        kind: string,
        reason: BusUnavailableError["reason"],
      ) => Effect.fail(new BusUnavailableError({ kind, reason }));

      const register = (requestId: string, waiter: Waiter) =>
        Effect.suspend((): Effect.Effect<Waiter, BusRequestError> => {
          if (closed) return unavailable(waiter.requestKind, "closed");
          if (waiters.has(requestId)) {
            return Effect.fail(
              new BusValidationError({
                kind: waiter.requestKind,
                cause: new Error("Duplicate bus request id"),
              }),
            );
          }
          if (waiters.size >= MAX_WAITING_REQUESTS) {
            return unavailable(waiter.requestKind, "overloaded");
          }
          waiters.set(requestId, waiter);
          return Effect.succeed(waiter);
        });

      const unregister = (requestId: string, waiter: Waiter) =>
        Effect.sync(() => {
          if (waiters.get(requestId) === waiter) waiters.delete(requestId);
        });

      const request = Effect.fn("SupervisorBus.request")(function* <
        K extends BusRequestKind,
        R extends BusRequestKind,
      >(
        message: BusMessageOf<K>,
        responseKind: R,
        match: (response: BusMessageOf<R>) => boolean,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      ) {
        const sent: BusMessage = message;
        const { kind } = sent;
        if (!("request_id" in sent)) {
          return yield* new BusValidationError({
            kind,
            cause: new Error("Bus request without a request id"),
          });
        }
        const requestId = sent.request_id;
        const answer = yield* Deferred.make<BusMessage, BusUnavailableError>();
        const waiter: Waiter = {
          requestKind: kind,
          responseKind,
          match: (response) => match(response as BusMessageOf<R>),
          answer,
        };
        return yield* Effect.acquireUseRelease(
          register(requestId, waiter),
          () =>
            decode(sent).pipe(
              Effect.flatMap((validated) => PubSub.publish(pubsub, validated)),
              Effect.catchCause(
                (cause): Effect.Effect<boolean, BusRequestError> =>
                  closed && Cause.hasInterruptsOnly(cause)
                    ? unavailable(kind, "closed")
                    : Effect.failCause(cause),
              ),
              Effect.flatMap((published) =>
                published
                  ? Deferred.await(answer)
                  : unavailable(kind, "closed"),
              ),
              Effect.map((response) => response as BusMessageOf<R>),
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () =>
                  Effect.fail(
                    new BusTimeoutError({
                      kind,
                      responseKind,
                      timeoutMs,
                    }),
                  ),
              }),
            ),
          () => unregister(requestId, waiter),
        );
      });

      return SupervisorBus.of({
        publish,
        subscribe,
        stream,
        request,
      });
    }),
  );
}
