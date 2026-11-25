import { Clock } from "effect/Clock";
import { Service } from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { PreventSchedulerYield } from "effect/References";
import * as Scope from "effect/Scope";
import { openConnection } from "./connection";
import { HubRegistry } from "./hubs";

export interface RelaySocket {
  send: (text: string) => "sent" | "paused" | "closed";
  close: (code: number) => void;
  terminate: () => void;
}

export interface RelayConnection {
  receive: (message: unknown) => Effect.Effect<void>;
  writable: Effect.Effect<void>;
  disconnected: Effect.Effect<void>;
}

export interface RelayOptions {
  audience: string;
  signalTtlMs: number;
  handshakeMs: number;
  retryAfterMs: number;
  queueCapacity: number;
  maxConnections: number;
  maxPreAuthConnections: number;
  maxConnectionsPerSubject: number;
  maxHubs: number;
  maxSubscribersPerHub: number;
}

export class TokenVerifier extends Service<
  TokenVerifier,
  { verify: (token: string) => string | null }
>()("@codecast/relay/TokenVerifier") {}

export class Relay extends Service<
  Relay,
  {
    open: (socket: RelaySocket) => Effect.Effect<RelayConnection | null>;
    drain: Effect.Effect<void>;
    isDraining: Effect.Effect<boolean>;
  }
>()("@codecast/relay/Relay") {
  static layer(options: RelayOptions) {
    return Layer.effect(Relay, makeRelay(options)).pipe(
      Layer.provide(
        HubRegistry.layer(options.maxHubs, options.maxSubscribersPerHub),
      ),
    );
  }
}

function makeRelay(options: RelayOptions) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const clock = yield* Clock;
    const registry = yield* HubRegistry;
    const verifier = yield* TokenVerifier;
    const wake = yield* Queue.sliding<void>(1);
    const connections = new Set<ReturnType<typeof openConnection>>();
    const subjectCounts = new Map<string, number>();
    let unauthenticated = 0;
    let authenticated = 0;
    let draining = false;

    const deadlineChanged = () => {
      Queue.offerUnsafe(wake, undefined);
    };
    const isDraining = () => draining;
    const unavailable = {
      type: "hello",
      status: "unavailable",
      retry_after_ms: options.retryAfterMs,
    } as const;

    const inSocketOrder = Effect.provideService(PreventSchedulerYield, true);

    const open = Effect.fn("Relay.open")(function* (socket: RelaySocket) {
      if (draining || unauthenticated >= options.maxPreAuthConnections) {
        socket.send(JSON.stringify(unavailable));
        socket.close(1013);
        return null;
      }
      const connectionScope = yield* Scope.fork(scope);
      unauthenticated++;
      let admitted: string | undefined;
      const admit = (key: string) => {
        const count = subjectCounts.get(key) ?? 0;
        if (
          authenticated >= options.maxConnections ||
          count >= options.maxConnectionsPerSubject
        )
          return false;
        authenticated++;
        unauthenticated--;
        subjectCounts.set(key, count + 1);
        admitted = key;
        return true;
      };
      const entry = openConnection(
        socket,
        connectionScope,
        clock,
        registry,
        options,
        verifier.verify,
        { admit, isDraining, deadlineChanged },
        unavailable,
      );
      connections.add(entry);
      yield* Scope.addFinalizer(
        connectionScope,
        Effect.gen(function* () {
          connections.delete(entry);
          if (admitted === undefined) {
            unauthenticated--;
          } else {
            authenticated--;
            const count = subjectCounts.get(admitted) ?? 1;
            if (count === 1) subjectCounts.delete(admitted);
            else subjectCounts.set(admitted, count - 1);
          }
          deadlineChanged();
          yield* entry.dispose;
        }),
      );
      deadlineChanged();
      const { receive, writable, disconnected } = entry.connection;
      return {
        receive: (message: unknown) => receive(message).pipe(inSocketOrder),
        writable: writable.pipe(inSocketOrder),
        disconnected: disconnected.pipe(inSocketOrder),
      };
    }, inSocketOrder);

    yield* Effect.forever(
      Effect.gen(function* () {
        const now = clock.currentTimeMillisUnsafe();
        let earliest = Infinity;
        for (const connection of connections) {
          if (connection.deadline() <= now)
            yield* connection.expire(now).pipe(inSocketOrder);
          earliest = Math.min(earliest, connection.deadline());
        }
        const changed = Queue.take(wake);
        if (earliest === Infinity) yield* changed;
        else
          yield* Effect.raceFirst(
            changed,
            Effect.sleep(
              Math.max(0, earliest - clock.currentTimeMillisUnsafe()),
            ),
          );
      }),
    ).pipe(Effect.forkScoped);

    const drain = Effect.fn("Relay.drain")(function* () {
      draining = true;
      for (const connection of connections) yield* connection.drain;
    }, inSocketOrder);

    return Relay.of({
      open,
      drain: drain(),
      isDraining: Effect.sync(isDraining),
    });
  });
}
