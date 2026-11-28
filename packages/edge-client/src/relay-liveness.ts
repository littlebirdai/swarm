import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import {
  makeRelayLiveness,
  type RelayLivenessOptions,
  type RunLease,
  type TokenDelta,
} from "./relay-liveness-layer";

export type { RelayLivenessOptions, RunLease, TokenDelta };

export function startRelayLiveness(
  options: RelayLivenessOptions,
  signal: AbortSignal,
  initial: readonly RunLease[],
) {
  const { layer, update, publishDelta } = makeRelayLiveness(options, initial);
  const facade = makeFacade(layer);
  const running = facade
    .run(Effect.never, signal)
    .finally(() => facade.dispose());
  return { update, publishDelta, running };
}
