import {
  applyRelayGrantClaims,
  negotiateRelayVersion,
  parseRelayClientFrame,
  parseRelayGrantClaims,
  releaseRelayGrants,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUPPORTED_VERSIONS,
  type RelayClientFrame,
  type RelayGrantClaims,
  type RelayGrantState,
  type RelayHub,
  type RelayHubGrant,
  type RelayServerFrame,
} from "@codecast/relay-contract";
import { Clock } from "effect/Clock";
import { Service } from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { PreventSchedulerYield } from "effect/References";
import * as Scope from "effect/Scope";
import { HubRegistry, hubKey, type HubSubscription, type Signal } from "./hubs";
import { Outbox } from "./outbox";

type Control = Exclude<RelayServerFrame, Signal>;
type ClientSignal = Extract<RelayClientFrame, { type: Signal["type"] }>;

const capabilities = [
  "presence",
  "draft_cursor",
  "reading_cursor",
  "baton_heartbeat",
  "session_liveness",
  "machine_liveness",
] as const;

const version = RELAY_PROTOCOL_VERSION;

export interface RelaySocket {
  send: (text: string) => "sent" | "paused" | "closed";
  close: (code: number) => void;
  terminate: () => void;
}

export interface RelayConnection {
  receive: (message: unknown) => Effect.Effect<void>;
  writable: Effect.Effect<void>;
  disconnected: Effect.Effect<void>;
}

export interface RelayOptions {
  audience: string;
  signalTtlMs: number;
  handshakeMs: number;
  retryAfterMs: number;
  queueCapacity: number;
  maxConnections: number;
  maxHubs: number;
  maxSubscribersPerHub: number;
}

export class TokenVerifier extends Service<
  TokenVerifier,
  { verify: (token: string) => string | null }
>()("@codecast/relay/TokenVerifier") {}

export class Relay extends Service<
  Relay,
  {
    open: (socket: RelaySocket) => Effect.Effect<RelayConnection | null>;
    drain: Effect.Effect<void>;
    isDraining: Effect.Effect<boolean>;
  }
>()("@codecast/relay/Relay") {
  static layer(options: RelayOptions) {
    return Layer.effect(Relay, makeRelay(options)).pipe(
      Layer.provide(
        HubRegistry.layer(options.maxHubs, options.maxSubscribersPerHub),
      ),
    );
  }
}

type Permission = { grant: RelayHubGrant | null };

type Membership = {
  hub: RelayHub;
  subscription: HubSubscription;
  active: boolean;
  grant: RelayHubGrant | null;
  permissions: Map<string, Permission>;
};

function updateMembership(
  member: Membership,
  grant: RelayHubGrant | null,
): void {
  member.grant = grant;
  const rights: readonly string[] = grant?.publish ?? [];
  for (const [type, permission] of member.permissions) {
    permission.grant = rights.includes(type) ? grant : null;
    if (!permission.grant) member.permissions.delete(type);
  }
  for (const type of rights) {
    if (!member.permissions.has(type)) member.permissions.set(type, { grant });
  }
}

function makeRelay(options: RelayOptions) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const clock = yield* Clock;
    const registry = yield* HubRegistry;
    const verifier = yield* TokenVerifier;
    const wake = yield* Queue.sliding<void>(1);
    const connections = new Map<
      string,
      {
        deadline: () => number;
        expire: (now: number) => Effect.Effect<void>;
        drain: Effect.Effect<void>;
      }
    >();
    let draining = false;

    const unavailable = {
      type: "hello",
      status: "unavailable",
      retry_after_ms: options.retryAfterMs,
    } as const;

    function verify(token: string) {
      const payload = verifier.verify(token);
      const parsed = parseRelayGrantClaims(payload);
      if (!parsed.ok) {
        return parsed.error.code === "unsupported_version"
          ? "unsupported_grant_version"
          : "invalid_token";
      }
      return parsed.value.audience === options.audience
        ? parsed.value
        : "invalid_token";
    }

    const inSocketOrder = Effect.provideService(PreventSchedulerYield, true);

    const open = Effect.fn("Relay.open")(function* (socket: RelaySocket) {
      if (draining || connections.size >= options.maxConnections) {
        socket.send(JSON.stringify(unavailable));
        socket.close(1013);
        return null;
      }
      const connectionScope = yield* Scope.fork(scope);
      const connectionId = crypto.randomUUID();
      const outbox = new Outbox(options.queueCapacity);
      const memberships = new Map<string, Membership>();
      const enabled = new Set<string>();
      let subject: RelayGrantClaims["subject"] | undefined;
      let state: RelayGrantState = { grants: [], high_water: null };
      let expiresAt = clock.currentTimeMillisUnsafe() + options.handshakeMs;
      let closeCode: number | undefined;
      let paused = false;
      let transportFailed = false;
      let closed = false;
      let seq = 0;

      const setDeadline = (deadline: number) => {
        expiresAt = deadline;
        Queue.offerUnsafe(wake, undefined);
      };

      function nextGrantDeadline() {
        return state.grants.reduce(
          (earliest, grant) => Math.min(earliest, grant.expires_at_ms),
          Infinity,
        );
      }

      const depart = Effect.fn("Relay.depart")(function* (member: Membership) {
        if (
          !member.active ||
          member.hub.kind !== "session" ||
          subject?.kind !== "user"
        )
          return;
        member.active = false;
        yield* member.subscription.publish({
          frame: {
            type: "presence",
            v: version,
            hub: member.hub,
            state: "left",
            in_draft: false,
            user_id: subject.id,
            connection_id: connectionId,
            seq: ++seq,
            ttl_ms: 0,
          },
          sourceTtl: () => 0,
        });
      });

      const detach = Effect.fn("Relay.detach")(function* (member: Membership) {
        memberships.delete(hubKey(member.hub));
        updateMembership(member, null);
        yield* depart(member);
        yield* member.subscription.close;
      });

      const end = Effect.fn("Relay.end")(function* (code?: number) {
        if (closed) return;
        closed = true;
        outbox.clear();
        for (const member of memberships.values()) yield* detach(member);
        yield* Scope.close(connectionScope, Exit.succeed(undefined));
        if (code !== undefined) socket.close(code);
      });

      const flush = Effect.fn("Relay.flush")(function* () {
        while (!closed && !paused) {
          const pending = outbox.take();
          if (!pending) {
            if (closeCode !== undefined) yield* end(closeCode);
            return;
          }
          const now = clock.currentTimeMillisUnsafe();
          let frame: RelayServerFrame;
          if ("publication" in pending) {
            const { publication, recipientTtl } = pending;
            const recipient = recipientTtl(now);
            if (!(recipient > 0)) continue;
            const ttl = Math.floor(
              Math.min(
                recipient,
                publication.sourceTtl(now, clock.monotonicTimeNanosUnsafe()),
              ),
            );
            if (publication.frame.ttl_ms > 0 && !(ttl > 0)) continue;
            frame = { ...publication.frame, ttl_ms: ttl } as Signal;
          } else {
            frame = pending.control;
            if (pending.expiresAt !== undefined) {
              const ttl = Math.floor(pending.expiresAt - now);
              if (frame.type === "hello" && frame.status === "ok") {
                if (ttl <= 0) {
                  socket.send(
                    JSON.stringify({ type: "hello", status: "unauthorized" }),
                  );
                  yield* end(1008);
                  return;
                }
                frame = { ...frame, ttl_ms: ttl };
              }
              if (frame.type === "grant_result" && frame.status === "applied") {
                frame =
                  ttl > 0
                    ? { ...frame, ttl_ms: ttl }
                    : {
                        type: "grant_result",
                        v: version,
                        request_id: frame.request_id,
                        status: "refused",
                        code: "expired",
                      };
              }
            }
          }
          const sent = socket.send(JSON.stringify(frame));
          if (sent === "closed") {
            paused = true;
            transportFailed = true;
            setDeadline(now);
            return;
          }
          paused = sent === "paused";
        }
      });

      const control = Effect.fn("Relay.control")(function* (
        frame: Control,
        deadline?: number,
      ) {
        if (closed) return;
        if (!outbox.control(frame, deadline)) {
          yield* end(1013);
          return;
        }
        yield* flush();
      });

      const finish = Effect.fn("Relay.finish")(function* (
        code: number,
        frame?: Control,
      ) {
        closeCode = code;
        setDeadline(clock.currentTimeMillisUnsafe() + options.handshakeMs);
        if (frame) yield* control(frame);
        else yield* flush();
      });

      const subscriptionStatus = Effect.fn("Relay.subscriptionStatus")(
        function* (
          hub: RelayHub,
          status:
            | "subscribed"
            | "denied"
            | "requested"
            | "released"
            | "expired",
        ) {
          if (status === "subscribed" || status === "denied") {
            yield* control({ type: "subscription", v: version, hub, status });
          } else {
            yield* control({
              type: "subscription",
              v: version,
              hub,
              status: "unsubscribed",
              reason: status,
            });
          }
        },
      );

      const expire = Effect.fn("Relay.expire")(function* (now: number) {
        if (closed || now < expiresAt) return;
        if (transportFailed || closeCode !== undefined) {
          socket.terminate();
          yield* end();
          return;
        }
        if (!subject) {
          yield* finish(1008, { type: "hello", status: "unauthorized" });
          return;
        }
        const expired = state.grants.filter(
          (grant) => grant.expires_at_ms <= now,
        );
        state = releaseRelayGrants(state, expired);
        setDeadline(nextGrantDeadline());
        for (const hub of expired) {
          const member = memberships.get(hubKey(hub));
          if (member) {
            yield* detach(member);
            yield* subscriptionStatus(member.hub, "expired");
          }
        }
        if (state.grants.length === 0 && !closed) yield* finish(1008);
      });

      const handshake = Effect.fn("Relay.handshake")(function* (
        frame: Extract<RelayClientFrame, { type: "connect" }>,
      ) {
        const negotiated = negotiateRelayVersion(
          frame.versions,
          RELAY_SUPPORTED_VERSIONS,
        );
        if (negotiated === null) {
          yield* finish(1002, {
            type: "hello",
            status: "incompatible_version",
            supported_versions: [...RELAY_SUPPORTED_VERSIONS],
          });
          return;
        }
        const claims = verify(frame.token);
        if (closed || closeCode !== undefined) return;
        const applied =
          typeof claims === "string"
            ? null
            : applyRelayGrantClaims(
                claims.subject,
                state,
                claims,
                clock.currentTimeMillisUnsafe(),
              );
        if (typeof claims === "string" || applied?.status !== "applied") {
          yield* finish(1008, { type: "hello", status: "unauthorized" });
          return;
        }
        subject = claims.subject;
        state = applied.state;
        for (const capability of capabilities)
          if (frame.capabilities.includes(capability)) enabled.add(capability);
        setDeadline(nextGrantDeadline());
        yield* control(
          {
            type: "hello",
            status: "ok",
            version: negotiated,
            capabilities: [...enabled],
            connection_id: connectionId,
            ttl_ms: 1,
          },
          claims.expires_at_ms,
        );
      });

      const refresh = Effect.fn("Relay.refresh")(function* (
        frame: Extract<RelayClientFrame, { type: "grant_update" }>,
        owner: RelayGrantClaims["subject"],
      ) {
        const claims = verify(frame.token);
        const now = clock.currentTimeMillisUnsafe();
        yield* expire(now);
        if (closed || closeCode !== undefined) return;
        const response = {
          type: "grant_result",
          v: version,
          request_id: frame.request_id,
        } as const;
        if (typeof claims === "string") {
          yield* control({ ...response, status: "refused", code: claims });
          return;
        }
        const applied = applyRelayGrantClaims(owner, state, claims, now);
        if (applied.status === "refused") {
          yield* control({
            ...response,
            status: "refused",
            code: applied.code,
          });
          return;
        }
        state = applied.state;
        setDeadline(nextGrantDeadline());
        for (const grant of state.grants) {
          const member = memberships.get(hubKey(grant));
          if (!member || member.grant === grant) continue;
          updateMembership(member, grant);
          if (!member.permissions.has("presence")) yield* depart(member);
        }
        yield* control(
          { ...response, status: "applied", ttl_ms: 1 },
          claims.expires_at_ms,
        );
      });

      const release = Effect.fn("Relay.release")(function* (
        frame: Extract<RelayClientFrame, { type: "grant_release" }>,
      ) {
        state = releaseRelayGrants(state, frame.hubs);
        setDeadline(nextGrantDeadline());
        for (const hub of frame.hubs) {
          const member = memberships.get(hubKey(hub));
          if (!member) continue;
          yield* detach(member);
          yield* subscriptionStatus(hub, "released");
        }
        const ack = {
          type: "grant_result",
          v: version,
          request_id: frame.request_id,
          status: "released",
        } as const;
        if (state.grants.length === 0 && !closed) yield* finish(1000, ack);
        else yield* control(ack);
      });

      const subscribe = Effect.fn("Relay.subscribe")(function* (hub: RelayHub) {
        const key = hubKey(hub);
        if (memberships.has(key)) {
          yield* subscriptionStatus(hub, "subscribed");
          return;
        }
        const grant = state.grants.find((item) => hubKey(item) === key);
        if (
          !grant ||
          !(grant.expires_at_ms > clock.currentTimeMillisUnsafe())
        ) {
          yield* subscriptionStatus(hub, "denied");
          return;
        }
        let member: Membership | undefined;
        const subscription = yield* registry.subscribe(
          hub,
          (publication) =>
            Effect.suspend(() => {
              const recipient = member;
              if (
                !recipient ||
                closed ||
                closeCode !== undefined ||
                !enabled.has(publication.frame.type)
              )
                return Effect.void;
              outbox.signal(
                publication,
                (now) => (recipient.grant?.expires_at_ms ?? 0) - now,
              );
              return flush();
            }),
          connectionScope,
        );
        if (!subscription) {
          yield* subscriptionStatus(hub, "denied");
          return;
        }
        member = {
          hub,
          subscription,
          active: false,
          grant,
          permissions: new Map(),
        };
        updateMembership(member, grant);
        memberships.set(key, member);
        yield* subscriptionStatus(hub, "subscribed");
      });

      const publish = Effect.fn("Relay.publish")(function* (
        signal: ClientSignal,
        owner: RelayGrantClaims["subject"],
      ) {
        const member = memberships.get(hubKey(signal.hub));
        const permission = member?.permissions.get(signal.type);
        const deadline = permission?.grant?.expires_at_ms ?? 0;
        if (
          !member ||
          !permission ||
          !enabled.has(signal.type) ||
          !(deadline > clock.currentTimeMillisUnsafe())
        )
          return;
        if (signal.type === "presence")
          member.active = signal.state === "active";
        const clear =
          (signal.type === "presence" && signal.state === "left") ||
          ("cursor" in signal && signal.cursor === null);
        const ttlMs = clear ? 0 : options.signalTtlMs;
        const base = { connection_id: connectionId, seq: ++seq, ttl_ms: ttlMs };
        let frame: Signal;
        switch (signal.type) {
          case "presence":
            frame =
              signal.state === "left"
                ? { ...signal, ...base, ttl_ms: 0, user_id: owner.id }
                : { ...signal, ...base, user_id: owner.id };
            break;
          case "session_liveness":
            frame = { ...signal, ...base, machine_id: owner.id };
            break;
          case "machine_liveness":
            frame = { ...signal, ...base };
            break;
          default:
            frame = { ...signal, ...base, user_id: owner.id };
        }
        const sentAt = clock.monotonicTimeNanosUnsafe();
        yield* member.subscription.publish({
          frame,
          sourceTtl: (now, elapsed) =>
            clear
              ? 0
              : Math.min(
                  deadline - now,
                  (permission.grant?.expires_at_ms ?? 0) - now,
                  ttlMs - Number(elapsed - sentAt) / 1e6,
                ),
        });
      });

      const receive = Effect.fn("Relay.receive")(function* (message: unknown) {
        yield* expire(clock.currentTimeMillisUnsafe());
        if (closed || closeCode !== undefined) return;
        const parsed = parseRelayClientFrame(message);
        if (!parsed.ok) {
          const { code } = parsed.error;
          if (code === "too_large") yield* end(1009);
          else if (code === "invalid_input") yield* end(1003);
          else yield* end(1002);
          return;
        }
        const frame = parsed.value;
        if (!subject) {
          if (frame.type === "connect") yield* handshake(frame);
          else yield* end(1002);
          return;
        }
        switch (frame.type) {
          case "connect":
            yield* end(1002);
            return;
          case "grant_update":
            yield* refresh(frame, subject);
            return;
          case "grant_release":
            yield* release(frame);
            return;
          case "subscribe":
            yield* subscribe(frame.hub);
            return;
          case "unsubscribe": {
            const member = memberships.get(hubKey(frame.hub));
            if (member) yield* detach(member);
            yield* subscriptionStatus(frame.hub, "requested");
            return;
          }
          default:
            yield* publish(frame, subject);
        }
      });

      yield* Scope.addFinalizer(
        connectionScope,
        Effect.sync(() => {
          connections.delete(connectionId);
          Queue.offerUnsafe(wake, undefined);
          if (!closed) socket.terminate();
        }),
      );
      connections.set(connectionId, {
        deadline: () => expiresAt,
        expire: (now) => expire(now).pipe(inSocketOrder),
        drain: Effect.suspend(() =>
          closed || closeCode !== undefined
            ? Effect.void
            : finish(1012, unavailable),
        ),
      });
      Queue.offerUnsafe(wake, undefined);
      return {
        receive: (message: unknown) => receive(message).pipe(inSocketOrder),
        writable: Effect.gen(function* () {
          paused = false;
          yield* expire(clock.currentTimeMillisUnsafe());
          yield* flush();
        }).pipe(inSocketOrder),
        disconnected: end().pipe(inSocketOrder),
      };
    }, inSocketOrder);

    yield* Effect.forever(
      Effect.gen(function* () {
        const now = clock.currentTimeMillisUnsafe();
        let earliest = Infinity;
        for (const connection of connections.values()) {
          if (connection.deadline() <= now) yield* connection.expire(now);
          earliest = Math.min(earliest, connection.deadline());
        }
        const changed = Queue.take(wake);
        if (earliest === Infinity) yield* changed;
        else
          yield* Effect.raceFirst(
            changed,
            Effect.sleep(
              Math.max(0, earliest - clock.currentTimeMillisUnsafe()),
            ),
          );
      }),
    ).pipe(Effect.forkScoped);

    const drain = Effect.fn("Relay.drain")(function* () {
      draining = true;
      for (const connection of connections.values()) yield* connection.drain;
    }, inSocketOrder);

    return Relay.of({
      open,
      drain: drain(),
      isDraining: Effect.sync(() => draining),
    });
  });
}
