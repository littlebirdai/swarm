import type { RelayOptions } from "@codecast/relay/effect";

export interface ServerConfig extends RelayOptions {
  hostname: string;
  port: number;
  key: Uint8Array;
  previousKey?: Uint8Array;
  drainMs: number;
}

export function readConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const audience = env.RELAY_AUDIENCE;
  if (!audience || !/^[A-Za-z0-9_:-]{1,128}$/u.test(audience)) {
    throw new Error("RELAY_AUDIENCE must be a valid relay ID");
  }
  function readKey(name: string, secret: string): Uint8Array {
    const key = Buffer.from(secret, "base64url");
    if (key.length < 32 || key.toString("base64url") !== secret) {
      throw new Error(
        `${name} must encode at least 32 bytes in unpadded base64url`,
      );
    }
    return key;
  }

  const key = readKey("RELAY_HMAC_KEY", env.RELAY_HMAC_KEY ?? "");
  const previousKey =
    env.RELAY_HMAC_PREVIOUS_KEY === undefined
      ? undefined
      : readKey("RELAY_HMAC_PREVIOUS_KEY", env.RELAY_HMAC_PREVIOUS_KEY);
  const hostname = env.RELAY_HOST ?? "127.0.0.1";
  if (hostname.trim() === "") throw new Error("RELAY_HOST must not be empty");

  function integer(name: string, fallback: number, min: number, max: number) {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (
      !/^\d+$/u.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  }

  return {
    audience,
    key,
    previousKey,
    hostname,
    port: integer("RELAY_PORT", 3100, 0, 65535),
    drainMs: integer("RELAY_DRAIN_MS", 2000, 1, 30000),
    handshakeMs: integer("RELAY_HANDSHAKE_MS", 5000, 1, 30000),
    retryAfterMs: integer("RELAY_RETRY_AFTER_MS", 5000, 0, 60000),
    signalTtlMs: integer("RELAY_SIGNAL_TTL_MS", 15000, 1, 120000),
    queueCapacity: integer("RELAY_QUEUE_CAPACITY", 64, 1, 1024),
    maxConnections: integer("RELAY_MAX_CONNECTIONS", 2048, 1, 10000),
    maxPreAuthConnections: integer(
      "RELAY_MAX_PRE_AUTH_CONNECTIONS",
      128,
      1,
      10000,
    ),
    maxConnectionsPerSubject: integer(
      "RELAY_MAX_CONNECTIONS_PER_SUBJECT",
      8,
      1,
      10000,
    ),
    maxHubs: integer("RELAY_MAX_HUBS", 2048, 1, 10000),
    maxSubscribersPerHub: integer(
      "RELAY_MAX_SUBSCRIBERS_PER_HUB",
      256,
      1,
      10000,
    ),
  };
}
