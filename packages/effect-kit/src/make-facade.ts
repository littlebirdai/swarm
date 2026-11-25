import { interrupt, squash } from "effect/Cause";
import type { Effect } from "effect/Effect";
import type { Layer } from "effect/Layer";
import { make } from "effect/ManagedRuntime";

export function makeFacade<Services, LayerError>(
  layer: Layer<Services, LayerError>,
) {
  const runtime = make(layer);
  return {
    run<A, E>(
      effect: Effect<A, E, Services>,
      signal?: AbortSignal,
    ): Promise<A> {
      if (signal?.aborted) return Promise.reject(squash(interrupt()));
      return runtime.runPromise(effect, { signal });
    },
    dispose: runtime.dispose,
  };
}
