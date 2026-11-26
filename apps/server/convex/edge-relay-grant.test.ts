import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  base64urlDecode,
  base64urlEncode,
} from "@codecast/connectors/codecastSignature";
import {
  parseRelayGrantResponse,
  RELAY_SESSION_LIVENESS_CAPABILITY,
} from "@codecast/edge-contract";
import { parseRelayGrantClaims } from "@codecast/relay-contract";
import { internal } from "./_generated/api";
import { fixtureRows } from "../test-helpers/rows.testkit";
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
  CODECAST_EDGE_RELAY_LIVENESS_V1: "1",
  RELAY_PUBLIC_URL: "wss://relay.example.test/relay",
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
    capabilities: ["heartbeat", RELAY_SESSION_LIVENESS_CAPABILITY],
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
  for (const key of [
    "RELAY_HMAC_KEY",
    "RELAY_AUDIENCE",
    "RELAY_PUBLIC_URL",
    "CODECAST_EDGE_DELIVERY_V1",
    "CODECAST_EDGE_RELAY_LIVENESS_V1",
  ] as const) {
    delete process.env[key];
    expect(await capabilities(hello.capabilities)).toEqual(["heartbeat"]);
    process.env[key] = flags[key];
  }
});

test("only the current run owner can obtain a signed run-scoped grant", async () => {
  const f = await fixture();
  const claim = await f.claim("relay grant claim");
  if (claim.status !== "granted") throw new Error("Expected an active claim");
  const request = {
    session: f.conversation,
    run: claim.run,
    fencing_token: claim.fencing_token,
  };
  const mint = (body = request, bearer?: string) =>
    f.post("relay-grant", { v: 1, sessions: [body] }, bearer);
  const response = await mint();
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(parseRelayGrantResponse(result)).toMatchObject({
    ok: true,
    value: { v: 1, status: "ok", url: flags.RELAY_PUBLIC_URL, ttl_ms: leaseMs },
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function grantFence(
  f: Fixture,
  name: string,
  conversation_id = f.conversation,
) {
  const claim = await f.claim(name, { conversation_id });
  if (claim.status !== "granted") throw new Error("Expected an active claim");
  return {
    session: conversation_id,
    run: claim.run,
    fencing_token: claim.fencing_token,
  };
}

async function addSession(f: Fixture) {
  return f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "second relay run");
    const { _id, _creationTime, ...head } = (await db.get(f.head))!;
    const {
      _id: bindingId,
      _creationTime: bindingTime,
      claim_id,
      ...binding
    } = (await db.get(f.binding))!;
    const conversation = await rows.conversation(f.owner, {
      agent_type: "codex",
      execution_protocol_state: "fenced",
      owner_device_id: machine,
    });
    await db.insert("conversation_execution_heads", {
      ...head,
      conversation_id: conversation,
    });
    await db.insert("execution_bindings", {
      ...binding,
      conversation_id: conversation,
    });
    return conversation;
  });
}

test("one grant covers the batch and expires at the earliest lease deadline", async () => {
  const f = await fixture();
  const first = await grantFence(f, "first");
  const secondSession = await addSession(f);
  setSystemTime(new Date(start + 5_000));
  const second = await grantFence(f, "second", secondSession);
  const response = await f.post("relay-grant", {
    v: 1,
    sessions: [second, first],
  });
  const token = parseRelayGrantResponse(await response.json());
  if (!token.ok || token.value.status !== "ok")
    throw new Error("Expected a signed batch");
  expect(token.value.ttl_ms).toBe(leaseMs - 5_000);
  const [, payload] = token.value.token.split(".");
  expect(
    parseRelayGrantClaims(new TextDecoder().decode(base64urlDecode(payload)!)),
  ).toMatchObject({
    ok: true,
    value: {
      expires_at_ms: start + leaseMs,
      grants: [second, first].map(({ session, run }) => ({
        kind: "session",
        id: session,
        run,
        publish: ["session_liveness"],
      })),
    },
  });
  expect(
    await (
      await f.post("relay-grant", {
        v: 1,
        sessions: [first, { ...second, fencing_token: "stale" }],
      })
    ).json(),
  ).toEqual({ v: 1, status: "stale" });
});

test("grant admission has its own limit and leaves permits available", async () => {
  const f = await fixture();
  const session = await grantFence(f, "rate limit");
  const request = { v: 1, sessions: [session] };
  for (let index = 0; index < 120; index++) {
    const response = await f.post("relay-grant", request);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  }
  const throttled = await f.post("relay-grant", request);
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get("Retry-After")).toBe("60");
  expect(
    await f.t.mutation(internal.relayGrants.mintMachineLiveness, {
      bearer: f.bearer,
      sessions: [session],
    }),
  ).toEqual({ v: 1, status: "rate_limited" });
  expect((await f.post("permits.next", { v: 1, ...session })).status).toBe(200);
});

test("an earlier lease deadline after a backward clock step cannot issue a grant", async () => {
  const f = await fixture();
  const first = await grantFence(f, "later lease");
  setSystemTime(new Date(start + leaseMs - 1));
  expect(
    await (await f.post("relay-grant", { v: 1, sessions: [first] })).json(),
  ).toMatchObject({
    status: "ok",
    ttl_ms: 1,
  });
  setSystemTime(new Date(start - leaseMs + 10));
  const second = await grantFence(f, "earlier lease", await addSession(f));
  setSystemTime(new Date(start));
  expect(
    await (await f.post("relay-grant", { v: 1, sessions: [second] })).json(),
  ).toEqual({
    v: 1,
    status: "unavailable",
  });
});

test("unfenced and hosted conversations cannot obtain machine grants", async () => {
  const f = await fixture();
  const session = await grantFence(f, "eligibility");
  for (const patch of [
    { execution_protocol_state: undefined },
    { agent_type: "codecast" as const },
  ]) {
    await f.t.run(({ db }) =>
      db.patch(f.conversation, {
        execution_protocol_state: "fenced",
        ...patch,
      }),
    );
    expect(
      await (await f.post("relay-grant", { v: 1, sessions: [session] })).json(),
    ).toEqual({
      v: 1,
      status: "stale",
    });
  }
});

test("a prior epoch cannot mint after the execution head advances to epoch two", async () => {
  const f = await fixture();
  const prior = await grantFence(f, "epoch one");
  await f.t.run(async ({ db }) => {
    const { _id, _creationTime, claim_id, ...binding } = (await db.get(
      f.binding,
    ))!;
    await db.insert("execution_bindings", { ...binding, epoch: 2 });
    await db.patch(f.head, { current_epoch: 2, admission_epoch: 2 });
  });
  const next = await grantFence(f, "epoch two");
  expect(next.run).toBe(2);
  expect(
    await (await f.post("relay-grant", { v: 1, sessions: [prior] })).json(),
  ).toEqual({ v: 1, status: "stale" });
  expect(
    await (
      await f.post("relay-grant", {
        v: 1,
        sessions: [{ ...next, run: prior.run }],
      })
    ).json(),
  ).toEqual({ v: 1, status: "stale" });
  expect(
    await (await f.post("relay-grant", { v: 1, sessions: [next] })).json(),
  ).toMatchObject({ status: "ok" });
});
