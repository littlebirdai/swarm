import * as Cause from "effect/Cause";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import { EdgeClient as EdgeClientService } from "./effect";
import { interrupted, plainFailure, type EdgeError } from "./failures";
import type {
  EdgeClient,
  EdgeClientOptions,
  EdgeOperation,
  EdgeResult,
} from "./types";

export { createHttpEdgeTransport } from "./http-transport";
export type {
  ClaimGrant,
  ClaimTiming,
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
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  async function run<A>(
    operation: EdgeOperation,
    call: (client: EdgeClientService["Service"]) => Effect.Effect<A, EdgeError>,
    signal?: AbortSignal,
  ): Promise<EdgeResult<A>> {
    const stopped = () =>
      interrupted(operation, lifetime.signal.aborted ? "closed" : "aborted");
    const callSignal = signal
      ? AbortSignal.any([lifetime.signal, signal])
      : lifetime.signal;
    if (callSignal.aborted) return { ok: false, error: stopped() };

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
            error: plainFailure(found.value, Cause.pretty(cause)),
          });
        },
      }),
    );
    const pending = facade.run(
      Effect.andThen(Effect.yieldNow, result),
      callSignal,
    );
    active.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (callSignal.aborted) {
        return { ok: false, error: stopped() };
      }
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
    withClaim: (request, timing, work, signal) =>
      run(
        "claim",
        (client) =>
          client.withClaim(request, timing, (grant) =>
            Effect.promise((workSignal) => work(grant, workSignal)),
          ),
        signal,
      ),
    close: () => {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled(active);
        await facade.dispose();
      });
      lifetime.abort();
      return closing;
    },
  };
}
