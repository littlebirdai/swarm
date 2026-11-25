import { freemem, totalmem } from "node:os";
import {
  createEdgeClient,
  createHttpEdgeTransport,
  type EdgeFailure,
} from "@codecast/edge-client";
import {
  EDGE_PROTOCOL_VERSION,
  type HelloRequest,
} from "@codecast/edge-contract";

import { deviceId, isRemoteDevice } from "./remote/device.js";

type Connection = {
  siteUrl: string;
  bearer: string;
  machine: string;
  boot: string;
};

let negotiated:
  | (Connection & { revision: number; intervalMs: number; heartbeatAt: number })
  | undefined;
let inFlight = false;

export async function sendDaemonEdgeHeartbeat(
  connection: Connection,
  capacity: HelloRequest["capacity"],
  runtimes: HelloRequest["runtimes"],
): Promise<EdgeFailure | undefined> {
  if (inFlight) return;
  inFlight = true;
  try {
    const { siteUrl, bearer, machine, boot } = connection;
    if (
      negotiated?.siteUrl !== siteUrl ||
      negotiated.bearer !== bearer ||
      negotiated.machine !== machine ||
      negotiated.boot !== boot
    ) {
      negotiated = undefined;
    }
    const startedAt = performance.now();
    if (negotiated && startedAt < negotiated.heartbeatAt) return;
    const client = createEdgeClient({
      transport: createHttpEdgeTransport(new URL("/edge/v1/", siteUrl), {
        Authorization: `Bearer ${bearer}`,
      }),
    });
    try {
      if (!negotiated) {
        const hello = await client.hello({
          machine,
          boot,
          versions: [EDGE_PROTOCOL_VERSION],
          capabilities: ["heartbeat"],
          providers: [],
          runtimes,
          capacity,
        });
        if (!hello.ok) return hello.error;
        negotiated = {
          ...connection,
          revision: hello.value.policy.revision,
          intervalMs: hello.value.policy.heartbeat_interval_ms,
          heartbeatAt: startedAt + hello.value.policy.heartbeat_interval_ms,
        };
        return;
      }
      negotiated.heartbeatAt = startedAt + negotiated.intervalMs;
      const heartbeat = await client.heartbeat({
        v: EDGE_PROTOCOL_VERSION,
        machine,
        boot,
        capacity,
      });
      if (!heartbeat.ok) return heartbeat.error;
      if (heartbeat.value.policy_revision !== negotiated.revision)
        negotiated = undefined;
    } finally {
      await client.close();
    }
  } finally {
    inFlight = false;
  }
}

export async function reportEdgeHeartbeat(
  connection: Omit<Connection, "machine">,
  liveAgents: number,
  log: (message: string) => void,
): Promise<void> {
  const error = await sendDaemonEdgeHeartbeat(
    { ...connection, machine: deviceId() },
    {
      memory_total_bytes: totalmem(),
      memory_available_bytes: freemem(),
      live_agents: liveAgents,
    },
    isRemoteDevice() ? [] : [{ host: "laptop", isolation: "none" }],
  );
  if (error) {
    const detail =
      error.kind === "version_rejected" ? error.reason : error.kind;
    log(`[EDGE] ${error.operation}: ${detail}`);
  }
}
