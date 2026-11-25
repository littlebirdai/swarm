import type { RelayHub } from "@codecast/relay-contract";
import { Service } from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Publication } from "./signals";

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
      subjectKey: string,
      receive: Receive,
      connectionScope: Scope.Scope,
    ) => Effect.Effect<HubSubscription | null>;
  }
>()("@codecast/relay/HubRegistry") {
  static layer(maxHubs: number, maxSubscribers: number) {
    return Layer.effect(
      HubRegistry,
      Effect.sync(() => {
        const hubs = new Map<string, Map<Receive, string>>();
        const maxPerSubject = Math.max(1, Math.floor(maxSubscribers / 2));

        const subscribe = Effect.fn("HubRegistry.subscribe")(function* (
          hub: RelayHub,
          subjectKey: string,
          receive: Receive,
          connectionScope: Scope.Scope,
        ) {
          const key = hubKey(hub);
          let subscribers = hubs.get(key);
          if (!subscribers) {
            if (hubs.size >= maxHubs) return null;
            subscribers = new Map();
            hubs.set(key, subscribers);
          }
          if (subscribers.size >= maxSubscribers) return null;
          let subjectCount = 0;
          for (const subject of subscribers.values()) {
            if (subject === subjectKey) subjectCount++;
          }
          if (subjectCount >= maxPerSubject) return null;

          const scope = yield* Scope.fork(connectionScope);
          subscribers.set(receive, subjectKey);
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              subscribers.delete(receive);
              if (subscribers.size === 0) hubs.delete(key);
            }),
          );

          const publish = Effect.fn("HubSubscription.publish")(function* (
            publication: Publication,
          ) {
            for (const deliver of subscribers.keys())
              yield* deliver(publication);
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
