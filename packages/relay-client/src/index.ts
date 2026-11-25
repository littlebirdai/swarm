import {
  parseRelayClientFrame,
  parseRelayServerFrame,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_GRANTS_PER_TOKEN,
  RELAY_MAX_HUBS_PER_CONNECTION,
  RELAY_PROTOCOL_VERSION as v,
  type RelayClientFrame,
  type RelayHub,
} from "@codecast/relay-contract";
import { hubKey, observations, type RelayHandler } from "./observations";

export type { RelayEvent, RelayHandler, RelaySignal } from "./observations";
export type RelayPublication = Exclude<
  Extract<RelayClientFrame, { hub: RelayHub }>,
  { type: "subscribe" | "unsubscribe" }
>;

type RelaySocket = {
  readonly bufferedAmount?: number;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(
    type: "message",
    handler: (event: { data?: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    handler: (event: { code?: number }) => void,
  ): void;
  send(text: string): void;
  close(): void;
};

type Omission = {
  id: string;
  kind?: RelayHub["kind"];
  reason: "inaccessible" | "unavailable";
};
type TokenResult =
  | { status: "ok"; url: string; token: string; omitted: readonly Omission[] }
  | { status: "denied"; omitted: readonly Omission[] }
  | {
      status:
        | "unauthenticated"
        | "unavailable"
        | "invalid_hub_count"
        | "rate_limited";
    };

export type RelayClientOptions = {
  getToken(
    hubs: readonly RelayHub[],
    signal: AbortSignal,
  ): Promise<TokenResult>;
  WebSocket: new (url: string) => RelaySocket;
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
  random(): number;
};

const COALESCING = ["presence", "draft_cursor", "reading_cursor"] as const;
const CAPABILITIES = [
  ...COALESCING,
  "baton_heartbeat",
  "session_liveness",
  "machine_liveness",
];
const REQUEST_MS = 5000;
const MAX_HANDLERS = 1024;
const MAX_BUFFERED_BYTES = RELAY_MAX_FRAME_BYTES * 4;

type Subscription = {
  hub: RelayHub;
  handlers: Set<RelayHandler>;
  retryAt: number;
  failures: number;
  status?: "pending" | "ready";
};
type Grant = { hub: RelayHub; expires: number; renew: number };
type Request = {
  controller: AbortController;
  deadline: number;
  hubs: Subscription[];
  granted?: Subscription[];
  id?: string;
};

export function createRelayClient(options: RelayClientOptions) {
  const subscriptions = new Map<string, Subscription>();
  const grants = new Map<string, Grant>();
  const queued = new Map<string, { wire: string; expires: number }>();
  const received = observations((key, event) => {
    const sub = subscriptions.get(key);
    if (!sub) return;
    for (const handler of [...sub.handlers]) {
      if (event.type === "signal" && sub.status !== "ready") break;
      if (!sub.handlers.has(handler)) continue;
      try {
        handler(event);
      } catch {
        continue;
      }
    }
  });
  let time = -Infinity;
  const now = () => (time = Math.max(time, options.now()));
  let handlers = 0;
  let paused = false;
  let closed = false;
  let stopped = false;
  let socket: RelaySocket | undefined;
  let url: string | undefined;
  let capabilities: Set<string> | undefined;
  let healthyAt = Infinity;
  let retryAt = -Infinity;
  let failures = 0;
  let wakeAt = Infinity;
  let cancelTimer: (() => void) | undefined;
  let requestId = 0;
  let pending: Request | undefined;

  function schedule(at = wakeAt) {
    wakeAt = at;
    cancelTimer?.();
    cancelTimer = undefined;
    const deadline = Math.min(at, received.deadline);
    if (Number.isFinite(deadline)) {
      cancelTimer = options.setTimer(
        drive,
        Math.max(0, Math.min(2_147_483_647, deadline - now())),
      );
    }
  }

  function disconnect() {
    const previous = socket;
    const request = pending;
    socket = capabilities = pending = undefined;
    healthyAt = Infinity;
    grants.clear();
    for (const sub of subscriptions.values()) sub.status = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
    wakeAt = Infinity;
    request?.controller.abort();
    received.clear();
    try {
      previous?.close();
    } catch {
      return;
    }
  }

  function delay(attempt: number) {
    return (
      Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) *
      (0.5 + options.random() * 0.5)
    );
  }

  function retry(minimumMs = 0) {
    if (now() >= healthyAt) failures = 0;
    retryAt = now() + Math.max(minimumMs, delay(failures++));
    disconnect();
    drive();
  }

  function stop() {
    stopped = true;
    queued.clear();
    disconnect();
  }

  function write(wire: string) {
    if (!socket || (socket.bufferedAmount ?? 0) >= MAX_BUFFERED_BYTES)
      return false;
    try {
      socket.send(wire);
      return true;
    } catch {
      return false;
    }
  }

  function send(frame: RelayClientFrame) {
    const wire = JSON.stringify(frame);
    if (
      (frame.type === "connect" || frame.type === "grant_update") &&
      !parseRelayClientFrame(wire).ok
    )
      return false;
    return write(wire);
  }

  function clearQueued(key: string) {
    for (const type of COALESCING) queued.delete(`${key}/${type}`);
  }

  function flush(key: string) {
    for (const type of COALESCING) {
      const id = `${key}/${type}`;
      const item = queued.get(id);
      if (!item) continue;
      if (
        item.expires > now() &&
        capabilities?.has(type) &&
        !write(item.wire)
      ) {
        retry();
        return;
      }
      queued.delete(id);
    }
  }

  function releaseUnused(keepLast: boolean) {
    const unused = [...grants].filter(([key]) => {
      const sub = subscriptions.get(key);
      return !sub || sub.retryAt === Infinity;
    });
    if (unused.length === grants.size && unused.length) {
      if (!keepLast) disconnect();
      return;
    }
    for (
      let index = 0;
      index < unused.length;
      index += RELAY_MAX_GRANTS_PER_TOKEN
    ) {
      const batch = unused.slice(index, index + RELAY_MAX_GRANTS_PER_TOKEN);
      if (
        !send({
          v,
          type: "grant_release",
          request_id: String(++requestId),
          hubs: batch.map(([, grant]) => grant.hub),
        })
      ) {
        retry();
        return;
      }
      for (const [key] of batch) grants.delete(key);
    }
  }

  function defer(sub: Subscription) {
    sub.retryAt = now() + delay(sub.failures++);
  }

  function failBatch(request: Request) {
    pending = undefined;
    for (const sub of request.hubs) defer(sub);
    request.controller.abort();
    drive();
  }

  function complete(request: Request, ttl: number) {
    pending = undefined;
    const expires = now() + ttl;
    const renew = expires - Math.min(ttl - 1, ttl / 2, 5000);
    for (const sub of request.granted ?? []) {
      const key = hubKey(sub.hub);
      grants.set(key, { hub: sub.hub, expires, renew });
      if (subscriptions.get(key) === sub && sub.status === "ready") {
        sub.failures = 0;
        sub.retryAt = -Infinity;
        flush(key);
        if (!socket) return;
      }
    }
    drive();
  }

  function receive(input: unknown) {
    const parsed = parseRelayServerFrame(input);
    if (!parsed.ok) {
      if (!capabilities) retry();
      return;
    }
    const frame = parsed.value;
    if (frame.type === "hello") {
      if (frame.status === "unavailable") return retry(frame.retry_after_ms);
      if (frame.status === "unauthorized") return retry();
      if (frame.status === "incompatible_version") return stop();
      if (
        capabilities ||
        !pending ||
        frame.version !== v ||
        frame.capabilities.some((name) => !CAPABILITIES.includes(name))
      )
        return stop();
      capabilities = new Set(frame.capabilities);
      healthyAt = now() + REQUEST_MS;
      return complete(pending, frame.ttl_ms);
    }
    if (!capabilities) return retry();
    if (frame.type === "grant_result") {
      if (!pending || frame.request_id !== pending.id) return;
      if (frame.status === "applied") return complete(pending, frame.ttl_ms);
      if (frame.status !== "refused") return;
      if (
        ["unsupported_grant_version", "subject_mismatch"].includes(frame.code)
      )
        return stop();
      return retry();
    }
    const key = hubKey(frame.hub);
    const sub = subscriptions.get(key);
    if (!sub || sub.retryAt === Infinity) return;
    if (frame.type !== "subscription") {
      if (sub.status === "ready" && capabilities.has(frame.type)) {
        received.receive(frame, now());
        schedule();
      }
      return;
    }
    if (frame.status === "subscribed" && sub.status === "pending") {
      sub.status = "ready";
      sub.failures = 0;
      sub.retryAt = -Infinity;
      flush(key);
    } else if (
      frame.status === "denied" ||
      (frame.status === "unsubscribed" && frame.reason === "expired")
    ) {
      if (frame.status === "denied") defer(sub);
      else grants.delete(key);
      sub.status = undefined;
      received.clear(key);
    }
    drive();
  }

  async function requestToken(hubs: Subscription[], next: number) {
    const controller = new AbortController();
    const request: Request = { controller, deadline: now() + REQUEST_MS, hubs };
    pending = request;
    schedule(Math.min(next, request.deadline));
    let result: TokenResult;
    try {
      result = await options.getToken(
        hubs.map(({ hub }) => hub),
        controller.signal,
      );
    } catch {
      if (pending === request) failBatch(request);
      return;
    }
    if (pending !== request) return;
    if (result.status !== "ok" && result.status !== "denied")
      return failBatch(request);
    const granted: Subscription[] = [];
    const revoked: string[] = [];
    for (const sub of hubs) {
      const key = hubKey(sub.hub);
      const omission = result.omitted.find(
        ({ id, kind }) =>
          id === sub.hub.id && (kind ?? "session") === sub.hub.kind,
      );
      if (omission?.reason === "inaccessible") {
        if (subscriptions.get(key) !== sub) continue;
        sub.retryAt = Infinity;
        sub.status = undefined;
        clearQueued(key);
        revoked.push(key);
      } else if (omission || result.status === "denied") defer(sub);
      else granted.push(sub);
    }
    for (const key of revoked) received.clear(key);
    if (pending !== request) return;
    if (
      result.status !== "ok" ||
      !granted.some((sub) => subscriptions.has(hubKey(sub.hub)))
    ) {
      pending = undefined;
      drive();
      return;
    }
    if (socket && url !== result.url) return retry();
    request.granted = granted;
    request.deadline = now() + REQUEST_MS;
    if (socket) {
      request.id = String(++requestId);
      if (
        !send({
          v,
          type: "grant_update",
          request_id: request.id,
          token: result.token,
        })
      )
        return retry();
      drive();
      return;
    }
    try {
      url = result.url;
      const opened = new options.WebSocket(url);
      socket = opened;
      let connect: RelayClientFrame | undefined = {
        type: "connect",
        versions: [v],
        capabilities: CAPABILITIES,
        token: result.token,
      };
      opened.addEventListener("open", () => {
        if (socket === opened && connect && !send(connect)) retry();
        connect = undefined;
      });
      opened.addEventListener("message", ({ data }) => {
        if (socket === opened) receive(data);
      });
      opened.addEventListener("close", ({ code }) => {
        if (socket !== opened) return;
        socket = undefined;
        if (code === 1002 || code === 1003 || code === 1009) stop();
        else retry();
      });
      drive();
    } catch {
      if (pending === request) retry();
    }
  }

  function drive() {
    if (paused || stopped || !subscriptions.size) return;
    const timestamp = now();
    received.expire(timestamp);
    if (paused || stopped || !subscriptions.size) return;
    if (retryAt > timestamp) return schedule(retryAt);
    if (pending && pending.deadline <= timestamp) {
      if (pending.granted) retry();
      else failBatch(pending);
      return;
    }
    const due: Subscription[] = [];
    let next = pending?.deadline ?? Infinity;
    for (const [key, sub] of subscriptions) {
      if (sub.retryAt > timestamp) {
        next = Math.min(next, sub.retryAt);
        continue;
      }
      const grant = grants.get(key);
      if (!grant || grant.renew <= timestamp) due.push(sub);
      else next = Math.min(next, grant.renew);
      if (!capabilities || sub.status || !grant || grant.expires <= timestamp)
        continue;
      sub.status = "pending";
      if (!send({ v, type: "subscribe", hub: sub.hub })) return retry();
    }
    if (capabilities) releaseUnused(Boolean(pending || due.length));
    if (retryAt > timestamp) return;
    if (!pending && due.length)
      void requestToken(due.slice(0, RELAY_MAX_GRANTS_PER_TOKEN), next);
    else schedule(next);
  }

  return {
    subscribe(hub: RelayHub, handler: RelayHandler): () => void {
      if (closed) throw new Error("Relay client is closed");
      const key = hubKey(hub);
      if (
        !parseRelayClientFrame(JSON.stringify({ v, type: "subscribe", hub })).ok
      )
        throw new TypeError("Invalid relay hub");
      let sub = subscriptions.get(key);
      if (
        handlers >= MAX_HANDLERS ||
        (!sub && subscriptions.size >= RELAY_MAX_HUBS_PER_CONNECTION)
      )
        throw new RangeError("Relay subscription limit reached");
      if (!sub) {
        sub = {
          hub: { ...hub },
          handlers: new Set(),
          retryAt: -Infinity,
          failures: 0,
        };
        subscriptions.set(key, sub);
      }
      const own: RelayHandler = (event) => handler(event);
      sub.handlers.add(own);
      handlers++;
      drive();
      return () => {
        if (!sub.handlers.delete(own)) return;
        handlers--;
        if (sub.handlers.size) return;
        subscriptions.delete(key);
        clearQueued(key);
        received.clear(key);
        if (sub.status && !send({ v, type: "unsubscribe", hub: sub.hub }))
          retry();
        if (subscriptions.size) drive();
        else
          queueMicrotask(() => {
            if (!subscriptions.size) disconnect();
          });
      };
    },
    publish(signal: RelayPublication, ttlMs = 0) {
      if (closed || stopped) return;
      const wire = JSON.stringify(signal);
      const parsed = parseRelayClientFrame(wire);
      if (!parsed.ok) return;
      const frame = parsed.value;
      if (
        !("hub" in frame) ||
        frame.type === "subscribe" ||
        frame.type === "unsubscribe"
      )
        return;
      const key = hubKey(frame.hub);
      const sub = subscriptions.get(key);
      if (!sub || sub.retryAt === Infinity) return;
      const id = `${key}/${frame.type}`;
      queued.delete(id);
      const canSend =
        sub.status === "ready" &&
        (grants.get(key)?.expires ?? -Infinity) > now();
      if (canSend && (!capabilities?.has(frame.type) || write(wire))) return;
      const coalesces =
        (frame.type === "presence" && frame.state === "active") ||
        ((frame.type === "draft_cursor" || frame.type === "reading_cursor") &&
          frame.cursor !== null);
      if (coalesces && Number.isFinite(ttlMs) && ttlMs > 0) {
        if (queued.size >= RELAY_MAX_HUBS_PER_CONNECTION) {
          const oldest = queued.keys().next().value;
          if (oldest !== undefined) queued.delete(oldest);
        }
        queued.set(id, { wire, expires: now() + ttlMs });
      }
      if (canSend) retry();
    },
    pause() {
      paused = true;
      disconnect();
    },
    resume() {
      if (!paused) return;
      paused = false;
      drive();
    },
    close() {
      if (closed) return;
      closed = true;
      stop();
      for (const sub of subscriptions.values()) sub.handlers.clear();
      subscriptions.clear();
      handlers = 0;
    },
  };
}
