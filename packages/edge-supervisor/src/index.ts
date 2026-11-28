import { freemem, totalmem } from "node:os";
import { EDGE_PROTOCOL_VERSION } from "@codecast/edge-contract";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import { Machine, MachineLive, type MachineOptions } from "./machine";

export type {
  BusMessage,
  BusMessageKind,
  BusMessageOf,
  DeliveryReceipt,
  EdgeBlobResult,
  EdgeBusResult,
  ProviderDeliverInput,
  ProviderDeliverOutcome,
  ProviderRecoverOutcome,
} from "./bus-types";
export type { EdgeBlobFetcher } from "./edge-link-bus";
export type { HandlerLimits } from "./handler-pool";
export type {
  HeartbeatBatchSender,
  HeartbeatFlushHost,
  HeartbeatLogEntry,
  HeartbeatSessionPayload,
} from "./heartbeat-flush";
export type { MachineOptions } from "./machine";

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
  ensureSessionHeartbeat(
    sessionId: string,
    source?: "transcript",
  ): Promise<void>;
  stopSessionHeartbeat(sessionId: string | undefined): Promise<void>;
  armHeartbeatFlush(): Promise<void>;
  flushHeartbeats(): Promise<void>;
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
  let membershipChain: Promise<void> = Promise.resolve();
  const serializeMembership = (fn: () => Promise<void>): Promise<void> => {
    const next = membershipChain.then(fn, fn);
    membershipChain = next.catch(() => {});
    return next;
  };
  const runSignal = (callerSignal?: AbortSignal) =>
    callerSignal
      ? AbortSignal.any([callerSignal, lifetime.signal])
      : lifetime.signal;
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
        runSignal(signal),
      ),
    ensureSessionHeartbeat: (sessionId, source) =>
      serializeMembership(() =>
        facade.run(
          Effect.flatMap(Machine, (service) =>
            service.ensureSessionHeartbeat(sessionId, source),
          ),
          lifetime.signal,
        ),
      ),
    stopSessionHeartbeat: (sessionId) =>
      serializeMembership(() =>
        facade.run(
          Effect.flatMap(Machine, (service) =>
            service.stopSessionHeartbeat(sessionId),
          ),
          lifetime.signal,
        ),
      ),
    armHeartbeatFlush: () =>
      serializeMembership(() =>
        facade.run(
          Effect.flatMap(Machine, (service) => service.armHeartbeatFlush()),
          lifetime.signal,
        ),
      ),
    flushHeartbeats: () =>
      facade.run(
        Effect.flatMap(Machine, (service) => service.flushHeartbeats()),
        lifetime.signal,
      ),
    close: () => {
      lifetime.abort();
      return (closing ??= facade.dispose());
    },
  };
}
