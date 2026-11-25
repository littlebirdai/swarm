import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { presentToken } from "@platform/auth/tokenFormat";
import { hashToken } from "./apiTokens";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const machine = "edge-test-machine";
const secret = "edge-test-secret";
const bearer = presentToken(secret, machine);
const capacity = {
  memory_total_bytes: 1_024,
  memory_available_bytes: 512,
  live_agents: 2,
};
const hello = {
  machine,
  boot: "boot",
  versions: [1],
  capabilities: ["heartbeat", "expected", "unknown"],
  providers: [{ name: "claude", version: "1.0.0" }],
  runtimes: [{ host: "laptop", isolation: "none" }],
  capacity,
};
const heartbeat = { v: 1, machine, boot: hello.boot, capacity };
const start = 1_790_000_000_000;
const flag = "CODECAST_EDGE_V1";
const initialFlag = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (initialFlag === undefined) delete process.env[flag];
  else process.env[flag] = initialFlag;
  setSystemTime();
});

async function provision(
  deviceId: string | undefined = machine,
  expiresAt?: number,
  t = serverTest(),
) {
  const tokenHash = await hashToken(secret);
  const { user, token } = await t.run(async ({ db }) => {
    const user = await fixtureRows(db, "edge link account").user();
    const token = await db.insert("api_tokens", {
      user_id: user,
      name: "edge test",
      token_hash: tokenHash,
      created_at: start,
      last_used_at: start,
      device_id: deviceId || undefined,
      expires_at: expiresAt,
    });
    return { user, token };
  });

  const post = (
    operation: "hello" | "heartbeat",
    body: unknown,
    authorization = `Bearer ${bearer}`,
  ) =>
    t.fetch(`/edge/v1/${operation}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { t, post, user, token };
}

test("the edge flag defaults off and the legacy heartbeat has the same result", async () => {
  const off = await provision();
  const on = await provision();
  const legacy = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_token: bearer,
      version: "1.0.0",
      platform: "darwin",
      pid: 1,
      device_id: machine,
    }),
  };

  delete process.env[flag];
  expect((await off.post("hello", hello)).status).toBe(404);
  expect((await off.post("heartbeat", heartbeat)).status).toBe(404);
  expect(
    await off.t.run(({ db }) => db.query("ip_rate_limits").collect()),
  ).toEqual([]);
  const before = await off.t.fetch("/cli/heartbeat", legacy);
  process.env[flag] = "1";
  const after = await on.t.fetch("/cli/heartbeat", legacy);
  expect(before.status).toBe(200);
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual(await before.json());
});

test("link requires a real credential bound to the requested machine", async () => {
  const { post, t } = await provision();
  const other = "another-machine";
  const unbound = await provision("");
  const expired = await provision(machine, start - 1);
  const refused = await Promise.all([
    post("hello", hello, ""),
    post("hello", hello, "Bearer invalid"),
    post("hello", hello, `Bearer ${secret}`),
    post("hello", { ...hello, machine: other }),
    post("heartbeat", heartbeat, `Bearer ${presentToken(secret, other)}`),
    unbound.post("hello", hello),
    expired.post("heartbeat", heartbeat),
  ]);
  for (const response of refused) {
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      v: 1,
      status: "error",
      code: "unauthorized",
      retryable: false,
    });
  }
  expect(await t.run(({ db }) => db.query("ip_rate_limits").collect())).toEqual(
    [],
  );
  expect((await post("heartbeat", heartbeat)).status).toBe(200);
});

test("hello negotiates versions and only returns offered capabilities it supports", async () => {
  const { post } = await provision();
  const agreed = await post("hello", { ...hello, versions: [2, 1] });
  expect(await agreed.json()).toMatchObject({
    status: "ok",
    version: 1,
    policy: { capabilities: ["heartbeat"] },
  });
  const noCapabilities = await post("hello", { ...hello, capabilities: [] });
  expect(await noCapabilities.json()).toMatchObject({
    policy: { capabilities: [] },
  });
  for (const [versions, status] of [
    [[], "upgrade_required"],
    [[2], "server_behind"],
  ] as const) {
    const response = await post("hello", { ...hello, versions });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status, supported_versions: [1] });
  }
});

test("the link rejects unknown wire fields, malformed JSON, and a wrong heartbeat version", async () => {
  const { post, t } = await provision();
  const malformed = await t.fetch("/edge/v1/hello", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
    body: "{",
  });
  for (const response of [
    malformed,
    await post("hello", { ...hello, future: true }),
    await post("heartbeat", { ...heartbeat, v: 2 }),
  ]) {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "error",
      code: "invalid",
    });
  }
  expect(await t.run(({ db }) => db.query("ip_rate_limits").collect())).toEqual(
    [],
  );
});

test("hello and heartbeat share a rate budget that opens at the window boundary", async () => {
  const { post } = await provision();
  for (let index = 0; index < 11; index++) {
    const response =
      index % 2 === 0
        ? await post("hello", hello)
        : await post("heartbeat", heartbeat);
    expect(response.status).toBe(200);
  }
  setSystemTime(new Date(start + 59_999));
  const responses = await Promise.all([
    post("hello", hello),
    post("heartbeat", heartbeat),
  ]);
  const [accepted, limited] = responses.sort((a, b) => a.status - b.status);
  expect(accepted.status).toBe(200);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("1");
  expect(await limited.json()).toEqual({
    v: 1,
    status: "error",
    code: "rate_limited",
    retryable: true,
    retry_after_ms: 1,
  });
  setSystemTime(new Date(start + 60_000));
  expect((await post("heartbeat", heartbeat)).status).toBe(200);
});

test("a deleted token cannot heartbeat", async () => {
  const { t, post, token } = await provision();
  expect((await post("hello", hello)).status).toBe(200);
  await t.run(({ db }) => db.delete(token));
  expect((await post("heartbeat", heartbeat)).status).toBe(401);
  expect(
    await t.run(({ db }) => db.query("ip_rate_limits").collect()),
  ).toMatchObject([{ count: 1 }]);
});

test("another account has its own budget on the same machine", async () => {
  const { t, post, user } = await provision();
  const otherSecret = "other-edge-account";
  const tokenHash = await hashToken(otherSecret);
  const other = await t.run(async ({ db }) => {
    const user = await fixtureRows(db, "other edge link account").user();
    await db.insert("api_tokens", {
      user_id: user,
      name: "other edge token",
      token_hash: tokenHash,
      created_at: start,
      last_used_at: start,
      device_id: machine,
    });
    return user;
  });
  for (let i = 0; i < 12; i++)
    expect((await post("hello", hello)).status).toBe(200);
  expect((await post("hello", hello)).status).toBe(429);
  expect(
    (
      await post(
        "heartbeat",
        heartbeat,
        `Bearer ${presentToken(otherSecret, machine)}`,
      )
    ).status,
  ).toBe(200);
  const rows = await t.run(({ db }) => db.query("ip_rate_limits").collect());
  expect(
    Object.fromEntries(rows.map(({ key, count }) => [key, count])),
  ).toEqual({
    [`edge/v1:${user}:${machine}`]: 12,
    [`edge/v1:${other}:${machine}`]: 1,
  });
});

test("admission errors return only the public unavailable response", async () => {
  const { t, post } = await provision(
    machine,
    undefined,
    serverTest({ bytesRead: 1 }),
  );
  const response = await post("hello", hello);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    v: 1,
    status: "error",
    code: "unavailable",
    retryable: true,
  });
  expect(await t.run(({ db }) => db.query("ip_rate_limits").collect())).toEqual(
    [],
  );
});
