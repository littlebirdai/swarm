import {
  applyRelayGrantClaims,
  negotiateRelayVersion,
  parseRelayClientFrame,
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
import type { Clock } from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { hubKey, type HubRegistry, type HubSubscription } from "./hubs";
import { Outbox, type Control } from "./outbox";
import type { RelayConnection, RelayOptions, RelaySocket } from "./relay";
import {
  publicationFor,
  signalAtSend,
  signalTtl,
  stampSignal,
  type ClientSignal,
} from "./signals";

const capabilities = [
  "presence",
  "draft_cursor",
  "reading_cursor",
  "baton_heartbeat",
  "session_liveness",
  "machine_liveness",
] as const;
const version = RELAY_PROTOCOL_VERSION;

function subjectKey(subject: RelayGrantClaims["subject"]) {
  return `${subject.kind}:${subject.id}`;
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

export function isolateConnection(
  operation: Effect.Effect<void>,
  cleanup: Effect.Effect<void>,
) {
  return operation.pipe(
    Effect.catchDefect(() =>
      cleanup.pipe(Effect.catchDefect(() => Effect.void)),
    ),
  );
}

export function openConnection(
  socket: RelaySocket,
  connectionScope: Scope.Closeable,
  clock: Clock,
  registry: HubRegistry["Service"],
  options: RelayOptions,
  verify: (
    token: string,
  ) => RelayGrantClaims | "invalid_token" | "unsupported_grant_version",
  admission: {
    admit: (key: string) => boolean;
    isDraining: () => boolean;
    deadlineChanged: () => void;
  },
  unavailable: Extract<
    RelayServerFrame,
    { type: "hello"; status: "unavailable" }
  >,
) {
  const { admit, isDraining, deadlineChanged } = admission;
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
    deadlineChanged();
  };

  function nextGrantDeadline() {
    return state.grants.reduce(
      (earliest, grant) => Math.min(earliest, grant.expires_at_ms),
      Infinity,
    );
  }

  const depart = Effect.fn("Relay.depart")(function* (member: Membership) {
    if (
      isDraining() ||
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
    yield* member.subscription.close;
    updateMembership(member, null);
    yield* depart(member);
  });

  const end = Effect.fn("Relay.end")(function* (code?: number) {
    if (closed) return;
    closed = true;
    outbox.clear();
    yield* Effect.gen(function* () {
      for (const member of memberships.values()) yield* detach(member);
    }).pipe(
      Effect.ensuring(Scope.close(connectionScope, Exit.succeed(undefined))),
    );
    if (code !== undefined) socket.close(code);
  });

  const flush = Effect.fn("Relay.flush")(function* () {
    while (!closed && !paused) {
      const pending = outbox.take();
      if (!pending) {
        if (closeCode !== undefined) yield* end(closeCode);
        return;
      }
      let frame: RelayServerFrame | null;
      if ("publication" in pending) {
        if (isDraining()) continue;
        const now = clock.currentTimeMillisUnsafe();
        frame = signalAtSend(
          pending.publication,
          pending.recipientTtl(now),
          now,
          clock.monotonicTimeNanosUnsafe(),
        );
        if (!frame) continue;
      } else {
        frame = pending.control;
        if (pending.expiresAt !== undefined) {
          const ttl = Math.floor(
            pending.expiresAt - clock.currentTimeMillisUnsafe(),
          );
          if (ttl <= 0) {
            yield* end(1008);
            return;
          }
          if (frame.type === "grant_result" && frame.status === "applied") {
            frame = { ...frame, ttl_ms: ttl };
          }
        }
      }
      const sent = socket.send(JSON.stringify(frame));
      if (sent === "closed") {
        paused = true;
        transportFailed = true;
        setDeadline(clock.currentTimeMillisUnsafe());
        return;
      }
      paused = sent === "paused";
    }
  });

  const control = Effect.fn("Relay.control")(function* (
    frame: Control,
    expiresAt?: number,
  ) {
    if (closed) return;
    if (!outbox.control(frame, expiresAt)) {
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

  const subscriptionStatus = Effect.fn("Relay.subscriptionStatus")(function* (
    hub: RelayHub,
    status: "subscribed" | "denied" | "requested" | "released" | "expired",
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
  });

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
    const expired = state.grants.filter((grant) => grant.expires_at_ms <= now);
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
    const now = clock.currentTimeMillisUnsafe();
    const applied =
      typeof claims === "string"
        ? null
        : applyRelayGrantClaims(claims.subject, state, claims, now);
    if (typeof claims === "string" || applied?.status !== "applied") {
      yield* finish(1008, { type: "hello", status: "unauthorized" });
      return;
    }
    const ttl = Math.floor(claims.expires_at_ms - now);
    if (ttl <= 0) {
      yield* finish(1008, { type: "hello", status: "unauthorized" });
      return;
    }
    if (!admit(subjectKey(claims.subject))) {
      yield* finish(1013, unavailable);
      return;
    }
    subject = claims.subject;
    state = applied.state;
    for (const capability of capabilities)
      if (frame.capabilities.includes(capability)) enabled.add(capability);
    setDeadline(nextGrantDeadline());
    yield* control({
      type: "hello",
      status: "ok",
      version: negotiated,
      capabilities: [...enabled],
      connection_id: connectionId,
      ttl_ms: ttl,
    });
  });

  const refresh = Effect.fn("Relay.refresh")(function* (
    frame: Extract<RelayClientFrame, { type: "grant_update" }>,
    owner: RelayGrantClaims["subject"],
  ) {
    const claims = verify(frame.token);
    const response = {
      type: "grant_result",
      v: version,
      request_id: frame.request_id,
    } as const;
    if (typeof claims === "string") {
      yield* control({ ...response, status: "refused", code: claims });
      return;
    }

    const now = clock.currentTimeMillisUnsafe();
    const applied = applyRelayGrantClaims(owner, state, claims, now);
    if (applied.status === "refused") {
      yield* control({ ...response, status: "refused", code: applied.code });
      return;
    }
    const ttl = Math.floor(claims.expires_at_ms - now);
    if (ttl <= 0) {
      yield* control({ ...response, status: "refused", code: "expired" });
      return;
    }

    state = applied.state;
    setDeadline(nextGrantDeadline());
    if (
      !outbox.control(
        { ...response, status: "applied", ttl_ms: ttl },
        claims.expires_at_ms,
      )
    ) {
      yield* end(1013);
      return;
    }
    for (const grant of state.grants) {
      const member = memberships.get(hubKey(grant));
      if (!member || member.grant === grant) continue;
      updateMembership(member, grant);
      if (!member.permissions.has("presence")) yield* depart(member);
    }
    yield* flush();
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

  const subscribe = Effect.fn("Relay.subscribe")(function* (
    hub: RelayHub,
    owner: RelayGrantClaims["subject"],
  ) {
    const key = hubKey(hub);
    if (memberships.has(key)) {
      yield* subscriptionStatus(hub, "subscribed");
      return;
    }
    const grant = state.grants.find((item) => hubKey(item) === key);
    if (!grant || !(grant.expires_at_ms > clock.currentTimeMillisUnsafe())) {
      yield* subscriptionStatus(hub, "denied");
      return;
    }
    let member: Membership | undefined;
    const subscription = yield* registry.subscribe(
      hub,
      subjectKey(owner),
      (publication) =>
        guard(
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
        ),
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
    if (signal.type === "presence") member.active = signal.state === "active";
    const ttl = signalTtl(signal, options.signalTtlMs);
    const frame = stampSignal(signal, owner, connectionId, ++seq, ttl);
    yield* member.subscription.publish(
      publicationFor(
        frame,
        deadline,
        () => permission.grant?.expires_at_ms ?? 0,
        clock.monotonicTimeNanosUnsafe(),
      ),
    );
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
        yield* subscribe(frame.hub, subject);
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

  const terminate = Effect.sync(() => socket.terminate());
  const recover = end().pipe(Effect.ensuring(terminate));
  const guard = (operation: Effect.Effect<void>) =>
    isolateConnection(operation, recover);

  const connection: RelayConnection = {
    receive: (message) => guard(receive(message)),
    writable: guard(
      Effect.gen(function* () {
        paused = false;
        yield* expire(clock.currentTimeMillisUnsafe());
        yield* flush();
      }),
    ),
    disconnected: guard(end()),
  };
  return {
    connection,
    deadline: () => (closed ? Infinity : expiresAt),
    expire: (now: number) => guard(expire(now)),
    drain: guard(
      Effect.suspend(() =>
        closed || closeCode !== undefined || transportFailed
          ? Effect.void
          : finish(1012, unavailable),
      ),
    ),
    dispose: isolateConnection(
      Effect.suspend(() => {
        const shouldTerminate = !closed;
        closed = true;
        outbox.clear();
        for (const member of memberships.values())
          updateMembership(member, null);
        memberships.clear();
        return shouldTerminate ? terminate : Effect.void;
      }),
      Effect.void,
    ),
  };
}
