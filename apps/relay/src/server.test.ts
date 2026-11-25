import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import {
  parseRelayServerFrame,
  RELAY_MAX_FRAME_BYTES,
  type RelayGrantClaims,
} from "@codecast/relay-contract";
import { TokenVerifier } from "@codecast/relay/effect";
import * as Effect from "effect/Effect";
import { readConfig } from "./config";
import { startRelayServer } from "./server";
import { mintTestToken, signTestPayload } from "../test/mint-token";
import { hmacVerifier } from "./token-verifier";

const key = Buffer.alloc(32, 57);
const env = {
  RELAY_PORT: "0",
  RELAY_AUDIENCE: "cell-A",
  RELAY_HMAC_KEY: key.toString("base64url"),
};

const claims: RelayGrantClaims = {
  v: 1,
  audience: "cell-A",
  subject: { kind: "user", id: "user-A" },
  issued_at_ms: 1,
  grant_seq: 1,
  expires_at_ms: 2,
  grants: [{ kind: "session", id: "session-A", publish: [] }],
};

it.effect("verifies HMAC signatures before decoding claims", () =>
  Effect.gen(function* () {
    const verifier = yield* TokenVerifier;
    const signed = mintTestToken(key, claims);
    expect(verifier.verify(signed)).toBe(JSON.stringify(claims));
    expect(
      verifier.verify(mintTestToken(Buffer.alloc(32, 58), claims)),
    ).toBeNull();
    const [version, payload, signature] = signed.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, audience: "forged" }),
    ).toString("base64url");
    expect(verifier.verify(`${version}.${tampered}.${signature}`)).toBeNull();
    expect(verifier.verify(`v2.${payload}.${signature}`)).toBeNull();
  }).pipe(Effect.provide(hmacVerifier(key))),
);

it.effect(
  "accepts both rotation keys and refuses noncanonical or oversized signed data",
  () => {
    const previousKey = Buffer.alloc(32, 58);
    return Effect.gen(function* () {
      const verifier = yield* TokenVerifier;
      const current = mintTestToken(key, claims);
      expect(verifier.verify(current)).toBe(JSON.stringify(claims));
      expect(verifier.verify(mintTestToken(previousKey, claims))).toBe(
        JSON.stringify(claims),
      );
      expect(
        verifier.verify(mintTestToken(Buffer.alloc(32, 59), claims)),
      ).toBeNull();

      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = alphabet.indexOf(current.slice(-1));
      expect(
        verifier.verify(current.slice(0, -1) + alphabet[last + 1]),
      ).toBeNull();
      expect(verifier.verify(signTestPayload(key, "eB"))).toBeNull();
      const tooLarge = Buffer.alloc(RELAY_MAX_FRAME_BYTES + 1, 120).toString(
        "base64url",
      );
      expect(verifier.verify(signTestPayload(key, tooLarge))).toBeNull();
    }).pipe(Effect.provide(hmacVerifier(key, previousKey)));
  },
);

it.effect("validates environment settings before binding a socket", () =>
  Effect.sync(() => {
    expect(readConfig(env)).toMatchObject({
      audience: "cell-A",
      port: 0,
      hostname: "127.0.0.1",
    });
    expect(() =>
      readConfig({
        ...env,
        RELAY_HMAC_KEY: Buffer.alloc(31).toString("base64url"),
      }),
    ).toThrow("RELAY_HMAC_KEY");
    expect(() => readConfig({ ...env, RELAY_HOST: "" })).toThrow("RELAY_HOST");
    expect(() => readConfig({ ...env, RELAY_HMAC_PREVIOUS_KEY: "x" })).toThrow(
      "RELAY_HMAC_PREVIOUS_KEY",
    );
    for (const field of [
      "RELAY_MAX_PRE_AUTH_CONNECTIONS",
      "RELAY_MAX_CONNECTIONS_PER_SUBJECT",
    ]) {
      expect(() => readConfig({ ...env, [field]: "0" })).toThrow(field);
    }
    expect(() => readConfig({ ...env, RELAY_PORT: "65536" })).toThrow(
      "RELAY_PORT",
    );
    expect(() => readConfig({ ...env, RELAY_MAX_HUBS: "0" })).toThrow(
      "RELAY_MAX_HUBS",
    );
    expect(() =>
      readConfig({ ...env, RELAY_AUDIENCE: "cell with spaces" }),
    ).toThrow("RELAY_AUDIENCE");
  }),
);

it.effect(
  "authenticates and drains a real loopback WebSocket in under one second",
  () =>
    Effect.gen(function* () {
      const started = performance.now();
      const previousKey = Buffer.alloc(32, 59);
      const config = readConfig({
        ...env,
        RELAY_HMAC_PREVIOUS_KEY: previousKey.toString("base64url"),
        RELAY_RETRY_AFTER_MS: "876",
        RELAY_DRAIN_MS: "200",
      });
      const relay = yield* Effect.acquireRelease(
        Effect.sync(() => startRelayServer(config)),
        (server) => Effect.promise(server.stop),
      );
      const health = yield* Effect.promise(() =>
        fetch(new URL("/health", relay.url)),
      );
      expect(health.status).toBe(200);
      expect(yield* Effect.promise(() => health.json())).toEqual({
        status: "ok",
      });

      const url = new URL("/relay", relay.url);
      url.protocol = "ws:";
      const hello = Promise.withResolvers<unknown>();
      const unavailable = Promise.withResolvers<unknown>();
      const closed = Promise.withResolvers<number>();
      const ws = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocket(url)),
        (socket) => Effect.sync(() => socket.close()),
      );
      ws.addEventListener("open", () => {
        const now = Date.now();
        const token = mintTestToken(previousKey, {
          ...claims,
          issued_at_ms: now,
          expires_at_ms: now + 30_000,
        });
        ws.send(
          JSON.stringify({
            type: "connect",
            versions: [1],
            capabilities: [],
            token,
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        const parsed = parseRelayServerFrame(event.data);
        if (
          parsed.ok &&
          parsed.value.type === "hello" &&
          parsed.value.status === "unavailable"
        ) {
          unavailable.resolve(parsed.value);
        } else {
          hello.resolve(parsed);
        }
      });
      ws.addEventListener("close", (event) => {
        hello.resolve(undefined);
        unavailable.resolve(undefined);
        closed.resolve(event.code);
      });
      ws.addEventListener("error", () => hello.resolve(undefined));
      expect(yield* Effect.promise(() => hello.promise)).toMatchObject({
        ok: true,
        value: { type: "hello", status: "ok", version: 1, capabilities: [] },
      });

      relay.drain();
      const draining = yield* Effect.promise(() =>
        fetch(new URL("/health", relay.url)),
      );
      expect(draining.status).toBe(503);
      expect(yield* Effect.promise(() => draining.json())).toEqual({
        status: "draining",
      });
      expect(yield* Effect.promise(() => unavailable.promise)).toEqual({
        type: "hello",
        status: "unavailable",
        retry_after_ms: 876,
      });
      expect(yield* Effect.promise(() => closed.promise)).toBe(1012);
      yield* Effect.promise(relay.stop);
      expect(performance.now() - started).toBeLessThan(1_000);
    }),
  900,
);
