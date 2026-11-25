import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { CLI_AUTH_TTL_MS } from "./cliAuth";

const NONCE = "a".repeat(64);
const TOKEN = "b".repeat(64);

async function setup(opts: { createdAt: number; withApiToken?: boolean }) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "CLI auth relay");
    const user = await rows.user();
    const relay = await db.insert("cli_auth_requests", {
      nonce_hash: await hashToken(NONCE),
      user_id: user,
      token: TOKEN,
      device_name: "remote-mini",
      created_at: opts.createdAt,
    });
    const token =
      opts.withApiToken === false ? null : await rows.token(user, TOKEN);
    return { user, relay, token };
  });
  return {
    user: ids.user,
    claim: () => t.mutation(internal.cliAuth.claim, { nonce: NONCE }),
    exchange: () =>
      t.mutation(internal.cliAuth.claimForDesktop, { nonce: NONCE }),
    sweep: () => t.mutation(internal.cliAuth.sweepExpired, {}),
    relay: () => t.run(({ db }) => db.get(ids.relay)),
    token: () =>
      t.run(async ({ db }) => (ids.token ? db.get(ids.token) : null)),
  };
}

describe("claimCliAuthRequest", () => {
  test("returns credentials and deletes the row on first claim", async () => {
    const c = await setup({ createdAt: Date.now() });
    expect(await c.claim()).toEqual({ user_id: c.user, auth_token: TOKEN });
    expect(await c.relay()).toBeNull();
    expect(await c.token()).not.toBeNull();
    expect(await c.claim()).toBeNull();
  });

  test("returns null for an unknown nonce", async () => {
    const t = serverTest();
    expect(
      await t.mutation(internal.cliAuth.claim, { nonce: NONCE }),
    ).toBeNull();
  });

  test("expired deposit is not claimable, and the row still dies", async () => {
    const c = await setup({ createdAt: Date.now() - CLI_AUTH_TTL_MS - 1 });
    expect(await c.claim()).toBeNull();
    expect(await c.relay()).toBeNull();
    expect(await c.token()).not.toBeNull();
  });
});

describe("claimDesktopAuthExchange", () => {
  test("returns the user and consumes both the relay row and the api token", async () => {
    const c = await setup({ createdAt: Date.now() });
    expect(await c.exchange()).toEqual({ userId: c.user });
    expect(await c.relay()).toBeNull();
    expect(await c.token()).toBeNull();
    expect(await c.exchange()).toBeNull();
  });

  test("expired deposit yields no session", async () => {
    const c = await setup({ createdAt: Date.now() - CLI_AUTH_TTL_MS - 1 });
    expect(await c.exchange()).toBeNull();
    expect(await c.relay()).toBeNull();
    expect(await c.token()).not.toBeNull();
  });

  test("token revoked since deposit yields no session", async () => {
    const c = await setup({ createdAt: Date.now(), withApiToken: false });
    expect(await c.exchange()).toBeNull();
  });
});

describe("sweepExpiredCliAuthRequests", () => {
  test("deletes expired rows and revokes their orphaned api_tokens", async () => {
    const c = await setup({ createdAt: Date.now() - CLI_AUTH_TTL_MS - 1 });
    expect(await c.sweep()).toBe(1);
    expect(await c.relay()).toBeNull();
    expect(await c.token()).toBeNull();
  });

  test("leaves fresh rows alone", async () => {
    const c = await setup({ createdAt: Date.now() - 1000 });
    const before = [await c.relay(), await c.token()];
    expect(await c.sweep()).toBe(0);
    expect([await c.relay(), await c.token()]).toEqual(before);
  });

  test("tolerates an already-revoked token", async () => {
    const c = await setup({
      createdAt: Date.now() - CLI_AUTH_TTL_MS - 1,
      withApiToken: false,
    });
    expect(await c.sweep()).toBe(1);
    expect(await c.relay()).toBeNull();
  });
});
