import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import {
  parseRelayServerFrame as parsePreviousServerFrame,
  type RelayClientFrame as PreviousClientFrame,
  type RelayGrantClaims as PreviousGrantClaims,
  type RelayServerFrame as PreviousServerFrame,
} from "../../../packages/relay-contract/test/n-1/schema";
import { mintTestToken } from "../test/mint-token";
import { readConfig } from "./config";
import { startRelayServer } from "./server";

const RELAY_FIXTURES_DIR = join(
  import.meta.dir,
  "../../../packages/relay-contract/test/n-1/fixtures",
);

function loadRelayFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(RELAY_FIXTURES_DIR, `${name}.json`), "utf8"),
  ) as T;
}

const key = Buffer.alloc(32, 61);
const config = readConfig({
  RELAY_PORT: "0",
  RELAY_AUDIENCE: "cell-A",
  RELAY_HMAC_KEY: key.toString("base64url"),
});

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        5_000,
      ),
    ),
  ]);
}

function createSocketQueue(url: URL) {
  const frames: PreviousServerFrame[] = [];
  const waiters = new Set<() => void>();
  const open = Promise.withResolvers<void>();
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => open.resolve());
  ws.addEventListener("message", (event) => {
    const parsed = parsePreviousServerFrame(event.data);
    if (!parsed.ok) {
      throw new Error(
        `N-1 parser rejected relay server frame: ${JSON.stringify(parsed.error)} (${String(event.data)})`,
      );
    }
    frames.push(parsed.value);
    for (const wake of [...waiters]) {
      waiters.delete(wake);
      wake();
    }
  });

  async function take(
    predicate: (frame: PreviousServerFrame) => boolean,
    label: string,
  ): Promise<PreviousServerFrame> {
    return withTimeout(
      (async () => {
        while (true) {
          const index = frames.findIndex(predicate);
          if (index >= 0) return frames.splice(index, 1)[0]!;
          await new Promise<void>((resolve) => {
            waiters.add(resolve);
          });
        }
      })(),
      label,
    );
  }

  function send(frame: PreviousClientFrame) {
    ws.send(JSON.stringify(frame));
  }

  return {
    ws,
    ready: withTimeout(open.promise, "websocket open"),
    send,
    take,
  };
}

it.effect(
  "current relay server accepts N-1 client frames and emits responses decoded by N-1 schema",
  () =>
    Effect.gen(function* () {
      const clientFixtures =
        loadRelayFixture<PreviousClientFrame[]>("client-frames");
      const claimsFixtures =
        loadRelayFixture<PreviousGrantClaims[]>("grant-claims");
      const [userClaimTemplate, machineClaimTemplate] = claimsFixtures;

      const relay = yield* Effect.acquireRelease(
        Effect.sync(() => startRelayServer(config)),
        (server) => Effect.promise(server.stop),
      );
      const url = new URL("/relay", relay.url);
      url.protocol = "ws:";

      const now = Date.now();
      const userToken = mintTestToken(key, {
        ...userClaimTemplate!,
        issued_at_ms: now,
        grant_seq: 1,
        expires_at_ms: now + 30_000,
      });
      const userRefreshToken = mintTestToken(key, {
        ...userClaimTemplate!,
        issued_at_ms: now,
        grant_seq: 2,
        expires_at_ms: now + 60_000,
      });
      const machineToken = mintTestToken(key, {
        ...machineClaimTemplate!,
        issued_at_ms: now,
        grant_seq: 1,
        expires_at_ms: now + 30_000,
      });

      const userPub = yield* Effect.acquireRelease(
        Effect.sync(() => createSocketQueue(url)),
        (sock) => Effect.sync(() => sock.ws.close()),
      );
      const userSub = yield* Effect.acquireRelease(
        Effect.sync(() => createSocketQueue(url)),
        (sock) => Effect.sync(() => sock.ws.close()),
      );
      const machinePub = yield* Effect.acquireRelease(
        Effect.sync(() => createSocketQueue(url)),
        (sock) => Effect.sync(() => sock.ws.close()),
      );

      yield* Effect.promise(() =>
        Promise.all([userPub.ready, userSub.ready, machinePub.ready]),
      );

      const connectTemplate = clientFixtures.find(
        (frame): frame is Extract<PreviousClientFrame, { type: "connect" }> =>
          frame.type === "connect",
      )!;
      const subscribeTemplate = clientFixtures.find(
        (frame): frame is Extract<PreviousClientFrame, { type: "subscribe" }> =>
          frame.type === "subscribe",
      )!;
      const unsubscribeTemplate = clientFixtures.find(
        (
          frame,
        ): frame is Extract<PreviousClientFrame, { type: "unsubscribe" }> =>
          frame.type === "unsubscribe",
      )!;
      const grantUpdateTemplate = clientFixtures.find(
        (
          frame,
        ): frame is Extract<PreviousClientFrame, { type: "grant_update" }> =>
          frame.type === "grant_update",
      )!;
      const grantReleaseTemplate = clientFixtures.find(
        (
          frame,
        ): frame is Extract<PreviousClientFrame, { type: "grant_release" }> =>
          frame.type === "grant_release",
      )!;

      const subscriberClaim: PreviousGrantClaims = {
        ...userClaimTemplate!,
        subject: { kind: "user", id: "user-2" },
        issued_at_ms: now,
        grant_seq: 1,
        expires_at_ms: now + 30_000,
        grants: [
          { kind: "session", id: "session-1", publish: [] },
          { kind: "machine", id: "machine-1", publish: [] },
        ],
      };
      const subscriberToken = mintTestToken(key, subscriberClaim);

      userPub.send({ ...connectTemplate, token: userToken });
      userSub.send({ ...connectTemplate, token: subscriberToken });
      machinePub.send({ ...connectTemplate, token: machineToken });

      const [pubHello, subHello, machineHello] = yield* Effect.promise(() =>
        Promise.all([
          userPub.take((f) => f.type === "hello", "userPub hello"),
          userSub.take((f) => f.type === "hello", "userSub hello"),
          machinePub.take((f) => f.type === "hello", "machinePub hello"),
        ]),
      );
      expect(pubHello).toMatchObject({
        type: "hello",
        status: "ok",
        version: 1,
      });
      expect(subHello).toMatchObject({
        type: "hello",
        status: "ok",
        version: 1,
      });
      expect(machineHello).toMatchObject({
        type: "hello",
        status: "ok",
        version: 1,
      });

      userPub.send(subscribeTemplate);
      userSub.send(subscribeTemplate);
      userSub.send({
        ...subscribeTemplate,
        hub: { kind: "machine", id: "machine-1" },
      });
      machinePub.send(subscribeTemplate);
      machinePub.send({
        ...subscribeTemplate,
        hub: { kind: "machine", id: "machine-1" },
      });

      yield* Effect.promise(() =>
        Promise.all([
          userPub.take(
            (f) => f.type === "subscription" && f.status === "subscribed",
            "userPub session sub",
          ),
          userSub.take(
            (f) =>
              f.type === "subscription" &&
              f.status === "subscribed" &&
              f.hub.kind === "session",
            "userSub session sub",
          ),
          userSub.take(
            (f) =>
              f.type === "subscription" &&
              f.status === "subscribed" &&
              f.hub.kind === "machine",
            "userSub machine sub",
          ),
          machinePub.take(
            (f) =>
              f.type === "subscription" &&
              f.status === "subscribed" &&
              f.hub.kind === "session",
            "machinePub session sub",
          ),
          machinePub.take(
            (f) =>
              f.type === "subscription" &&
              f.status === "subscribed" &&
              f.hub.kind === "machine",
            "machinePub machine sub",
          ),
        ]),
      );

      const userSignals = clientFixtures.filter(
        (frame) =>
          frame.type === "presence" ||
          frame.type === "draft_cursor" ||
          frame.type === "reading_cursor" ||
          frame.type === "baton_heartbeat",
      );
      for (const frame of userSignals) {
        userPub.send(frame);
        const received = yield* Effect.promise(() =>
          userSub.take((f) => f.type === frame.type, `broadcast ${frame.type}`),
        );
        expect(received.type).toBe(frame.type);
      }

      const machineSignals = clientFixtures.filter(
        (frame) =>
          frame.type === "session_liveness" ||
          frame.type === "machine_liveness",
      );
      for (const frame of machineSignals) {
        machinePub.send(frame);
        const received = yield* Effect.promise(() =>
          userSub.take((f) => f.type === frame.type, `broadcast ${frame.type}`),
        );
        expect(received.type).toBe(frame.type);
      }

      userPub.send({ ...grantUpdateTemplate, token: userRefreshToken });
      const applied = yield* Effect.promise(() =>
        userPub.take((f) => f.type === "grant_result", "grant_update result"),
      );
      expect(applied).toMatchObject({
        type: "grant_result",
        request_id: grantUpdateTemplate.request_id,
        status: "applied",
      });

      userSub.send(unsubscribeTemplate);
      const unsub = yield* Effect.promise(() =>
        userSub.take(
          (f) => f.type === "subscription" && f.status === "unsubscribed",
          "unsubscribe result",
        ),
      );
      expect(unsub).toMatchObject({
        type: "subscription",
        status: "unsubscribed",
        reason: "requested",
      });

      machinePub.send(grantReleaseTemplate);
      const released = yield* Effect.promise(() =>
        machinePub.take(
          (f) => f.type === "grant_result",
          "grant_release result",
        ),
      );
      expect(released).toMatchObject({
        type: "grant_result",
        request_id: grantReleaseTemplate.request_id,
        status: "released",
      });

      userPub.send({
        ...grantUpdateTemplate,
        request_id: "req-stale",
        token: userToken,
      });
      const refused = yield* Effect.promise(() =>
        userPub.take((f) => f.type === "grant_result", "stale grant_update"),
      );
      expect(refused).toMatchObject({
        type: "grant_result",
        request_id: "req-stale",
        status: "refused",
      });

      const incompatibleClient = yield* Effect.acquireRelease(
        Effect.sync(() => createSocketQueue(url)),
        (sock) => Effect.sync(() => sock.ws.close()),
      );
      yield* Effect.promise(() => incompatibleClient.ready);
      incompatibleClient.send({
        ...connectTemplate,
        versions: [999],
        token: userToken,
      });
      const incompatibleHello = yield* Effect.promise(() =>
        incompatibleClient.take(
          (f) => f.type === "hello",
          "incompatible hello",
        ),
      );
      expect(incompatibleHello).toEqual({
        type: "hello",
        status: "incompatible_version",
        supported_versions: [1],
      });
    }),
);
