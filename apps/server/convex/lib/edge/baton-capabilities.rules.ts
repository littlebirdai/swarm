import type { Doc } from "../../_generated/dataModel";

type Binding = Pick<
  Doc<"execution_bindings">,
  "capabilities" | "edge_capabilities"
>;
type Capability = NonNullable<Binding["edge_capabilities"]>[number];

export function steerBatonEnabled() {
  return (
    process.env.CODECAST_EDGE_DELIVERY_V1 === "1" &&
    process.env.SWARM_TURN_BATON === "1"
  );
}

export function bindingHasBatonCapability(
  binding: Binding | null | undefined,
  capability: Capability,
) {
  return (
    (binding?.edge_capabilities ?? binding?.capabilities)?.includes(
      capability,
    ) === true
  );
}
