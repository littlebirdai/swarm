import type { PermitsNextRequest } from "@codecast/edge-contract";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { DeliveryError } from "./journals";
import type { DeliveryStepOutcome, DrainOptions } from "./types";

const MAX_PENDING_WAKES = 1024;

type DrainEntry = {
  readonly run: PermitsNextRequest;
  readonly drainOptions: DrainOptions;
  fiber?: Fiber.Fiber<DeliveryStepOutcome>;
};

type PendingWake = {
  readonly run: PermitsNextRequest;
  readonly drainOptions: DrainOptions;
};

function mergeDrainOptions(
  earlier: DrainOptions | undefined,
  later: DrainOptions,
): DrainOptions {
  if (!earlier || earlier.sendNew === false) return later;
  return later.sendNew === false ? earlier : later;
}

export function makeWakeScheduler(deps: {
  readonly scope: Scope.Scope;
  readonly maxActiveDrains: number;
  readonly drain: (
    run: PermitsNextRequest,
    drainOptions: DrainOptions,
  ) => Effect.Effect<DeliveryStepOutcome, DeliveryError>;
  readonly onSlotFree?: () => Effect.Effect<void>;
  readonly log?: (message: string) => void;
}) {
  const { scope, maxActiveDrains, drain, log } = deps;
  const activeDrains = new Map<string, DrainEntry>();
  const pendingWakes = new Map<string, PendingWake>();

  const startNextPending: Effect.Effect<void> = Effect.suspend(() => {
    if (activeDrains.size >= maxActiveDrains) return Effect.void;
    const next = pendingWakes.values().next();
    if (!next.done) {
      pendingWakes.delete(next.value.run.session);
      return start(next.value.run, next.value.drainOptions).pipe(
        Effect.andThen(deps.onSlotFree?.() ?? Effect.void),
      );
    }
    return deps.onSlotFree?.() ?? Effect.void;
  });

  const start = (
    run: PermitsNextRequest,
    drainOptions: DrainOptions,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const previous = activeDrains.get(run.session);
      if (previous?.fiber) {
        yield* Effect.forkIn(Fiber.interrupt(previous.fiber), scope);
      }
      const options =
        previous?.run.run === run.run
          ? mergeDrainOptions(previous.drainOptions, drainOptions)
          : drainOptions;
      const entry: DrainEntry = { run, drainOptions: options };
      activeDrains.set(run.session, entry);
      entry.fiber = yield* Effect.forkIn(
        drain(run, options).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log?.(
                `[delivery] drain failed for ${run.session}: ${error.code}`,
              );
            }).pipe(Effect.as({ status: "empty" } as DeliveryStepOutcome)),
          ),
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (activeDrains.get(run.session) !== entry) return Effect.void;
              activeDrains.delete(run.session);
              return Exit.hasInterrupts(exit) ? Effect.void : startNextPending;
            }),
          ),
        ),
        scope,
        { startImmediately: true },
      );
    });

  const wake = (
    run: PermitsNextRequest,
    drainOptions: DrainOptions,
  ): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const queued = pendingWakes.get(run.session);
      if (queued) {
        if (run.run < queued.run.run) return Effect.succeed(true);
        pendingWakes.set(run.session, {
          run,
          drainOptions:
            run.run === queued.run.run
              ? mergeDrainOptions(queued.drainOptions, drainOptions)
              : drainOptions,
        });
        return Effect.succeed(true);
      }
      const active = activeDrains.get(run.session);
      if (active && run.run < active.run.run) return Effect.succeed(true);
      if (
        activeDrains.has(run.session) ||
        activeDrains.size < maxActiveDrains
      ) {
        return start(run, drainOptions).pipe(Effect.as(true));
      }
      if (pendingWakes.size < MAX_PENDING_WAKES) {
        pendingWakes.set(run.session, { run, drainOptions });
        return Effect.succeed(true);
      }
      log?.(`[delivery] wake dropped for ${run.session}: too many wakes`);
      return Effect.succeed(false);
    });

  const stop = (session: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const unqueued = pendingWakes.delete(session);
      const fiber = activeDrains.get(session)?.fiber;
      if (!fiber) {
        return unqueued ? (deps.onSlotFree?.() ?? Effect.void) : Effect.void;
      }
      return Effect.forkIn(
        Fiber.interrupt(fiber).pipe(Effect.andThen(startNextPending)),
        scope,
      ).pipe(Effect.asVoid);
    });

  return { wake, stop };
}
