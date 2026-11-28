import type {
  DeliveryResolutionRequest,
  DeliverySettleRequest,
  DeliveryStartRequest,
  PermitsNextRequest,
  PermitsNextResponse,
} from "@codecast/edge-contract";
import {
  SupervisorBus,
  type BusMessage,
  type BusMessageOf,
  type EdgeBusResult,
  type ProviderDeliverOutcome,
  type ProviderRecoverOutcome,
} from "@codecast/edge-supervisor/effect";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { withLive } from "effect/testing/TestClock";
import type {
  DeliveryBridge,
  DeliveryPermit,
  DeliveryReceipt,
  DeliverySteerJournal,
  ReceiptJournal,
  SteerJournal,
} from "../src/types";

export const run: PermitsNextRequest = {
  v: 1,
  session: "session-1",
  run: 1,
  fencing_token: "lease-1",
};

export function runFor(session: string): PermitsNextRequest {
  return { ...run, session };
}

export function makePermit(
  overrides: Partial<DeliveryPermit> = {},
): DeliveryPermit {
  return {
    v: 1,
    status: "permit",
    session: "session-1",
    run: 1,
    fencing_token: "lease-1",
    delivery_id: "delivery-1",
    attempt_id: "attempt-1",
    seq: 1,
    intent: "queue",
    sender: { kind: "person", id: "user-1" },
    state: "new",
    input: [{ type: "text", text: "hello" }],
    ...overrides,
  } as DeliveryPermit;
}

export function makeSteerPermit(
  overrides: Partial<Extract<DeliveryPermit, { intent: "steer" }>> = {},
): DeliveryPermit {
  return makePermit({
    intent: "steer",
    expected: { kind: "turn", turn: "turn-1" },
    baton_token: null,
    ...overrides,
  } as Partial<DeliveryPermit>);
}

export function makeMemoryReceiptJournal(
  seed: Array<[string, DeliveryReceipt]> = [],
): ReceiptJournal & { records: Map<string, DeliveryReceipt> } {
  const records = new Map<string, DeliveryReceipt>(
    seed.map(([session, receipt]) => [
      `${session}:${receipt.delivery_id}`,
      receipt,
    ]),
  );
  return {
    records,
    async find(session, deliveryId) {
      return records.get(`${session}:${deliveryId}`);
    },
    async record(session, receipt) {
      records.set(`${session}:${receipt.delivery_id}`, receipt);
    },
    async forget(session, deliveryId) {
      records.delete(`${session}:${deliveryId}`);
    },
  };
}

export function makeMemorySteerJournal(
  seed?: DeliverySteerJournal,
): SteerJournal & { state: () => DeliverySteerJournal | undefined } {
  let saved = seed;
  return {
    state: () => saved,
    async load() {
      return saved;
    },
    async save(_scope, state) {
      saved = state;
    },
  };
}

type SlotState = "claimed" | "delivery-started" | "ambiguous";

type Slot = { permit: DeliveryPermit; state: SlotState };

type SettleStatus = "recorded" | "duplicate" | "stale";

export type FakeServer = ReturnType<typeof makeFakeServer>;

export function makeFakeServer(permits: readonly DeliveryPermit[] = []) {
  const queues = new Map<string, Slot[]>();
  const settles: (DeliverySettleRequest | DeliveryResolutionRequest)[] = [];
  const starts: DeliveryStartRequest[] = [];
  const permitReads = new Map<string, number>();
  const lagging = new Set<string>();
  let retries = 0;

  const enqueue = (permit: DeliveryPermit) => {
    const queue = queues.get(permit.session) ?? [];
    queue.push({
      permit: { ...permit, state: "new" },
      state: permit.state === "started" ? "delivery-started" : "claimed",
    });
    queues.set(permit.session, queue);
  };
  for (const permit of permits) enqueue(permit);

  const headFor = (
    request: Pick<
      DeliveryStartRequest,
      "session" | "run" | "fencing_token" | "attempt_id" | "delivery_id"
    >,
  ) => {
    const head = queues.get(request.session)?.[0];
    if (
      !head ||
      head.permit.run !== request.run ||
      head.permit.fencing_token !== request.fencing_token ||
      head.permit.attempt_id !== request.attempt_id ||
      head.permit.delivery_id !== request.delivery_id
    ) {
      return undefined;
    }
    return head;
  };

  const finish = (session: string) => {
    queues.get(session)?.shift();
  };

  const permitsNext = (
    request: PermitsNextRequest,
  ): EdgeBusResult<Exclude<PermitsNextResponse, { status: "error" }>> => {
    permitReads.set(
      request.session,
      (permitReads.get(request.session) ?? 0) + 1,
    );
    const head = queues.get(request.session)?.[0];
    if (!head) return { ok: true, response: { v: 1, status: "empty" } };
    if (head.permit.fencing_token !== request.fencing_token) {
      return { ok: true, response: { v: 1, status: "stale" } };
    }
    const reportsNew =
      head.state === "claimed" || lagging.delete(request.session);
    return {
      ok: true,
      response: { ...head.permit, state: reportsNew ? "new" : "started" },
    };
  };

  const start = (request: DeliveryStartRequest) => {
    starts.push(request);
    const head = headFor(request);
    if (!head || head.state === "ambiguous") {
      return {
        ok: true as const,
        response: {
          v: 1 as const,
          status: "rejected" as const,
          reason: "stale",
        },
      };
    }
    const status =
      head.state === "claimed"
        ? ("started" as const)
        : ("already_started" as const);
    head.state = "delivery-started";
    return { ok: true as const, response: { ...request, status } };
  };

  const settleStatus = (
    request: DeliverySettleRequest | DeliveryResolutionRequest,
  ): SettleStatus | "evidence_required" => {
    const head = headFor(request);
    if (!head) return "stale";
    const evidence =
      "resolution_evidence" in request
        ? request.resolution_evidence
        : undefined;
    switch (request.outcome) {
      case "in_doubt":
        if (head.state === "ambiguous") return "duplicate";
        if (head.state !== "delivery-started") return "stale";
        head.state = "ambiguous";
        return "recorded";
      case "applied":
      case "duplicate":
        if (head.state === "claimed") return "stale";
        if (head.state === "ambiguous" && evidence === undefined)
          return "evidence_required";
        finish(request.session);
        return "recorded";
      case "stale":
      case "rejected":
        if (head.state === "ambiguous" && evidence === undefined)
          return "evidence_required";
        finish(request.session);
        return "recorded";
      case "failed":
        if (head.state === "claimed") return "stale";
        if (head.state === "ambiguous" && evidence === undefined)
          return "evidence_required";
        if (request.retryable && evidence === undefined) {
          retries += 1;
          head.state = "claimed";
          head.permit = {
            ...head.permit,
            attempt_id: `${head.permit.attempt_id}-retry-${retries}`,
          };
          return "recorded";
        }
        finish(request.session);
        return "recorded";
    }
  };

  const settle = (
    request: DeliverySettleRequest | DeliveryResolutionRequest,
  ) => {
    settles.push(structuredClone(request));
    const status = settleStatus(request);
    if (status === "evidence_required") {
      return {
        ok: false as const,
        retryable: false,
        code: "resolution_evidence_required",
      };
    }
    return { ok: true as const, response: { v: 1 as const, status } };
  };

  const startedElsewhere = (session = run.session) => {
    const head = queues.get(session)?.[0];
    if (head) head.state = "delivery-started";
    lagging.add(session);
  };

  return {
    enqueue,
    startedElsewhere,
    permitsNext,
    start,
    settle,
    settles,
    starts,
    permitReads: (session = run.session) => permitReads.get(session) ?? 0,
    head: (session = run.session) => queues.get(session)?.[0],
  };
}

export type HarnessHandlers = {
  readonly dropReply?: (message: BusMessage) => boolean;
  readonly permitsFailure?: () =>
    | Extract<EdgeBusResult<never>, { ok: false }>
    | undefined;
  readonly onDeliver?: (
    req: BusMessageOf<"provider.deliver">,
  ) => Effect.Effect<ProviderDeliverOutcome>;
  readonly onRecover?: (
    req: BusMessageOf<"provider.recover">,
  ) => Effect.Effect<ProviderRecoverOutcome>;
};

const defaultReceipt = (req: BusMessageOf<"provider.deliver">) => ({
  delivery_id: req.delivery_id,
  provider_item_id: `item-${req.attempt_id}`,
  turn: "turn-1",
});

export function makeTestHarness(
  server: FakeServer,
  handlers: HarnessHandlers = {},
) {
  const calls: string[] = [];
  const deliveries: BusMessageOf<"provider.deliver">[] = [];
  const recoveries: BusMessageOf<"provider.recover">[] = [];

  const attach = Effect.gen(function* () {
    const bus = yield* SupervisorBus;
    const sub = yield* bus.subscribe();
    const reply = (message: BusMessage) =>
      bus.publish(message).pipe(Effect.catch(() => Effect.void));
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const message = yield* PubSub.take(sub);
          if (handlers.dropReply?.(message)) {
            calls.push(`dropped:${message.kind}`);
            return;
          }
          switch (message.kind) {
            case "edge.permits.next": {
              calls.push("permits.next");
              const failure = handlers.permitsFailure?.();
              yield* reply({
                kind: "edge.permits.next.result",
                request_id: message.request_id,
                ...(failure ?? server.permitsNext(message.request)),
              } as BusMessageOf<"edge.permits.next.result">);
              break;
            }
            case "edge.delivery.start": {
              calls.push(`delivery.start:${message.request.attempt_id}`);
              yield* reply({
                kind: "edge.delivery.start.result",
                request_id: message.request_id,
                ...server.start(message.request),
              } as BusMessageOf<"edge.delivery.start.result">);
              break;
            }
            case "edge.delivery.settle": {
              calls.push(
                `delivery.settle:${message.request.attempt_id}:${message.request.outcome}`,
              );
              yield* reply({
                kind: "edge.delivery.settle.result",
                request_id: message.request_id,
                ...server.settle(message.request),
              } as BusMessageOf<"edge.delivery.settle.result">);
              break;
            }
            case "provider.deliver.cancel": {
              calls.push(`provider.deliver.cancel:${message.request_id}`);
              break;
            }
            case "provider.deliver": {
              calls.push(`provider.deliver:${message.attempt_id}`);
              deliveries.push(message);
              yield* Effect.forkChild(
                Effect.gen(function* () {
                  const outcome: ProviderDeliverOutcome = handlers.onDeliver
                    ? yield* handlers.onDeliver(message)
                    : { status: "delivered", receipt: defaultReceipt(message) };
                  yield* reply({
                    kind: "provider.deliver.result",
                    request_id: message.request_id,
                    delivery_id: message.delivery_id,
                    attempt_id: message.attempt_id,
                    outcome,
                  });
                }),
                { startImmediately: true },
              );
              break;
            }
            case "provider.recover": {
              calls.push(`provider.recover:${message.attempt_id}`);
              recoveries.push(message);
              yield* Effect.forkChild(
                Effect.gen(function* () {
                  const outcome: ProviderRecoverOutcome = handlers.onRecover
                    ? yield* handlers.onRecover(message)
                    : {
                        status: "in_doubt",
                        code: "unknown",
                        message: "still uncertain",
                      };
                  yield* reply({
                    kind: "provider.recover.result",
                    request_id: message.request_id,
                    delivery_id: message.delivery_id,
                    attempt_id: message.attempt_id,
                    outcome,
                  });
                }),
                { startImmediately: true },
              );
              break;
            }
          }
        }),
      ),
      { startImmediately: true },
    );
  });

  return { calls, deliveries, recoveries, attach };
}

export function fakeServerBridge(
  server: FakeServer,
  deliver: DeliveryBridge["deliver"],
): DeliveryBridge {
  return {
    permitsNext: async (request) => server.permitsNext(request),
    deliveryStart: async (request) => server.start(request),
    deliverySettle: async (request) => server.settle(request),
    deliver,
  };
}

export function within<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  what: string,
  ms = 2_000,
): Effect.Effect<A, E, R> {
  return withLive(
    effect.pipe(
      Effect.timeoutOrElse({
        duration: ms,
        orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
      }),
    ),
  );
}

export function pause(ms: number): Effect.Effect<void> {
  return withLive(Effect.sleep(ms));
}

export const watchSettled = Effect.gen(function* () {
  const bus = yield* SupervisorBus;
  const sub = yield* bus.subscribe();
  const seen: BusMessageOf<"delivery.settled">[] = [];
  const matches = (
    event: BusMessageOf<"delivery.settled">,
    session: string,
    outcome: BusMessageOf<"delivery.settled">["outcome"],
    deliveryId?: string,
  ) =>
    event.session === session &&
    event.outcome === outcome &&
    (deliveryId === undefined || event.delivery_id === deliveryId);
  return (
    session: string,
    outcome: BusMessageOf<"delivery.settled">["outcome"],
    deliveryId?: string,
  ) =>
    Effect.gen(function* () {
      const index = seen.findIndex((event) =>
        matches(event, session, outcome, deliveryId),
      );
      if (index >= 0) return seen.splice(index, 1)[0]!;
      for (;;) {
        const event = yield* PubSub.take(sub);
        if (event.kind !== "delivery.settled") continue;
        if (matches(event, session, outcome, deliveryId)) return event;
        seen.push(event);
      }
    });
});
