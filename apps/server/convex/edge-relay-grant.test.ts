import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  base64urlDecode,
  base64urlEncode,
} from "@codecast/connectors/codecastSignature";
import { parseRelayGrantResponse } from "@codecast/edge-contract";
import { parseRelayGrantClaims } from "@codecast/relay-contract";
import { internal } from "./_generated/api";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";

const flags = {
  CODECAST_EDGE_V1: "1",
  CODECAST_EDGE_DELIVERY_V1: "1",
  RELAY_AUDIENCE: "fixture-cell",
  RELAY_HMAC_KEY: base64urlEncode(new Uint8Array(32).fill(4)),
};
const previous = Object.entries(flags).map(
  ([key]) => [key, process.env[key]] as const,
);

beforeEach(() => {
  Object.assign(process.env, flags);
  setSystemTime(new Date(start));
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setSystemTime();
});

async function fixture() {
  const session = await setupRunLease();
  const post = (operation: string, body: object, bearer = session.bearer) =>
    session.t.fetch(`/edge/v1/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  return { ...session, post };
}

test("hello advertises session liveness only when available and offered", async () => {
  const f = await fixture();
  const hello = {
    machine,
    boot,
    versions: [1],
    capabilities: ["heartbeat", "relay_session_liveness"],
    providers: [],
    runtimes: [],
    capacity: {
      memory_total_bytes: 1024,
      memory_available_bytes: 512,
      live_agents: 1,
    },
  };
  const capabilities = async (offered: string[]) => {
    const response = await f.post("hello", { ...hello, capabilities: offered });
    expect(response.status).toBe(200);
    return (await response.json()).policy.capabilities;
  };
  expect(await capabilities(hello.capabilities)).toEqual(hello.capabilities);
  expect(await capabilities(["heartbeat"])).toEqual(["heartbeat"]);
  delete process.env.RELAY_HMAC_KEY;
  expect(await capabilities(hello.capabilities)).toEqual(["heartbeat"]);
});

test("only the current run owner can obtain a signed run-scoped grant", async () => {
  const f = await fixture();
  const claim = await f.claim("relay grant claim");
  if (claim.status !== "granted") throw new Error("Expected an active claim");
  const request = {
    v: 1,
    session: f.conversation,
    run: claim.run,
    fencing_token: claim.fencing_token,
  };
  const mint = (body = request, bearer?: string) =>
    f.post("relay-grant", body, bearer);
  const response = await mint();
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(parseRelayGrantResponse(result)).toMatchObject({
    ok: true,
    value: { v: 1, status: "ok", ttl_ms: leaseMs },
  });
  const [version, payload, signature] = (result.token as string).split(".");
  expect(version).toBe("v1");
  const parsed = parseRelayGrantClaims(
    new TextDecoder().decode(base64urlDecode(payload)!),
  );
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      audience: flags.RELAY_AUDIENCE,
      subject: { kind: "machine", id: machine },
      expires_at_ms: start + leaseMs,
      grants: [
        {
          kind: "session",
          id: f.conversation,
          run: claim.run,
          publish: ["session_liveness"],
        },
      ],
    },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    base64urlDecode(flags.RELAY_HMAC_KEY)!,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(signature)!,
      new TextEncoder().encode(`v1.${payload}`),
    ),
  ).toBe(true);

  for (const bearer of [f.wrongDevice, f.wrongUser]) {
    expect(await (await mint(request, bearer)).json()).toEqual({
      v: 1,
      status: "stale",
    });
  }
  expect((await mint(request, f.unbound)).status).toBe(401);
  expect(await (await mint({ ...request, run: claim.run + 1 })).json()).toEqual(
    { v: 1, status: "stale" },
  );
  expect(
    await (await mint({ ...request, fencing_token: "old-fence" })).json(),
  ).toEqual({ v: 1, status: "stale" });

  await f.t.run(({ db }) =>
    db.patch(f.conversation, { owner_device_id: "other-device" }),
  );
  expect(await (await mint()).json()).toEqual({ v: 1, status: "stale" });
  await f.t.run(({ db }) =>
    db.patch(f.conversation, { owner_device_id: machine }),
  );

  delete process.env.CODECAST_EDGE_V1;
  expect(await (await mint()).json()).toEqual({ v: 1, status: "unavailable" });
  process.env.CODECAST_EDGE_V1 = "1";

  setSystemTime(new Date(start + leaseMs - 1));
  expect(await (await mint()).json()).toMatchObject({
    status: "ok",
    ttl_ms: 1,
  });
  setSystemTime(new Date(start + leaseMs));
  expect(await (await mint()).json()).toEqual({ v: 1, status: "stale" });
  const next = await f.claim("next claim");
  if (next.status !== "granted") throw new Error("Expected a successor claim");
  expect(await (await mint()).json()).toEqual({ v: 1, status: "stale" });
  await f.t.mutation(
    internal.edgeRunLease.release,
    f.requestFence(next.fencing_token),
  );
  expect(
    await (
      await mint({ ...request, fencing_token: next.fencing_token })
    ).json(),
  ).toEqual({ v: 1, status: "stale" });
});
