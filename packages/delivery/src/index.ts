import { SupervisorBus } from "@codecast/edge-supervisor/effect";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import { Delivery } from "./effect";
import { deliveryServiceLayer } from "./service-layer";
import type { DeliveryFacade, DeliveryServiceOptions } from "./types";

export type {
  DeliveryBridge,
  DeliveryBridgeLimits,
  DeliveryFacade,
  DeliveryOptions,
  DeliveryPermit,
  DeliveryReceipt,
  DeliveryServiceOptions,
  DeliverySteerHandover,
  DeliverySteerJournal,
  DeliveryStepOutcome,
  DrainOptions,
  ReceiptJournal,
  SettlementReceiptStatus,
  SteerJournal,
  SteerPermit,
  TakeoverReceiptStatus,
} from "./types";

export function createDeliveryService(
  options: DeliveryServiceOptions = {},
): DeliveryFacade {
  const facade = makeFacade(deliveryServiceLayer(options));
  return {
    deliverNext: (run, drainOptions, signal) =>
      facade.run(
        Effect.flatMap(Delivery, (service) =>
          service.deliverNext(run, drainOptions),
        ),
        signal,
      ),
    drain: (run, drainOptions, signal) =>
      facade.run(
        Effect.flatMap(Delivery, (service) => service.drain(run, drainOptions)),
        signal,
      ),
    publish: (message, signal) =>
      facade.run(
        Effect.flatMap(SupervisorBus, (bus) => bus.publish(message)),
        signal,
      ),
    dispose: () => facade.dispose(),
  };
}
