import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import { parseRelayGrantClaims } from "@codecast/relay-contract";
import { Relay, TokenVerifier, type RelaySocket } from "@codecast/relay/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { api } from "../../server/convex/_generated/api";
import { asUser, serverTest } from "../../server/test-helpers/database.testkit";
import { fixtureRows } from "../../server/test-helpers/rows.testkit";
import { readConfig } from "./config";
import { hmacVerifier } from "./token-verifier";

const key = Buffer.alloc(32, 51);
const previousKey = Buffer.alloc(32, 52);
const environment = {
  RELAY_AUDIENCE: "cell-A",
  RELAY_HMAC_KEY: key.toString("base64url"),
  RELAY_HMAC_PREVIOUS_KEY: previousKey.toString("base64url"),
};
const config = readConfig(environment);
const verifier = hmacVerifier(key, previousKey);

const connect = Effect.fn("connect")(function* (
  relay: Relay["Service"],
  token: string,
) {
  const frames: unknown[] = [];
  const socket: RelaySocket = {
    send: (text) => {
      frames.push(JSON.parse(text));
      return "sent";
    },
    close: () => undefined,
    terminate: () => undefined,
  };
  const connection = yield* relay.open(socket);
  if (!connection) throw new Error("Socket was refused before the handshake");
  yield* connection.receive(
    JSON.stringify({
      type: "connect",
      versions: [1],
      capabilities: ["presence"],
      token,
    }),
  );
  return { connection, frames };
});

it.effect(
  "validates kernel signatures, audience, expiry and same-user tab grants",
  () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const prior = Object.keys(environment).map(
            (name) => [name, process.env[name]] as const,
          );
          Object.assign(process.env, environment);
          return prior;
        }),
        (prior) =>
          Effect.sync(() => {
            for (const [name, value] of prior) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }),
      );

      const t = serverTest();
      const { owner, id } = yield* Effect.promise(() =>
        t.run(async ({ db }) => {
          const rows = fixtureRows(db, "kernel-grant-wire");
          const owner = await rows.user();
          return { owner, id: await rows.conversation(owner) };
        }),
      );
      const hub = { kind: "session", id } as const;
      const caller = asUser(t, owner);
      const mint = Effect.fn("mint")(function* () {
        const result = yield* Effect.promise(() =>
          caller.mutation(api.relayGrants.mint, {
            hubs: [hub],
          }),
        );
        if (result.status !== "ok")
          throw new Error(`Mint returned ${result.status}`);
        return result.token;
      });
      const first = yield* mint();
      const second = yield* mint();
      const third = yield* mint();
      const current = yield* TokenVerifier;
      const parsed = parseRelayGrantClaims(current.verify(first));
      if (!parsed.ok) throw new Error("Kernel minted invalid claims");
      const { issued_at_ms, expires_at_ms } = parsed.value;
      expect(expires_at_ms - issued_at_ms).toBeLessThanOrEqual(60_000);
      const verifiesWithPreviousKey = yield* Effect.gen(function* () {
        const old = yield* TokenVerifier;
        return old.verify(first) !== null;
      }).pipe(Effect.provide(hmacVerifier(previousKey)));
      expect(verifiesWithPreviousKey).toBe(false);

      yield* TestClock.setTime(issued_at_ms);
      const relay = yield* Relay;
      const firstTab = yield* connect(relay, second);
      const secondTab = yield* connect(relay, first);
      for (const tab of [firstTab, secondTab]) {
        expect(tab.frames.at(-1)).toMatchObject({
          type: "hello",
          status: "ok",
        });
        yield* tab.connection.receive(
          JSON.stringify({ type: "subscribe", v: 1, hub }),
        );
        expect(tab.frames.at(-1)).toMatchObject({
          type: "subscription",
          status: "subscribed",
        });
      }
      for (const [tab, token] of [
        [firstTab, third],
        [secondTab, second],
      ] as const) {
        yield* tab.connection.receive(
          JSON.stringify({
            type: "grant_update",
            v: 1,
            request_id: "refresh",
            token,
          }),
        );
        expect(tab.frames.at(-1)).toMatchObject({
          type: "grant_result",
          status: "applied",
        });
      }

      const unauthorized = { type: "hello", status: "unauthorized" };
      const replacement = first.endsWith("A") ? "B" : "A";
      expect(
        (yield* connect(
          relay,
          first.slice(0, -2) + replacement + first.slice(-1),
        )).frames,
      ).toEqual([unauthorized]);

      const wrongAudience = yield* Effect.gen(function* () {
        return (yield* connect(yield* Relay, first)).frames;
      }).pipe(
        Effect.provide(Relay.layer({ ...config, audience: "other-cell" })),
      );
      expect(wrongAudience).toEqual([unauthorized]);

      yield* TestClock.setTime(expires_at_ms);
      expect((yield* connect(relay, first)).frames).toEqual([unauthorized]);
    }).pipe(
      Effect.provide(
        Layer.merge(Relay.layer(config), verifier).pipe(
          Layer.provide(verifier),
        ),
      ),
    ),
);
