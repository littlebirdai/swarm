import type { RelayHub, RelayServerFrame } from "@codecast/relay-contract";
import { Service } from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";

export type Signal = Extract<RelayServerFrame, { seq: number }>;

export type Publication = {
  frame: Signal;
  sourceTtl: (now: number, elapsed: bigint) => number;
};

type Receive = (publication: Publication) => Effect.Effect<void>;

export interface HubSubscription {
  publish: (publication: Publication) => Effect.Effect<void>;
  close: Effect.Effect<void>;
}

export function hubKey(hub: RelayHub): string {
  return `${hub.kind}:${hub.id}`;
}

export class HubRegistry extends Service<
  HubRegistry,
  {
    subscribe: (
      hub: RelayHub,
      receive: Receive,
      connectionScope: Scope.Scope,
    ) => Effect.Effect<HubSubscription | null>;
  }
>()("@codecast/relay/HubRegistry") {
  static layer(maxHubs: number, maxSubscribers: number) {
    return Layer.effect(
      HubRegistry,
      Effect.gen(function* () {
        const hubs = new Map<
          string,
          {
            bus: PubSub.PubSub<Publication>;
            subscribers: Map<PubSub.Subscription<Publication>, Receive>;
          }
        >();

        const subscribe = Effect.fn("HubRegistry.subscribe")(function* (
          hub: RelayHub,
          receive: Receive,
          connectionScope: Scope.Scope,
        ) {
          const key = hubKey(hub);
          let entry = hubs.get(key);
          if (!entry) {
            if (hubs.size >= maxHubs) return null;
            entry = {
              bus: yield* PubSub.bounded<Publication>(1),
              subscribers: new Map(),
            };
            hubs.set(key, entry);
          }
          const { bus, subscribers } = entry;
          if (subscribers.size >= maxSubscribers) return null;

          const scope = yield* Scope.fork(connectionScope);
          const subscription = yield* Scope.provide(
            PubSub.subscribe(bus),
            scope,
          );
          subscribers.set(subscription, receive);
          yield* Scope.addFinalizer(
            scope,
            Effect.gen(function* () {
              subscribers.delete(subscription);
              if (subscribers.size === 0) {
                hubs.delete(key);
                yield* PubSub.shutdown(bus);
              }
            }),
          );

          const publish = Effect.fn("HubSubscription.publish")(function* (
            publication: Publication,
          ) {
            yield* PubSub.publish(bus, publication);
            const deliveries = [];
            for (const [subscriber, deliver] of subscribers) {
              deliveries.push(deliver(yield* PubSub.take(subscriber)));
            }
            for (const deliver of deliveries) yield* deliver;
          });
          return {
            publish,
            close: Scope.close(scope, Exit.succeed(undefined)),
          };
        });

        return HubRegistry.of({ subscribe });
      }),
    );
  }
}
