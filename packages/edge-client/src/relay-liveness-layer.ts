import {
  EDGE_PROTOCOL_VERSION,
  RELAY_SESSION_LIVENESS_CAPABILITY,
  RELAY_TOKEN_DELTAS_CAPABILITY,
  parseRelayGrantResponse,
  type HelloRequest,
  type RelayGrantRequest,
} from "@codecast/edge-contract";
import {
  createRelayClient,
  type RelayClientOptions,
} from "@codecast/relay-client";
import {
  RELAY_MAX_GRANTS_PER_TOKEN,
  RELAY_MAX_HUBS_PER_CONNECTION,
  RELAY_PROTOCOL_VERSION,
} from "@codecast/relay-contract";
import { Clock } from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Random } from "effect/Random";
import { EdgeClient } from "./effect";
import type { EdgeTransport } from "./types";
import { makeRequest } from "./request";

const intervalMs = 5_000;
const viewerHubPrefix = "viewer:";

export type RunLease = RelayGrantRequest["sessions"][number] & {
  deadline: number;
};

export type TokenDelta = {
  session: string;
  run: number;
  turn: string;
  message_id: string;
  delta_seq: number;
  text: string;
};

export type RelayLivenessOptions = {
  transport: EdgeTransport;
  hello: Omit<HelloRequest, "versions" | "capabilities">;
  WebSocket?: RelayClientOptions["WebSocket"];
  sessionLiveness?: boolean;
  tokenDeltas?: boolean;
};

function stripViewerPrefix(id: string) {
  return id.startsWith(viewerHubPrefix) ? id.slice(viewerHubPrefix.length) : id;
}

export function makeRelayLiveness(
  options: RelayLivenessOptions,
  initial: readonly RunLease[],
) {
  const wantLiveness = options.sessionLiveness !== false;
  const wantDeltas = options.tokenDeltas === true;
  const grantKinds = (wantLiveness ? 1 : 0) + (wantDeltas ? 1 : 0);
  const maxSessions = Math.max(
    1,
    Math.floor(RELAY_MAX_HUBS_PER_CONNECTION / Math.max(1, grantKinds)),
  );
  const bySession = (leases: readonly RunLease[]) =>
    new Map(
      leases.slice(0, maxSessions).map((lease) => [lease.session, lease]),
    );
  let leases = bySession(initial);
  let emitDelta: (delta: TokenDelta) => boolean = () => false;
  const update = (next: readonly RunLease[]) => {
    leases = bySession(next);
  };
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const edge = yield* EdgeClient;
      const clock = yield* Clock;
      const random = yield* Random;
      const context = yield* Effect.context();
      const runPromise = Effect.runPromiseWith(context);
      const schedule = Effect.runCallbackWith(context);
      const send = makeRequest({ transport: options.transport });
      const watched = new Map<
        string,
        {
          session: string;
          kind: "liveness" | "delta";
          lease: RunLease;
          stop: () => void;
          sentAt?: number;
        }
      >();
      let relay: ReturnType<typeof createRelayClient> | undefined;
      let negotiated = false;
      let hasLiveness = false;
      let hasDeltas = false;
      const origin = clock.monotonicTimeNanosUnsafe();
      const started = Math.ceil(performance.now());
      const now = () =>
        started + Number(clock.monotonicTimeNanosUnsafe() - origin) / 1_000_000;
      const close = () => {
        relay?.close();
        relay = undefined;
        watched.clear();
      };
      emitDelta = (delta) => {
        if (!hasDeltas || !relay) return false;
        const lease = leases.get(delta.session);
        if (!lease || lease.run !== delta.run || lease.deadline <= now())
          return false;
        try {
          return (
            relay.publish({
              v: RELAY_PROTOCOL_VERSION,
              type: "token_delta",
              hub: {
                kind: "session",
                id: `${viewerHubPrefix}${delta.session}`,
              },
              run: delta.run,
              turn: delta.turn,
              message_id: delta.message_id,
              delta_seq: delta.delta_seq,
              text: delta.text,
            }) === true
          );
        } catch {
          return false;
        }
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          emitDelta = () => false;
          close();
        }),
      );

      const mint: RelayClientOptions["getToken"] = (hubs, signal) => {
        const getGrant = Effect.gen(function* () {
          if (!negotiated) {
            const requested = [
              ...(wantLiveness ? [RELAY_SESSION_LIVENESS_CAPABILITY] : []),
              ...(wantDeltas ? [RELAY_TOKEN_DELTAS_CAPABILITY] : []),
            ];
            if (!requested.length) return { status: "unavailable" } as const;
            const hello = yield* edge.hello({
              ...options.hello,
              versions: [EDGE_PROTOCOL_VERSION],
              capabilities: requested,
            });
            hasLiveness =
              wantLiveness &&
              hello.policy.capabilities.includes(
                RELAY_SESSION_LIVENESS_CAPABILITY,
              );
            hasDeltas =
              wantDeltas &&
              hello.policy.capabilities.includes(RELAY_TOKEN_DELTAS_CAPABILITY);
            negotiated = hasLiveness || hasDeltas;
            if (!negotiated) return { status: "unavailable" } as const;
          }
          const activeHubs = hubs.filter(({ id }) =>
            id.startsWith(viewerHubPrefix) ? hasDeltas : hasLiveness,
          );
          const omitted = hubs
            .filter((entry) => !activeHubs.includes(entry))
            .map(({ kind, id }) => ({
              kind,
              id,
              reason: "unavailable" as const,
            }));
          const sessionIds = [
            ...new Set(activeHubs.map(({ id }) => stripViewerPrefix(id))),
          ];
          if (!sessionIds.length) return { status: "unavailable" } as const;
          const sessions = sessionIds.flatMap((id) => {
            const lease = leases.get(id);
            if (!lease || lease.deadline <= now()) return [];
            const { session, run, fencing_token } = lease;
            return [{ session, run, fencing_token }];
          });
          if (sessions.length !== sessionIds.length)
            return { status: "unavailable" } as const;
          const reqDeltas = activeHubs.some(({ id }) =>
            id.startsWith(viewerHubPrefix),
          );
          const { value } = yield* send(
            "relay-grant",
            {
              v: EDGE_PROTOCOL_VERSION,
              sessions,
              ...(reqDeltas ? { token_deltas: true } : {}),
            },
            parseRelayGrantResponse,
          );
          if (value.status === "ok") return { ...value, omitted };
          if (value.status === "rate_limited") return value;
          return { status: "unavailable" } as const;
        }).pipe(
          Effect.catch(() =>
            Effect.succeed({ status: "unavailable" } as const),
          ),
        );
        return runPromise(getGrant, { signal });
      };

      function publish(id: string) {
        const at = now();
        const subscription = watched.get(id);
        if (!subscription || subscription.kind !== "liveness") return;
        const lease = leases.get(subscription.session);
        if (
          !lease ||
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
          capabilities: [
            ...(wantLiveness ? (["session_liveness"] as const) : []),
            ...(wantDeltas ? (["token_delta"] as const) : []),
          ],
          maxGrantGroups:
            wantLiveness && wantDeltas
              ? Math.max(1, Math.floor(RELAY_MAX_GRANTS_PER_TOKEN / 2))
              : undefined,
          grantGroup: ({ id }) => stripViewerPrefix(id),
          onReady: ({ id }) => publish(id),
          now,
          random: () => random.nextDoubleUnsafe(),
          setTimer: (callback, delay) =>
            schedule(
              Effect.andThen(Effect.sleep(delay), Effect.sync(callback)),
            ),
        });

      const tick = Effect.fn("RelayLiveness.publish")(() =>
        Effect.sync(() => {
          const live = new Map(
            [...leases].filter(([, lease]) => lease.deadline > now()),
          );
          const livenessActive = wantLiveness && (!negotiated || hasLiveness);
          const deltasActive = wantDeltas && (!negotiated || hasDeltas);
          const desired = new Map<
            string,
            { session: string; kind: "liveness" | "delta"; lease: RunLease }
          >();
          for (const [session, lease] of live) {
            if (livenessActive)
              desired.set(session, { session, kind: "liveness", lease });
            if (deltasActive)
              desired.set(`${viewerHubPrefix}${session}`, {
                session,
                kind: "delta",
                lease,
              });
          }
          if (
            !desired.size ||
            [...watched].some(([, { session, lease }]) => {
              const next = live.get(session);
              return (
                next &&
                (lease.run !== next.run ||
                  lease.fencing_token !== next.fencing_token)
              );
            })
          )
            close();
          if (!desired.size) return intervalMs;
          const client = (relay ??= open());
          const starting = !watched.size;
          if (starting) client.pause();
          for (const [id, { stop }] of watched) {
            if (desired.has(id)) continue;
            stop();
            watched.delete(id);
          }
          for (const [id, entry] of desired) {
            const hub = { kind: "session", id } as const;
            if (!watched.has(id))
              watched.set(id, {
                ...entry,
                stop: client.subscribe(hub, () => {}),
              });
          }
          if (starting) client.resume();
          let delay = intervalMs;
          for (const [id, entry] of watched) {
            if (entry.kind !== "liveness") continue;
            publish(id);
            const sentAt = entry.sentAt;
            if (sentAt === undefined) continue;
            const dueIn = sentAt + intervalMs - now();
            if (dueIn > 0) delay = Math.min(delay, dueIn);
          }
          return Math.max(50, Math.ceil(delay));
        }),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            const delay = yield* tick();
            yield* Effect.sleep(delay);
          }
        }),
      );
    }),
  ).pipe(Layer.provide(EdgeClient.layer({ transport: options.transport })));
  return {
    layer,
    update,
    publishDelta: (delta: TokenDelta) => emitDelta(delta),
  };
}
