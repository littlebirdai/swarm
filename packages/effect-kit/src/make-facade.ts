import { interrupt, pretty, squash } from "effect/Cause";
import { failCause, suspend, type Effect } from "effect/Effect";
import type { Layer } from "effect/Layer";
import { make } from "effect/ManagedRuntime";

export function makeFacade<Services, LayerError>(
  layer: Layer<Services, LayerError>,
) {
  const runtime = make(layer);
  return {
    async run<A, E>(
      effect: Effect<A, E, Services>,
      signal?: AbortSignal,
    ): Promise<A> {
      if (signal?.aborted) throw squash(interrupt());
      const exit = await runtime.runPromiseExit(
        suspend(() => (signal?.aborted ? failCause(interrupt()) : effect)),
        { signal },
      );
      if (exit._tag === "Success") return exit.value;
      const error = squash(exit.cause);
      if (error instanceof Error) {
        try {
          const stack = pretty(exit.cause);
          error.stack = error.stack ? `${error.stack}\n\n${stack}` : stack;
        } catch {}
      }
      throw error;
    },
    dispose: runtime.dispose,
  };
}
