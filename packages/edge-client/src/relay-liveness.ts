import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import {
  makeRelayLiveness,
  type RelayLivenessOptions,
  type RunLease,
} from "./relay-liveness-layer";

export function startRelayLiveness(
  options: RelayLivenessOptions,
  signal: AbortSignal,
  initial: readonly RunLease[],
) {
  const { layer, update } = makeRelayLiveness(options, initial);
  const facade = makeFacade(layer);
  const running = facade
    .run(Effect.never, signal)
    .finally(() => facade.dispose());
  return { update, running };
}
