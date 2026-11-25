import {
  parseRelayClientFrame,
  parseRelayServerFrame,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_GRANTS_PER_TOKEN,
  RELAY_MAX_HUBS_PER_CONNECTION,
  RELAY_PROTOCOL_VERSION as v,
  type RelayClientFrame,
  type RelayHub,
  type RelayServerFrame,
} from "@codecast/relay-contract";
import {
  hubKey,
  MAX_TIMER_MS,
  observations,
  type RelayHandler,
} from "./observations";

export type { RelayEvent, RelayHandler, RelaySignal } from "./observations";
export type RelayPublication = Exclude<
  Extract<RelayClientFrame, { hub: RelayHub }>,
  { type: "subscribe" | "unsubscribe" }
>;

type RelaySocket = {
  readonly bufferedAmount: number;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(
    type: "message",
    handler: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    handler: (event: { code: number }) => void,
  ): void;
  send(text: string): void;
  close(): void;
};

export type RelayClientOptions = {
  getToken(
    hubs: readonly RelayHub[],
    signal: AbortSignal,
  ): Promise<{
    url: string;
    token: string;
    grantedHubs: readonly RelayHub[];
  } | null>;
  WebSocket: new (url: string) => RelaySocket;
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
  random(): number;
};

const CAPABILITIES: RelayPublication["type"][] = [
  "presence",
  "draft_cursor",
  "reading_cursor",
  "baton_heartbeat",
  "session_liveness",
  "machine_liveness",
];
const IDLE_MS = 1000;
const REQUEST_MS = 5000;
const RENEW_MARGIN_MS = 5000;
const MAX_HANDLERS = 1024;
const MAX_QUEUED = RELAY_MAX_HUBS_PER_CONNECTION;
const MAX_BUFFERED_BYTES = RELAY_MAX_FRAME_BYTES * 4;
const PERMANENT_CLOSE = new Set([1002, 1003, 1009]);

type Subscription = {
  hub: RelayHub;
  handlers: Set<RelayHandler>;
  denied: boolean;
  status?: "pending" | "ready";
};

type Grant = { hub: RelayHub; expires: number; renew: number };

export function createRelayClient(options: RelayClientOptions) {
  const { now, setTimer } = options;
  const subscriptions = new Map<string, Subscription>();
  const grants = new Map<string, Grant>();
  const queued = new Map<
    string,
    { signal: RelayPublication; expires: number }
  >();
  const received = observations(now, setTimer, (key, event) => {
    const subscription = subscriptions.get(key);
    if (!subscription) return;
    for (const handler of [...subscription.handlers]) {
      if (event.type === "signal" && subscription.status !== "ready") break;
      if (!subscription.handlers.has(handler)) continue;
      try {
        handler(event);
      } catch {
        continue;
      }
    }
  });
  let handlers = 0;
  let paused = false;
  let closed = false;
  let stopped = false;
  let socket: RelaySocket | undefined;
  let url: string | undefined;
  let capabilities: Set<string> | undefined;
  let healthyAt = Infinity;
  let retryAt = 0;
  let failures = 0;
  let idleAt = Infinity;
  let cancelTimer: (() => void) | undefined;
  let requestId = 0;
  let pending:
    | {
        controller: AbortController;
        deadline: number;
        hubs: Subscription[];
        granted?: Set<string>;
        id?: string;
      }
    | undefined;

  function schedule(at: number) {
    cancelTimer?.();
    cancelTimer = undefined;
    if (Number.isFinite(at)) {
      cancelTimer = setTimer(
        drive,
        Math.min(MAX_TIMER_MS, Math.max(0, at - now())),
      );
    }
  }

  function disconnect() {
    const previous = socket;
    socket = undefined;
    capabilities = undefined;
    grants.clear();
    healthyAt = Infinity;
    const request = pending;
    pending = undefined;
    for (const subscription of subscriptions.values())
      subscription.status = undefined;
    schedule(Infinity);
    previous?.close();
    request?.controller.abort();
    received.clear();
  }

  function retry(minimumMs = 0) {
    if (now() >= healthyAt) failures = 0;
    const ceiling = Math.min(15_000, 500 * 2 ** Math.min(failures++, 5));
    const jitter = ceiling * (0.5 + 0.5 * options.random());
    retryAt = now() + Math.max(minimumMs, jitter);
    disconnect();
    drive();
  }

  function stop() {
    stopped = true;
    queued.clear();
    disconnect();
  }

  function send(frame: RelayClientFrame) {
    const text = JSON.stringify(frame);
    if (
      !socket ||
      socket.bufferedAmount >= MAX_BUFFERED_BYTES ||
      !parseRelayClientFrame(text).ok
    )
      return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  function forgetPublications(key: string) {
    for (const capability of CAPABILITIES)
      queued.delete(`${key}/${capability}`);
  }

  function releaseUnused() {
    const unused = [...grants].filter(([key]) => {
      const subscription = subscriptions.get(key);
      return !subscription || subscription.denied;
    });
    if (unused.length === grants.size && unused.length > 0) {
      disconnect();
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

  function complete(request: NonNullable<typeof pending>, ttl: number) {
    pending = undefined;
    const timestamp = now();
    const revoked = [];
    for (const subscription of request.hubs) {
      const { hub } = subscription;
      const key = hubKey(hub);
      if (request.granted?.has(key)) {
        grants.set(key, {
          hub,
          expires: timestamp + ttl,
          renew:
            timestamp + Math.max(1, ttl - Math.min(ttl / 2, RENEW_MARGIN_MS)),
        });
      } else {
        const current = subscriptions.get(key);
        if (current === subscription) {
          subscription.denied = true;
          subscription.status = undefined;
          forgetPublications(key);
          revoked.push(key);
        }
      }
    }
    for (const key of revoked) received.clear(key);
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
        frame.capabilities.some(
          (name) => !CAPABILITIES.some((offered) => offered === name),
        )
      ) {
        return stop();
      }
      capabilities = new Set(frame.capabilities);
      healthyAt = now() + REQUEST_MS;
      complete(pending, frame.ttl_ms);
      return;
    }
    if (!capabilities) return retry();
    if (frame.type === "grant_result") {
      if (!pending || frame.request_id !== pending.id) return;
      if (frame.status === "applied") return complete(pending, frame.ttl_ms);
      if (frame.status === "refused") {
        if (
          frame.code === "unsupported_grant_version" ||
          frame.code === "subject_mismatch"
        )
          return stop();
        return retry();
      }
      return;
    }
    const key = hubKey(frame.hub);
    const subscription = subscriptions.get(key);
    if (!subscription || subscription.denied) return;
    if (frame.type === "subscription") {
      updateSubscription(key, subscription, frame);
    } else if (
      subscription.status === "ready" &&
      capabilities.has(frame.type)
    ) {
      received.receive(frame);
    }
  }

  function updateSubscription(
    key: string,
    subscription: Subscription,
    frame: Extract<RelayServerFrame, { type: "subscription" }>,
  ) {
    if (frame.status === "subscribed") {
      if (subscription.status !== "pending") return;
      subscription.status = "ready";
      for (const [id, item] of queued) {
        if (hubKey(item.signal.hub) !== key) continue;
        queued.delete(id);
        if (
          item.expires > now() &&
          capabilities?.has(item.signal.type) &&
          !send(item.signal)
        ) {
          queued.set(id, item);
          retry();
          return;
        }
      }
    } else if (frame.status === "unsubscribed" && frame.reason === "expired") {
      grants.delete(key);
      subscription.status = undefined;
      received.clear(key);
      drive();
    } else if (frame.status === "denied") {
      subscription.status = undefined;
      received.clear(key);
    }
  }

  async function requestToken(hubs: Subscription[]) {
    const controller = new AbortController();
    const request: NonNullable<typeof pending> = {
      controller,
      deadline: now() + REQUEST_MS,
      hubs,
    };
    pending = request;
    schedule(Math.min(idleAt, request.deadline));
    try {
      const grant = await options.getToken(
        hubs.map(({ hub }) => hub),
        controller.signal,
      );
      if (pending !== request) return;
      const offered = new Set(
        grant?.grantedHubs.slice(0, RELAY_MAX_GRANTS_PER_TOKEN).map(hubKey),
      );
      request.granted = new Set(
        hubs.map(({ hub }) => hubKey(hub)).filter((key) => offered.has(key)),
      );
      if (!grant || !request.granted.size) return complete(request, 0);
      if (!subscriptions.size) {
        pending = undefined;
        drive();
        return;
      }
      if (socket && url !== grant.url) {
        disconnect();
        drive();
        return;
      }
      if (socket) {
        request.id = String(++requestId);
        if (
          !send({
            v,
            type: "grant_update",
            request_id: request.id,
            token: grant.token,
          })
        )
          retry();
        return;
      }
      url = grant.url;
      let token: string | undefined = grant.token;
      const opened = new options.WebSocket(url);
      socket = opened;
      opened.addEventListener("open", () => {
        const initialToken = token;
        token = undefined;
        if (
          initialToken &&
          socket === opened &&
          !send({
            type: "connect",
            versions: [v],
            capabilities: CAPABILITIES,
            token: initialToken,
          })
        )
          retry();
      });
      opened.addEventListener("message", ({ data }) => {
        if (socket === opened) receive(data);
      });
      opened.addEventListener("close", ({ code }) => {
        if (socket !== opened) return;
        socket = undefined;
        if (PERMANENT_CLOSE.has(code)) stop();
        else retry();
      });
    } catch {
      if (pending === request) retry();
    }
  }

  function drive() {
    if (closed || paused || stopped) return;
    const timestamp = now();
    if (!subscriptions.size) {
      if (idleAt <= timestamp) {
        queued.clear();
        disconnect();
      } else schedule(idleAt);
      return;
    }
    if (retryAt > timestamp) return schedule(retryAt);
    if (pending) {
      if (pending.deadline <= timestamp) retry();
      else schedule(pending.deadline);
      return;
    }
    if (capabilities) releaseUnused();
    if (retryAt > timestamp || closed || paused || stopped) return;
    const due: Subscription[] = [];
    let next = Infinity;
    for (const [key, subscription] of subscriptions) {
      if (subscription.denied) continue;
      const grant = grants.get(key);
      if (!grant || grant.renew <= timestamp) due.push(subscription);
      else next = Math.min(next, grant.renew);
      if (
        !grant ||
        grant.expires <= timestamp ||
        subscription.status ||
        !capabilities
      )
        continue;
      subscription.status = "pending";
      if (!send({ v, type: "subscribe", hub: subscription.hub }))
        return retry();
    }
    if (due.length) void requestToken(due.slice(0, RELAY_MAX_GRANTS_PER_TOKEN));
    else schedule(next);
  }

  return {
    subscribe(hub: RelayHub, handler: RelayHandler): () => void {
      if (closed) throw new Error("Relay client is closed");
      const key = hubKey(hub);
      if (
        !parseRelayClientFrame(JSON.stringify({ v, type: "subscribe", hub })).ok
      ) {
        throw new TypeError("Invalid relay hub");
      }
      let subscription = subscriptions.get(key);
      if (
        handlers >= MAX_HANDLERS ||
        (!subscription && subscriptions.size >= RELAY_MAX_HUBS_PER_CONNECTION)
      ) {
        throw new RangeError("Relay subscription limit reached");
      }
      if (!subscription) {
        subscription = { hub: { ...hub }, handlers: new Set(), denied: false };
        subscriptions.set(key, subscription);
      }
      const own = (event: Parameters<RelayHandler>[0]) => handler(event);
      subscription.handlers.add(own);
      handlers++;
      idleAt = Infinity;
      drive();
      return () => {
        if (!subscription.handlers.delete(own)) return;
        handlers--;
        if (subscription.handlers.size) return;
        subscriptions.delete(key);
        forgetPublications(key);
        received.clear(key);
        if (!subscriptions.size) {
          idleAt = now() + IDLE_MS;
          if (
            subscription.status &&
            !send({ v, type: "unsubscribe", hub: subscription.hub })
          )
            retry();
        }
        drive();
      };
    },
    publish(signal: RelayPublication, ttlMs = 0) {
      const parsed = parseRelayClientFrame(JSON.stringify(signal));
      if (!parsed.ok || closed || stopped) return;
      const frame = parsed.value;
      if (
        !("hub" in frame) ||
        frame.type === "subscribe" ||
        frame.type === "unsubscribe"
      )
        return;
      signal = frame;
      const key = hubKey(signal.hub);
      const subscription = subscriptions.get(key);
      if (!subscription || subscription.denied) return;
      const queueKey = `${key}/${signal.type}`;
      queued.delete(queueKey);
      const canSend =
        subscription.status === "ready" &&
        (grants.get(key)?.expires ?? 0) > now();
      if (canSend && (!capabilities?.has(signal.type) || send(signal))) return;
      const coalesces =
        (signal.type === "presence" && signal.state === "active") ||
        ((signal.type === "draft_cursor" || signal.type === "reading_cursor") &&
          signal.cursor !== null);
      if (coalesces && Number.isFinite(ttlMs) && ttlMs > 0) {
        if (queued.size >= MAX_QUEUED) {
          const oldest = queued.keys().next().value;
          if (oldest !== undefined) queued.delete(oldest);
        }
        queued.set(queueKey, { signal, expires: now() + ttlMs });
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
      for (const subscription of subscriptions.values())
        subscription.denied = false;
      drive();
    },
    close() {
      if (closed) return;
      closed = true;
      stop();
      for (const subscription of subscriptions.values())
        subscription.handlers.clear();
      subscriptions.clear();
      handlers = 0;
    },
  };
}
