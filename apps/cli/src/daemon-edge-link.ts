import { freemem, totalmem } from "node:os";
import {
  createEdgeClient,
  createHttpEdgeTransport,
  type EdgeClient,
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

type Link = {
  connection: Connection;
  client: EdgeClient | undefined;
  policy?: { revision: number; intervalMs: number };
  nextAt: number;
  failures: number;
  inFlight: boolean;
};

const HELLO_BACKOFF_MS = 30_000;
const MAX_HELLO_BACKOFF_MS = 300_000;
const CLOSE_BOUND_MS = 250;

async function closeClient(client: EdgeClient | undefined): Promise<void> {
  if (!client) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_BOUND_MS);
  });
  try {
    await Promise.race([client.close(), bound]);
  } finally {
    clearTimeout(timer);
  }
}

export function createDaemonEdgeLink() {
  let active: Link | undefined;
  let shutdown: Promise<void> | undefined;

  async function tick(
    connection: Connection,
    capacity: HelloRequest["capacity"],
    runtimes: HelloRequest["runtimes"],
    log: (message: string) => void,
  ): Promise<void> {
    if (shutdown) return;
    try {
      const { siteUrl, bearer, machine, boot } = connection;
      const previous = active?.connection;
      if (
        previous?.siteUrl !== siteUrl ||
        previous.bearer !== bearer ||
        previous.machine !== machine ||
        previous.boot !== boot
      ) {
        void closeClient(active?.client).catch(() => {});
        active = undefined;
        active = {
          connection,
          client: createEdgeClient({
            transport: createHttpEdgeTransport(new URL("/edge/v1/", siteUrl), {
              Authorization: `Bearer ${bearer}`,
            }),
          }),
          nextAt: 0,
          failures: 0,
          inFlight: false,
        };
      }
      const link = active;
      const now = performance.now();
      if (!link?.client || link.inFlight || now < link.nextAt) return;
      link.inFlight = true;
      try {
        let failure: EdgeFailure;
        if (!link.policy) {
          const hello = await link.client.hello({
            machine,
            boot,
            versions: [EDGE_PROTOCOL_VERSION],
            capabilities: ["heartbeat"],
            providers: [],
            runtimes,
            capacity,
          });
          if (hello.ok) {
            const intervalMs = hello.value.policy.heartbeat_interval_ms;
            link.policy = { revision: hello.value.policy.revision, intervalMs };
            link.nextAt = now + intervalMs;
            link.failures = 0;
            return;
          }
          failure = hello.error;
        } else {
          const { revision, intervalMs } = link.policy;
          const steps = Math.floor((now - link.nextAt) / intervalMs) + 1;
          link.nextAt += steps * intervalMs;
          const heartbeat = await link.client.heartbeat({
            v: EDGE_PROTOCOL_VERSION,
            machine,
            boot,
            capacity,
          });
          if (heartbeat.ok) {
            if (heartbeat.value.policy_revision !== revision) {
              link.policy = undefined;
              link.nextAt = now;
            }
            return;
          }
          failure = heartbeat.error;
        }

        if (active !== link || shutdown) return;
        if (failure.kind === "version_rejected") {
          const client = link.client;
          link.client = undefined;
          log(`[EDGE] hello: ${failure.reason} (update required)`);
          await closeClient(client);
          return;
        }
        if (!link.policy) {
          const delay = Math.min(
            MAX_HELLO_BACKOFF_MS,
            HELLO_BACKOFF_MS * 2 ** link.failures++,
          );
          link.nextAt = performance.now() + delay;
        }
        if (
          failure.kind === "unavailable" &&
          failure.retry_after_ms !== undefined
        )
          link.nextAt = Math.max(
            link.nextAt,
            performance.now() + failure.retry_after_ms,
          );
        log(`[EDGE] ${failure.operation}: ${failure.kind}`);
      } catch {
        if (active === link && !shutdown) {
          if (!link.policy)
            link.nextAt = performance.now() + MAX_HELLO_BACKOFF_MS;
          log("[EDGE] Link failed");
        }
      } finally {
        link.inFlight = false;
      }
    } catch {
      log("[EDGE] Link failed");
    }
  }

  return {
    tick,
    close: () => {
      shutdown ??= closeClient(active?.client);
      active = undefined;
      return shutdown;
    },
  };
}

const daemonEdgeLink = createDaemonEdgeLink();

export function reportEdgeHeartbeat(
  connection: Omit<Connection, "machine">,
  liveAgents: number,
  log: (message: string) => void,
): Promise<void> {
  return daemonEdgeLink.tick(
    { ...connection, machine: deviceId() },
    {
      memory_total_bytes: totalmem(),
      memory_available_bytes: freemem(),
      live_agents: liveAgents,
    },
    isRemoteDevice() ? [] : [{ host: "laptop", isolation: "none" }],
    log,
  );
}

export const closeEdgeConnection = daemonEdgeLink.close;
