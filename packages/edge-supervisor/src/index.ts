import { freemem, totalmem } from "node:os";
import { EDGE_PROTOCOL_VERSION } from "@codecast/edge-contract";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import { Machine, MachineLive, type MachineOptions } from "./machine";

export type MachineConnection = {
  siteUrl: string;
  bearer: string;
  machine: string;
  boot: string;
  liveAgents: number;
  local: boolean;
};

export interface MachineSupervisor {
  connect(connection: MachineConnection, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export async function startMachine(
  options: MachineOptions,
  signal?: AbortSignal,
): Promise<MachineSupervisor> {
  const facade = makeFacade(MachineLive(options));
  try {
    await facade.run(Effect.asVoid(Machine), signal);
  } catch (error) {
    await facade.dispose();
    throw error;
  }
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  return {
    connect: ({ siteUrl, bearer, machine, boot, liveAgents, local }, signal) =>
      facade.run(
        Effect.flatMap(Machine, (service) =>
          service.connect({
            siteUrl,
            bearer,
            hello: {
              machine,
              boot,
              versions: [EDGE_PROTOCOL_VERSION],
              capabilities: ["heartbeat"],
              providers: [],
              runtimes: local ? [{ host: "laptop", isolation: "none" }] : [],
              capacity: {
                memory_total_bytes: totalmem(),
                memory_available_bytes: freemem(),
                live_agents: liveAgents,
              },
            },
          }),
        ),
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      ),
    close: () => {
      lifetime.abort();
      return (closing ??= facade.dispose());
    },
  };
}
