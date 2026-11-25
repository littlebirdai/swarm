import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  parseClaimResponse,
  parseDeliverySettleResponse,
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  parseReleaseResponse,
  parseRenewResponse,
  type ClaimRequest,
  type DeliveryStartRequest,
  type PermitsNextRequest,
} from "@codecast/edge-contract";
import { api } from "./_generated/api";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";

const flag = "CODECAST_EDGE_DELIVERY_V1";
const previousFlag = process.env[flag];
const stale = { v: 1, status: "stale" };
const rejected = { v: 1, status: "rejected", reason: "stale" };
const parsers = {
  claim: parseClaimResponse,
  renew: parseRenewResponse,
  release: parseReleaseResponse,
  "permits.next": parsePermitsNextResponse,
  "delivery.start": parseDeliveryStartResponse,
  "delivery.settle": parseDeliverySettleResponse,
};
type Verb = keyof typeof parsers;

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env[flag];
  else process.env[flag] = previousFlag;
  setSystemTime();
});

async function fixture() {
  const setup = await setupRunLease();
  const post = (verb: Verb, body: unknown, token = setup.bearer) =>
    setup.t.fetch(`/edge/v1/${verb}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });
  const call = async <V extends Verb>(
    verb: V,
    body: unknown,
    token?: string,
  ) => {
    const response = await post(verb, body, token);
    const json: unknown = await response.json();
    const parsed = parsers[verb](json) as ReturnType<(typeof parsers)[V]>;
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const claimBody: ClaimRequest = {
    v: 1,
    session: setup.conversation,
    machine,
    boot,
    claim_id: "http-claim",
  };
  const grant = async () => {
    const response = await call("claim", claimBody);
    if (response.status !== "granted") throw new Error("Expected a grant");
    return {
      v: response.v,
      session: response.session,
      run: response.run,
      fencing_token: response.fencing_token,
    };
  };
  const permit = async (
    fence: PermitsNextRequest,
  ): Promise<DeliveryStartRequest> => {
    const response = await call("permits.next", fence);
    if (response.status !== "permit") throw new Error("Expected a permit");
    const { delivery_id, attempt_id, seq, intent, sender } = response;
    return { ...fence, delivery_id, attempt_id, seq, intent, sender };
  };
  return { ...setup, post, call, claimBody, grant, permit };
}

test("claim and permit replay preserve authority, start and settle replay preserve effects", async () => {
  const f = await fixture();
  const fence = await f.grant();
  expect(fence).toEqual({
    v: 1,
    session: f.conversation,
    run: 1,
    fencing_token: expect.any(String),
  });
  setSystemTime(new Date(start + 321));
  expect(await f.call("claim", f.claimBody)).toEqual({
    ...fence,
    status: "granted",
    lease_ms: leaseMs - 321,
    last_pane_instance: 0,
  });
  const busy = await f.post("claim", { ...f.claimBody, claim_id: "second" });
  expect(busy.headers.get("Retry-After")).toBe("30");
  expect(await busy.json()).toEqual({
    v: 1,
    status: "busy",
    retry_after_ms: leaseMs - 321,
  });

  const permit = await f.permit(fence);
  expect(permit).toMatchObject({
    seq: 1,
    intent: "queue",
    sender: { kind: "person", id: f.owner },
  });
  expect(await f.call("permits.next", fence)).toEqual({
    ...permit,
    status: "permit",
    state: "new",
    input: [{ type: "text", text: "queued" }],
  });
  expect(await f.call("delivery.start", permit)).toEqual({
    ...permit,
    status: "started",
  });
  expect(await f.call("delivery.start", permit)).toEqual({
    ...permit,
    status: "already_started",
  });
  expect(await f.call("permits.next", fence)).toMatchObject({
    attempt_id: permit.attempt_id,
    state: "started",
  });
  const settle = { ...permit, outcome: "applied" };
  expect(await f.call("delivery.settle", settle)).toEqual({
    v: 1,
    status: "recorded",
  });
  expect(await f.call("delivery.settle", settle)).toEqual({
    v: 1,
    status: "duplicate",
  });
  expect(await f.call("permits.next", fence)).toEqual({
    v: 1,
    status: "empty",
  });
  const rows = await f.t.run(async ({ db }) => ({
    attempts: await db.query("delivery_attempts").collect(),
    message: await db.get(f.message),
    head: await db.get(f.head),
  }));
  expect(rows.attempts).toMatchObject([
    { _id: permit.attempt_id, state: "delivered" },
  ]);
  expect(rows.message?.delivery_status).toBe("delivered");
  expect(rows.head?.next_nonterminal_sequence).toBe(2);
  expect(rows.head?.active_delivery_attempt_id).toBeUndefined();
  setSystemTime(new Date(start + leaseMs));
  expect(await f.call("delivery.settle", settle)).toEqual(stale);
});

test("renew replays the active token and release revokes it", async () => {
  const f = await fixture();
  const fence = await f.grant();
  setSystemTime(new Date(start + leaseMs - 1));
  for (let index = 0; index < 2; index++) {
    expect(await f.call("renew", fence)).toEqual({
      v: 1,
      status: "renewed",
      lease_ms: leaseMs,
    });
  }
  setSystemTime(new Date(start + leaseMs + 1));
  expect(await f.call("permits.next", fence)).toMatchObject({
    status: "permit",
  });
  expect(await f.call("release", fence)).toEqual({ v: 1, status: "released" });
  expect(await f.call("release", fence)).toEqual(stale);
  expect(await f.call("renew", fence)).toEqual(stale);
  expect(await f.call("claim", f.claimBody)).toEqual(stale);
});

test("claim rejects another device, owner, boot, and an invalid session ID", async () => {
  const f = await fixture();
  expect(
    await f.call(
      "claim",
      { ...f.claimBody, machine: "wrong-machine" },
      f.wrongDevice,
    ),
  ).toEqual(stale);
  expect(await f.call("claim", f.claimBody, f.wrongUser)).toEqual(stale);
  expect(
    await f.call("claim", { ...f.claimBody, machine: "wrong-machine" }),
  ).toEqual(stale);
  expect(await f.call("claim", { ...f.claimBody, boot: "wrong-boot" })).toEqual(
    stale,
  );
  expect(await f.call("claim", { ...f.claimBody, session: f.message })).toEqual(
    stale,
  );
  await f.t.run(async ({ db }) => {
    const users = await db.query("users").collect();
    const other = users.find((user) => user._id !== f.owner);
    if (!other) throw new Error("Expected a second owner");
    await db.patch(f.conversation, { user_id: other._id });
  });
  expect(await f.call("claim", f.claimBody)).toEqual(stale);
  expect(await f.t.run(({ db }) => db.query("run_leases").collect())).toEqual(
    [],
  );
});

test("all work verbs require a device-bound bearer", async () => {
  const f = await fixture();
  const fence = await f.grant();
  const permit = await f.permit(fence);
  const requests = [
    ["claim", f.claimBody],
    ["renew", fence],
    ["release", fence],
    ["permits.next", fence],
    ["delivery.start", permit],
    ["delivery.settle", { ...permit, outcome: "applied" }],
  ] as const;
  await Promise.all(
    requests.map(async ([verb, body]) => {
      for (const token of [f.unbound, "unknown-bearer", ""]) {
        const response = await f.post(verb, body, token);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          v: 1,
          status: "error",
          code: "unauthorized",
          retryable: false,
        });
      }
    }),
  );
});

test("work refuses a missing lease, a stale token, an expired token, and another device", async () => {
  const f = await fixture();
  expect(
    await f.call("permits.next", {
      v: 1,
      session: f.conversation,
      run: 1,
      fencing_token: "invented",
    }),
  ).toEqual(stale);
  const fence = await f.grant();
  const permit = await f.permit(fence);
  for (const verb of ["renew", "release", "permits.next"] as const) {
    expect(await f.call(verb, { ...fence, fencing_token: "wrong" })).toEqual(
      stale,
    );
    expect(await f.call(verb, fence, f.wrongDevice)).toEqual(stale);
    expect(await f.call(verb, { ...fence, run: fence.run + 1 })).toEqual(stale);
  }
  expect(
    await f.call("delivery.start", { ...permit, fencing_token: "wrong" }),
  ).toEqual(rejected);
  expect(await f.call("delivery.start", permit, f.wrongDevice)).toEqual(
    rejected,
  );
  expect(await f.call("delivery.start", permit)).toMatchObject({
    status: "started",
  });
  expect(
    await f.call(
      "delivery.settle",
      { ...permit, outcome: "applied" },
      f.wrongDevice,
    ),
  ).toEqual(stale);
  setSystemTime(new Date(start + leaseMs));
  expect(await f.call("renew", fence)).toEqual(stale);
  expect(await f.call("permits.next", fence)).toEqual(stale);
  expect(await f.call("delivery.start", permit)).toEqual(rejected);
  expect(
    await f.call("delivery.settle", { ...permit, outcome: "applied" }),
  ).toEqual(stale);
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "delivery-started",
  );
});

test("boot transfer and an epoch change both revoke old delivery authority", async () => {
  for (const transfer of ["boot", "epoch"] as const) {
    const f = await fixture();
    const fence = await f.grant();
    const permit = await f.permit(fence);
    await f.t.run(({ db }) =>
      transfer === "boot"
        ? db.patch(f.binding, { daemon_boot_id: "replacement-boot" })
        : db.patch(f.head, { current_epoch: 2 }),
    );
    expect(await f.call("renew", fence)).toEqual(stale);
    expect(await f.call("delivery.start", permit)).toEqual(rejected);
    expect(
      await f.call("delivery.settle", { ...permit, outcome: "applied" }),
    ).toEqual(stale);
    expect(
      (await f.t.run(({ db }) => db.get(f.message)))?.delivery_status,
    ).toBe("claimed");
  }
});

test("held delivery can only be started or settled with the exact permit", async () => {
  const f = await fixture();
  const fence = await f.grant();
  const permit = await f.permit(fence);
  const invalid = [
    { seq: 2 },
    { attempt_id: f.message },
    { delivery_id: "other-delivery" },
    { intent: "steer" },
    { sender: { kind: "agent", id: permit.sender.id } },
    { sender: { kind: "person", id: "other-sender" } },
  ];
  for (const mismatch of invalid)
    expect(await f.call("delivery.start", { ...permit, ...mismatch })).toEqual(
      rejected,
    );
  expect(
    await f.call("delivery.settle", { ...permit, outcome: "applied" }),
  ).toEqual(stale);
  await f.call("delivery.start", permit);
  for (const mismatch of invalid)
    expect(
      await f.call("delivery.settle", {
        ...permit,
        ...mismatch,
        outcome: "applied",
      }),
    ).toEqual(stale);
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "delivery-started",
  );
});

test("in-doubt settlement holds the same attempt until evidence resolves it", async () => {
  const f = await fixture();
  const fence = await f.grant();
  const permit = await f.permit(fence);
  await f.call("delivery.start", permit);
  const doubt = { ...permit, outcome: "in_doubt" };
  expect(await f.call("delivery.settle", doubt)).toMatchObject({
    status: "recorded",
  });
  expect(await f.call("delivery.settle", doubt)).toMatchObject({
    status: "duplicate",
  });
  expect(await f.call("permits.next", fence)).toMatchObject({
    attempt_id: permit.attempt_id,
    state: "started",
  });
  expect(
    await f.call("delivery.settle", { ...permit, outcome: "applied" }),
  ).toEqual(stale);
  const resolve = {
    ...permit,
    outcome: "applied",
    resolution_evidence: "Transcript matched the delivery ID",
  };
  expect(await f.call("delivery.settle", resolve)).toMatchObject({
    status: "recorded",
  });
  expect(await f.call("delivery.settle", resolve)).toMatchObject({
    status: "duplicate",
  });
  expect(
    await f.call("delivery.settle", {
      ...resolve,
      resolution_evidence: "Different proof",
    }),
  ).toEqual(stale);
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "correlated-delivered",
  );
});

test("retryable no-effect settlement keeps the delivery ID and sequence and replaces only the attempt", async () => {
  const f = await fixture();
  const fence = await f.grant();
  const permit = await f.permit(fence);
  await f.call("delivery.start", permit);
  const failure = { ...permit, outcome: "failed", retryable: true };
  expect(await f.call("delivery.settle", failure)).toMatchObject({
    status: "recorded",
  });
  expect(await f.call("delivery.settle", failure)).toMatchObject({
    status: "duplicate",
  });
  const retry = await f.permit(fence);
  expect(retry).toEqual({ ...permit, attempt_id: expect.any(String) });
  expect(retry.attempt_id).not.toBe(permit.attempt_id);
  expect(
    await f.call("delivery.settle", { ...failure, retryable: false }),
  ).toMatchObject({
    status: "error",
    code: "invalid",
    retryable: false,
  });
  expect((await f.t.run(({ db }) => db.get(f.message)))?.retry_count).toBe(1);
});

test("attachment refusal rolls back the queue claim", async () => {
  const f = await fixture();
  const image = await f.t.run(({ storage }) =>
    storage.store(new Blob(["attachment"])),
  );
  await f.t.run(({ db }) =>
    db.patch(f.message, { image_storage_ids: [image] }),
  );
  const fence = await f.grant();
  expect(await f.call("permits.next", fence)).toEqual({
    v: 1,
    status: "error",
    code: "invalid",
    retryable: false,
  });
  expect(
    await f.t.run(({ db }) => db.query("delivery_attempts").collect()),
  ).toEqual([]);
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "pending",
  );
});

test("attachment refusal also applies to an existing legacy attempt", async () => {
  const f = await fixture();
  const legacy = await f.deliver();
  const image = await f.t.run(({ storage }) =>
    storage.store(new Blob(["attachment"])),
  );
  await f.t.run(({ db }) => db.patch(f.message, { image_storage_id: image }));
  const fence = await f.grant();
  const permit = {
    ...fence,
    delivery_id: legacy.permit.deliveryId,
    attempt_id: legacy.permit.attemptId,
    seq: Number(legacy.permit.conversationSequence),
    intent: "queue",
    sender: { kind: "person", id: f.owner },
  };
  expect(await f.call("delivery.start", permit)).toEqual({
    v: 1,
    status: "error",
    code: "invalid",
    retryable: false,
  });
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "claimed",
  );
});

test("an internal delivery error returns a redacted retry response", async () => {
  const f = await fixture();
  await f.t.run(({ db }) => db.patch(f.head, { next_nonterminal_sequence: 0 }));
  const fence = await f.grant();
  const refused = await f.post("permits.next", fence);
  expect(refused.status).toBe(503);
  expect(refused.headers.get("Retry-After")).toBe("1");
  expect(await refused.json()).toEqual({
    v: 1,
    status: "error",
    code: "unavailable",
    retryable: true,
    retry_after_ms: 1_000,
  });
  expect(
    await f.t.run(({ db }) => db.query("delivery_attempts").collect()),
  ).toEqual([]);
});

test("an unleased daemon can claim as before, but only the run holder can start its slot after lease acquisition", async () => {
  const f = await fixture();
  const legacy = await f.deliver();
  expect(legacy.state).toBe("claimed");
  const fence = await f.grant();
  const oldPermit = legacy.permit;
  await expect(
    f.t.mutation(api.executionBindings.startDelivery, {
      api_token: f.bearer,
      permit: {
        message_id: f.message,
        delivery_id: oldPermit.deliveryId,
        conversation_sequence: oldPermit.conversationSequence,
        attempt_id: oldPermit.attemptId,
        conversation_id: f.conversation,
        execution_epoch: oldPermit.executionEpoch,
        configuration_revision: oldPermit.configurationRevision,
        owner_device_id: oldPermit.ownerDeviceId,
        daemon_boot_id: oldPermit.daemonBootId,
        runtime_id: oldPermit.runtimeId,
      },
    }),
  ).rejects.toThrow("STALE_RUN_LEASE");
  const permit = await f.permit(fence);
  expect(permit.attempt_id).toBe(legacy.permit.attemptId);
  expect(await f.call("delivery.start", permit)).toMatchObject({
    status: "started",
  });
});

test("work enforces the flag, body size, and strict contract parsing before DB admission", async () => {
  const f = await fixture();
  delete process.env[flag];
  for (const verb of Object.keys(parsers) as Verb[]) {
    const unknown = await f.t.fetch("/edge/v1/unknown", { method: "POST" });
    const disabled = await f.post(verb, f.claimBody);
    expect(disabled.status).toBe(unknown.status);
    expect(await disabled.text()).toBe(
      (await unknown.text()).replace("unknown", verb),
    );
  }
  process.env[flag] = "1";
  const oversized = await f.post("claim", {
    ...f.claimBody,
    claim_id: "🎉".repeat(20_000),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({
    status: "error",
    code: "too_large",
  });
  for (const field of ["owner", "device", "now"])
    expect(
      await f.call("claim", { ...f.claimBody, [field]: "forged" }),
    ).toMatchObject({
      status: "error",
      code: "invalid",
    });
  expect(
    await f.t.run(({ db }) => db.query("ip_rate_limits").collect()),
  ).toEqual([]);
});

test("work rate limits return a typed wait and do not extend the lease", async () => {
  const f = await fixture();
  const fence = await f.grant();
  for (let index = 0; index < 119; index++)
    expect(await f.call("claim", f.claimBody)).toMatchObject({
      status: "granted",
    });
  setSystemTime(new Date(start + 25_000));
  const limited = await f.post("renew", fence);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("35");
  expect(await limited.json()).toEqual({
    v: 1,
    status: "error",
    code: "rate_limited",
    retryable: true,
    retry_after_ms: 35_000,
  });
  setSystemTime(new Date(start + 60_000));
  expect(await f.call("renew", fence)).toEqual(stale);
});
