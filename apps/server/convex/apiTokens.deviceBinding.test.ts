import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  hashToken,
  verifyApiToken,
  deviceBindingAllows,
  mintForDevice,
} from "./apiTokens";
import { listDevices } from "./devices";
import { DEVICE_BOUND_TOKEN_PREFIX, presentToken } from "@platform/auth/convex";

// Codecast's twin of the platform suite (@platform/auth apiTokens.deviceBinding
// .test.ts owns the rule and the mint). This one drives the functions THIS
// deployment registers: the internal query cliRoute runs at the HTTP edge, and
// a public query a Convex client can call directly with api_token and nothing
// else. Both doors must refuse a bound token that does not carry its device.

const USER = "u_owner" as any;
const BOUND = `${DEVICE_BOUND_TOKEN_PREFIX}bound-secret`;
const LEGACY = "legacy-token";
const THIS_DEVICE = "device-aaa";
const OTHER_DEVICE = "device-bbb";

async function tables() {
  return {
    users: [{ _id: USER, name: "Owner" }],
    api_tokens: [
      {
        _id: "tok_bound",
        user_id: USER,
        token_hash: await hashToken(BOUND),
        name: "macbook",
        created_at: 1,
        last_used_at: 1,
        device_id: THIS_DEVICE,
      },
      {
        _id: "tok_legacy",
        user_id: USER,
        token_hash: await hashToken(LEGACY),
        name: "old",
        created_at: 1,
        last_used_at: 1,
      },
    ],
    devices: [
      {
        _id: "dev_1",
        user_id: USER,
        device_id: THIS_DEVICE,
        label: "macbook",
        platform: "darwin",
        last_seen: 1,
      },
    ],
  };
}

// No browser session: every handler falls through to the token.
const ctx = (t: Record<string, any[]>) =>
  ({ db: makeFakeDb(t), auth: { getUserIdentity: async () => null } }) as any;
const from = (secret: string, device?: string) =>
  device ? presentToken(secret, device) : secret;
const gate = (c: any, api_token: string) =>
  (deviceBindingAllows as any)._handler(c, { api_token });

// A Convex client calling devices.listDevices directly: the real registered
// handler, which answers the roster for a good token and nothing otherwise.
const direct = (t: Record<string, any[]>, api_token: string) =>
  (listDevices as any)._handler(ctx(t), { api_token }) as Promise<
    Array<{ device_id: string }>
  >;

describe("a bound token on a direct call to a public function (devices.listDevices)", () => {
  test("with no device sees nothing", async () => {
    // The door the HTTP gate never saw. Before the device travelled inside the
    // token, the secret alone opened it.
    expect(await direct(await tables(), BOUND)).toEqual([]);
  });
  test("from another machine sees nothing", async () => {
    expect(await direct(await tables(), from(BOUND, OTHER_DEVICE))).toEqual([]);
  });
  test("from its own machine sees the roster", async () => {
    const rows = await direct(await tables(), from(BOUND, THIS_DEVICE));
    expect(rows.map((r) => r.device_id)).toEqual([THIS_DEVICE]);
  });
});

describe("an unbound token is unchanged on both doors", () => {
  test("authenticates with or without a presented device", async () => {
    const t = await tables();
    expect(await gate(ctx(t), LEGACY)).toBe(true);
    expect(await gate(ctx(t), from(LEGACY, OTHER_DEVICE))).toBe(true);
    expect((await direct(t, LEGACY)).length).toBe(1);
    expect((await direct(t, from(LEGACY, OTHER_DEVICE))).length).toBe(1);
  });

  // Token auth is read-only on purpose: patching last_used_at on every call
  // once forced OCC conflicts across every concurrent write. Binding is a comparison.
  test("neither door writes anything", async () => {
    const c = ctx(await tables());
    expect(await gate(c, from(BOUND, OTHER_DEVICE))).toBe(false);
    expect(await gate(c, from(BOUND, THIS_DEVICE))).toBe(true);
    await verifyApiToken(c, from(BOUND, THIS_DEVICE));
    await (listDevices as any)._handler(c, { api_token: BOUND });
    expect(c.db._patched).toEqual([]);
    expect(c.db._inserted).toEqual([]);
    expect(c.db._deleted).toEqual([]);
  });
});

describe("minting a host token through the registered mutation", () => {
  const HOST_DEVICE = "device-host";
  const mint = (t: Record<string, any[]>, api_token: string) =>
    (mintForDevice as any)._handler(ctx(t), {
      api_token,
      device_id: HOST_DEVICE,
      label: "ubuntu@10.0.0.9",
    }) as Promise<{ token: string }>;

  test("a bound laptop token from its own machine mints a token that works only from the host", async () => {
    const t = await tables();
    const { token } = await mint(t, from(BOUND, THIS_DEVICE));
    expect((await direct(t, from(token, HOST_DEVICE))).length).toBe(1);
    expect(await direct(t, from(token, THIS_DEVICE))).toEqual([]);
    expect(
      t.api_tokens.find((r: any) => r.device_id === HOST_DEVICE)?.name,
    ).toMatch(/^Host - ubuntu@10\.0\.0\.9 - /);
  });
});
