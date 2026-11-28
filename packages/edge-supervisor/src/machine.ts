import {
  createHttpEdgeTransport,
  type EdgeTransport,
} from "@codecast/edge-client";
import { EdgeClient, EdgeVersionRejected } from "@codecast/edge-client/effect";
import {
  EDGE_PROTOCOL_VERSION,
  type HelloRequest,
} from "@codecast/edge-contract";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { HeartbeatFlush, type HeartbeatFlushHost } from "./heartbeat-flush";
import { Watchdog } from "./watchdog";

export type LinkSettings = {
  siteUrl: string;
  bearer: string;
  hello: HelloRequest;
};

export type MachineOptions = {
  log(message: string): void;
  heartbeatFlush?: HeartbeatFlushHost;
};

type Link = {
  snapshot: { settings: LinkSettings };
  fiber: Fiber.Fiber<never, Cause.Cause<unknown>>;
};

export class Machine extends Context.Service<
  Machine,
  {
    connect(settings: LinkSettings): Effect.Effect<void>;
    ensureSessionHeartbeat(
      sessionId: string,
      source?: "transcript",
    ): Effect.Effect<void>;
    stopSessionHeartbeat(sessionId: string | undefined): Effect.Effect<void>;
    armHeartbeatFlush(): Effect.Effect<void>;
    flushHeartbeats(): Effect.Effect<void>;
  }
>()("@codecast/edge-supervisor/Machine") {}

function sameLink(current: LinkSettings, next: LinkSettings) {
  return (
    current.siteUrl === next.siteUrl &&
    current.bearer === next.bearer &&
    current.hello.machine === next.hello.machine &&
    current.hello.boot === next.hello.boot
  );
}

function supervise<A, E, R>(
  name: string,
  task: Effect.Effect<A, E, R>,
  log: MachineOptions["log"],
  backoffMs: number,
) {
  return Effect.sandbox(task).pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => {
        if (!Cause.hasInterruptsOnly(cause)) log(`[EDGE] Restarting ${name}`);
      }),
    ),
    Effect.retry({
      schedule: Schedule.spaced(backoffMs),
      while: (cause) => !Cause.hasInterruptsOnly(cause),
    }),
  );
}

const runLink = Effect.fn("Machine.link")(function* (
  settings: () => LinkSettings,
) {
  const client = yield* EdgeClient;
  const welcome = yield* client.hello(settings().hello).pipe(
    Effect.catchIf(
      (error) => error instanceof EdgeVersionRejected,
      () => Effect.never,
    ),
  );
  const heartbeat = Effect.fn("Machine.heartbeat")(function* () {
    for (;;) {
      yield* Effect.sleep(welcome.policy.heartbeat_interval_ms);
      const { machine, boot, capacity } = settings().hello;
      const response = yield* client.heartbeat({
        v: EDGE_PROTOCOL_VERSION,
        machine,
        boot,
        capacity,
      });
      if (response.policy_revision !== welcome.policy.revision) return;
    }
  });
  const fiber = yield* Effect.forkScoped(heartbeat());
  yield* Fiber.join(fiber);
});

export function MachineLive(
  options: MachineOptions,
  dependencies: {
    transport?: (settings: LinkSettings) => EdgeTransport;
    watchdog?: Layer.Layer<Watchdog>;
    heartbeatFlush?: Layer.Layer<HeartbeatFlush>;
  } = {},
) {
  const transport =
    dependencies.transport ??
    ((settings: LinkSettings) =>
      createHttpEdgeTransport(new URL("/edge/v1/", settings.siteUrl), {
        Authorization: `Bearer ${settings.bearer}`,
      }));
  const watchdog = dependencies.watchdog ?? Watchdog.layer();
  const heartbeatFlushLayer =
    dependencies.heartbeatFlush ??
    (options.heartbeatFlush
      ? HeartbeatFlush.layer(options.heartbeatFlush)
      : HeartbeatFlush.noop);
  return Layer.effect(
    Machine,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const heartbeatFlush = yield* HeartbeatFlush;
      const connectionLock = yield* Semaphore.make(1);
      let link: Link | undefined;
      yield* Effect.forkIn(
        supervise(
          "watchdog",
          Effect.flatMap(Watchdog, ({ run }) => run).pipe(
            Effect.provide(watchdog),
          ),
          options.log,
          1_000,
        ),
        scope,
      );
      const connect = Effect.fn("Machine.connect")(function* (
        settings: LinkSettings,
      ) {
        if (link && sameLink(link.snapshot.settings, settings)) {
          link.snapshot.settings = settings;
          return;
        }
        if (link) yield* Fiber.interrupt(link.fiber);
        const snapshot = { settings };
        const run = Effect.suspend(() =>
          Effect.scoped(
            runLink(() => snapshot.settings).pipe(
              Effect.provide(
                EdgeClient.layer({ transport: transport(snapshot.settings) }),
              ),
            ),
          ),
        );
        const fiber = yield* Effect.forkIn(
          Effect.interruptible(
            Effect.forever(supervise("link", run, options.log, 30_000)),
          ),
          scope,
        );
        link = { snapshot, fiber };
      });
      return Machine.of({
        connect: (settings) =>
          connectionLock.withPermit(Effect.uninterruptible(connect(settings))),
        ensureSessionHeartbeat: heartbeatFlush.ensureSession,
        stopSessionHeartbeat: heartbeatFlush.stopSession,
        armHeartbeatFlush: heartbeatFlush.arm,
        flushHeartbeats: heartbeatFlush.flushNow,
      });
    }),
  ).pipe(Layer.provide(heartbeatFlushLayer));
}
