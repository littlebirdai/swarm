import {
  EDGE_PROTOCOL_VERSION,
  RELAY_SESSION_LIVENESS_CAPABILITY,
  parseRelayGrantResponse,
  type HelloRequest,
  type RelayGrantRequest,
} from "@codecast/edge-contract";
import { makeFacade } from "@codecast/effect-kit/effect";
import {
  createRelayClient,
  type RelayClientOptions,
} from "@codecast/relay-client";
import {
  RELAY_MAX_HUBS_PER_CONNECTION,
  RELAY_PROTOCOL_VERSION,
} from "@codecast/relay-contract";
import { Service } from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EdgeClient } from "./effect";
import type { EdgeTransport } from "./types";
import { makeRequest } from "./request";

const intervalMs = 5_000;

type RunLease = RelayGrantRequest["sessions"][number] & { deadline: number };

type Options = {
  transport: EdgeTransport;
  hello: Omit<HelloRequest, "versions" | "capabilities">;
  WebSocket?: RelayClientOptions["WebSocket"];
};

class RelayLiveness extends Service<
  RelayLiveness,
  {
    tick: () => Effect.Effect<number>;
  }
>()("@codecast/edge-client/RelayLiveness") {}

function relayLivenessLayer(
  options: Options,
  leases: () => ReadonlyMap<string, RunLease>,
) {
  return Layer.effect(
    RelayLiveness,
    Effect.gen(function* () {
      const edge = yield* EdgeClient;
      const send = makeRequest({ transport: options.transport });
      const watched = new Map<
        string,
        { lease: RunLease; stop: () => void; sentAt?: number }
      >();
      let relay: ReturnType<typeof createRelayClient> | undefined;
      let negotiated = false;
      const now = () => performance.now();
      const close = () => {
        relay?.close();
        relay = undefined;
        watched.clear();
      };
      yield* Effect.addFinalizer(() => Effect.sync(close));

      const mint: RelayClientOptions["getToken"] = (hubs, signal) => {
        const getGrant = Effect.gen(function* () {
          if (!negotiated) {
            const hello = yield* edge.hello({
              ...options.hello,
              versions: [EDGE_PROTOCOL_VERSION],
              capabilities: [RELAY_SESSION_LIVENESS_CAPABILITY],
            });
            negotiated = hello.policy.capabilities.includes(
              RELAY_SESSION_LIVENESS_CAPABILITY,
            );
            if (!negotiated) return { status: "unavailable" } as const;
          }
          const sessions = hubs.flatMap(({ id }) => {
            const lease = leases().get(id);
            if (!lease || lease.deadline <= now()) return [];
            const { session, run, fencing_token } = lease;
            return [{ session, run, fencing_token }];
          });
          if (sessions.length !== hubs.length)
            return { status: "unavailable" } as const;
          const { value } = yield* send(
            "relay-grant",
            { v: EDGE_PROTOCOL_VERSION, sessions },
            parseRelayGrantResponse,
          );
          if (value.status === "ok") return { ...value, omitted: [] };
          if (value.status === "rate_limited") return value;
          return { status: "unavailable" } as const;
        }).pipe(
          Effect.catch(() =>
            Effect.succeed({ status: "unavailable" } as const),
          ),
        );
        return Effect.runPromise(getGrant, { signal });
      };

      function publish(id: string) {
        const at = now();
        const subscription = watched.get(id);
        const lease = leases().get(id);
        if (
          !lease ||
          !subscription ||
          lease.deadline <= at ||
          lease.run !== subscription.lease.run ||
          lease.fencing_token !== subscription.lease.fencing_token ||
          at - (subscription.sentAt ?? -Infinity) < intervalMs
        )
          return;
        if (
          relay?.publish({
            v: RELAY_PROTOCOL_VERSION,
            type: "session_liveness",
            hub: { kind: "session", id },
            run: lease.run,
          })
        )
          subscription.sentAt = at;
      }

      const open = () =>
        createRelayClient({
          WebSocket: options.WebSocket ?? WebSocket,
          getToken: mint,
          capabilities: ["session_liveness"],
          onReady: ({ id }) => publish(id),
          now,
          random: Math.random,
          setTimer(callback, delay) {
            const timer = setTimeout(callback, delay);
            timer.unref();
            return () => clearTimeout(timer);
          },
        });

      const tick = Effect.fn("RelayLiveness.publish")(() =>
        Effect.sync(() => {
          const live = new Map(
            [...leases()].filter(([, lease]) => lease.deadline > now()),
          );
          if (
            !live.size ||
            [...watched].some(([id, { lease }]) => {
              const next = live.get(id);
              return (
                next &&
                (lease.run !== next.run ||
                  lease.fencing_token !== next.fencing_token)
              );
            })
          )
            close();
          if (!live.size) return intervalMs;
          const client = (relay ??= open());
          const starting = !watched.size;
          if (starting) client.pause();
          for (const [id, { stop }] of watched) {
            if (live.has(id)) continue;
            stop();
            watched.delete(id);
          }
          for (const [id, lease] of live) {
            const hub = { kind: "session", id } as const;
            if (!watched.has(id))
              watched.set(id, { lease, stop: client.subscribe(hub, () => {}) });
          }
          if (starting) client.resume();
          let delay = intervalMs;
          for (const id of live.keys()) {
            publish(id);
            const sentAt = watched.get(id)?.sentAt;
            if (sentAt === undefined) continue;
            const dueIn = sentAt + intervalMs - now();
            if (dueIn > 0) delay = Math.min(delay, dueIn);
          }
          return Math.max(50, Math.ceil(delay));
        }),
      );
      return { tick };
    }),
  ).pipe(Layer.provide(EdgeClient.layer({ transport: options.transport })));
}

export function startRelayLiveness(
  options: Options,
  signal: AbortSignal,
  initial: readonly RunLease[],
) {
  const bySession = (leases: readonly RunLease[]) =>
    new Map(
      leases
        .slice(0, RELAY_MAX_HUBS_PER_CONNECTION)
        .map((lease) => [lease.session, lease]),
    );
  let leases = bySession(initial);
  const facade = makeFacade(relayLivenessLayer(options, () => leases));
  const running = facade
    .run(
      Effect.gen(function* () {
        const publisher = yield* RelayLiveness;
        for (;;) {
          const delay = yield* publisher.tick();
          yield* Effect.sleep(delay);
        }
      }),
      signal,
    )
    .finally(() => facade.dispose());
  return {
    update(next: readonly RunLease[]) {
      leases = bySession(next);
    },
    running,
  };
}
