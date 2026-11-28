import { SupervisorBus } from "@codecast/edge-supervisor/effect";
import * as Layer from "effect/Layer";
import { deliveryBridgeLayer } from "./bridge";
import { Delivery } from "./effect";
import type { DeliveryServiceOptions } from "./types";

export function deliveryServiceLayer(options: DeliveryServiceOptions = {}) {
  const { bridge, bridgeLimits, ...deliveryOptions } = options;
  return Delivery.layer(deliveryOptions).pipe(
    Layer.provideMerge(
      deliveryBridgeLayer(bridge, bridgeLimits).pipe(
        Layer.provideMerge(SupervisorBus.layer),
      ),
    ),
  );
}
