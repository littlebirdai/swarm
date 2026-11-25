import * as Cause from "effect/Cause";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { EdgeClient as EdgeClientService } from "./effect";
import { plainFailure, type EdgeError } from "./failures";
import type {
  EdgeClient,
  EdgeClientOptions,
  EdgeOperation,
  EdgeResult,
} from "./types";

export { EdgeTransportError } from "./types";
export { createHttpEdgeTransport } from "./http-transport";
export type {
  ClaimGrant,
  ClaimLoss,
  EdgeClient,
  EdgeClientOptions,
  EdgeFailure,
  EdgeOperation,
  EdgeRequests,
  EdgeResult,
  EdgeTransport,
} from "./types";

export function createEdgeClient(options: EdgeClientOptions): EdgeClient {
  const facade = makeFacade(EdgeClientService.layer(options));
  const lifetime = new AbortController();
  const closed = Symbol("edge client closed");
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  async function run<A>(
    operation: EdgeOperation,
    call: (client: EdgeClientService["Service"]) => Effect.Effect<A, EdgeError>,
    signal?: AbortSignal,
  ): Promise<EdgeResult<A>> {
    const caller = new Error().stack ?? "";
    const callSignal = signal
      ? AbortSignal.any([lifetime.signal, signal])
      : lifetime.signal;
    const stopped = (): EdgeResult<A> => ({
      ok: false,
      error: {
        kind: callSignal.reason === closed ? "closed" : "aborted",
        operation,
        stack: caller,
      },
    });
    if (callSignal.aborted) return stopped();

    const result = Effect.flatMap(EdgeClientService, call).pipe(
      Effect.matchCauseEffect({
        onSuccess: (value): Effect.Effect<EdgeResult<A>> =>
          Effect.succeed({ ok: true, value }),
        onFailure: (cause): Effect.Effect<EdgeResult<A>, EdgeError> => {
          const found = Cause.findErrorOption(cause);
          if (
            found._tag === "None" ||
            Cause.hasDies(cause) ||
            Cause.hasInterrupts(cause)
          ) {
            return Effect.failCause(cause);
          }
          return Effect.succeed({
            ok: false,
            error: plainFailure(
              found.value,
              `${Cause.pretty(cause)}
${caller}`,
            ),
          });
        },
      }),
    );
    let defect = false;
    const pending = facade.run(
      result.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            defect = Exit.isFailure(exit) && Cause.hasDies(exit.cause);
          }),
        ),
      ),
      callSignal,
    );
    active.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (callSignal.aborted && !defect) return stopped();
      throw error;
    } finally {
      active.delete(pending);
    }
  }

  return {
    hello: (request, signal) =>
      run("hello", (client) => client.hello(request), signal),
    heartbeat: (request, signal) =>
      run("heartbeat", (client) => client.heartbeat(request), signal),
    claim: (request, signal) =>
      run("claim", (client) => client.claim(request), signal),
    renew: (request, signal) =>
      run("renew", (client) => client.renew(request), signal),
    release: (request, signal) =>
      run("release", (client) => client.release(request), signal),
    withClaim: (request, work, signal) =>
      run(
        "claim",
        (client) =>
          client.withClaim(request, (grant) =>
            Effect.suspend(() => {
              const controller = new AbortController();
              const pending = Promise.resolve().then(() =>
                work(grant, controller.signal),
              );
              return Effect.promise(() => pending).pipe(
                Effect.onInterrupt(() =>
                  Effect.promise(async () => {
                    controller.abort();
                    await Promise.allSettled([pending]);
                  }),
                ),
              );
            }),
          ),
        signal,
      ),
    close: () => {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled(active);
        await facade.dispose();
      });
      lifetime.abort(closed);
      return closing;
    },
  };
}
