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
import * as Context from "effect/Context";
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

const BUS_CAPACITY = 1024;
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
    request<K extends BusMessageKind, R extends BusMessageKind>(
      message: BusMessageOf<K>,
      responseKind: R,
      match: (response: BusMessageOf<R>) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<BusMessageOf<R>, BusValidationError | BusTimeoutError>;
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

      const request = Effect.fn("SupervisorBus.request")(function* <
        K extends BusMessageKind,
        R extends BusMessageKind,
      >(
        message: BusMessageOf<K>,
        responseKind: R,
        match: (response: BusMessageOf<R>) => boolean,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const sub = yield* PubSub.subscribe(pubsub);
            yield* publish(message);
            for (;;) {
              const next = yield* PubSub.take(sub);
              if (
                next.kind === responseKind &&
                match(next as BusMessageOf<R>)
              ) {
                return next as BusMessageOf<R>;
              }
            }
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(
                new BusTimeoutError({
                  kind: message.kind,
                  responseKind,
                  timeoutMs,
                }),
              ),
          }),
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
