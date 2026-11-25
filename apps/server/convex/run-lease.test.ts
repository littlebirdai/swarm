import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { presentToken } from "@platform/auth/tokenFormat";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { serverTest } from "../test-helpers/database.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashToken } from "./apiTokens";
import {
  claimNextDeliveryInDb,
  completeDeliveryInDb,
  startDeliveryInDb,
} from "./executionBindings";

const start = 1_790_000_000_000;
const leaseMs = 30_000;
const machine = "run-machine";
const boot = "run-boot";
const stale = { v: 1, status: "stale" };
const claimFn = internal.edgeRunLease.claim;
const renewFn = internal.edgeRunLease.renew;
const releaseFn = internal.edgeRunLease.release;

beforeEach(() => setSystemTime(new Date(start)));
afterEach(() => setSystemTime());

async function setup() {
  const t = serverTest();
  const tokens = [
    { secret: "run-owner", device: machine },
    { secret: "run-other-device", device: "wrong-machine" },
    { secret: "run-other-user", device: machine },
    { secret: "run-unbound", device: undefined },
  ];
  const hashes = await Promise.all(
    tokens.map(({ secret }) => hashToken(secret)),
  );
  const { owner, conversation, head, binding, message } = await t.run(
    async ({ db }) => {
      const rows = fixtureRows(db, "edge run lease");
      const owner = await rows.user();
      const other = await rows.user();
      for (const [index, { device }] of tokens.entries()) {
        await db.insert("api_tokens", {
          user_id: index === 2 ? other : owner,
          name: "lease fixture",
          token_hash: hashes[index],
          device_id: device,
          created_at: start,
          last_used_at: start,
        });
      }
      const conversation = await rows.conversation(owner, {
        execution_protocol_state: "fenced",
      });
      const head = await db.insert("conversation_execution_heads", {
        conversation_id: conversation,
        owner_user_id: owner,
        protocol_state: "fenced",
        protocol_version: 1,
        current_epoch: 1,
        admission_epoch: 1,
        next_conversation_sequence: 2,
        next_nonterminal_sequence: 1,
        created_at: start,
        updated_at: start,
      });
      const binding = await db.insert("execution_bindings", {
        conversation_id: conversation,
        epoch: 1,
        owner_user_id: owner,
        owner_device_id: machine,
        daemon_boot_id: boot,
        requested_agent: "codex",
        transport: "app-server",
        project_path: "/fixture",
        configuration_revision: 1,
        protocol_version: 1,
        required_capabilities: [],
        state: "ready",
        actual_agent: "codex",
        runtime_id: "runtime",
        applied_configuration_revision: 1,
        created_at: start,
        updated_at: start,
      });
      const message = await db.insert("pending_messages", {
        conversation_id: conversation,
        from_user_id: owner,
        owner_user_id: owner,
        content: "queued",
        status: "pending",
        created_at: start,
        retry_count: 0,
        client_id: "delivery",
        delivery_id: "delivery",
        delivery_protocol_version: 1,
        conversation_sequence: 1,
        execution_epoch: 1,
        delivery_status: "pending",
      });
      return { owner, conversation, head, binding, message };
    },
  );
  const [bearer, wrongDevice, wrongUser, unbound] = tokens.map(
    ({ secret, device }) => (device ? presentToken(secret, device) : secret),
  );
  const address = { conversation_id: conversation, bearer };
  const context = { ...address, machine, boot };
  const claim = (claim_id: string, overrides: Partial<typeof context> = {}) =>
    t.mutation(claimFn, { ...context, claim_id, ...overrides });
  const requestFence = (fencing_token: string, run = 1) => ({
    ...address,
    run,
    fencing_token,
  });
  const deliver = (fencingToken?: string) =>
    t.run((ctx) =>
      claimNextDeliveryInDb(ctx, owner, {
        conversationId: conversation,
        executionEpoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: boot,
        runtimeId: "runtime",
        fencingToken,
        now: Date.now(),
      }),
    );
  return {
    t,
    owner,
    conversation,
    head,
    binding,
    message,
    claim,
    requestFence,
    deliver,
    wrongDevice,
    wrongUser,
    unbound,
  };
}

test("competing claims yield one grant and an idempotent replay with fresh remaining time", async () => {
  const { t, head, binding, claim } = await setup();
  await t.run(({ db }) => db.patch(head, { last_pane_instance: 17 }));
  const [first, second] = await Promise.all([claim("first"), claim("second")]);
  const granted = first.status === "granted" ? first : second;
  const claimId = first.status === "granted" ? "first" : "second";
  expect(granted).toMatchObject({
    status: "granted",
    run: 1,
    lease_ms: leaseMs,
    last_pane_instance: 17,
    fencing_token: expect.any(String),
  });
  expect(first.status === "granted" ? second : first).toEqual({
    v: 1,
    status: "busy",
    retry_after_ms: leaseMs,
  });
  setSystemTime(new Date(start + 10));
  expect(await claim(claimId)).toEqual({ ...granted, lease_ms: leaseMs - 10 });
  expect(await t.run(({ db }) => db.get(binding))).toMatchObject({
    claim_id: claimId,
    lease_expires_at: start + leaseMs,
  });
});

test("expiry at the boundary permits takeover and fences all earlier claims", async () => {
  const { t, claim, requestFence } = await setup();
  const first = await claim("first");
  if (first.status !== "granted") throw Error("Expected a first grant");
  expect(first.last_pane_instance).toBe(0);
  const fence = requestFence(first.fencing_token);
  setSystemTime(new Date(start + leaseMs - 1));
  expect(await claim("second")).toEqual({
    v: 1,
    status: "busy",
    retry_after_ms: 1,
  });
  setSystemTime(new Date(start + leaseMs));
  expect(await claim("first")).toEqual(stale);
  expect(await t.mutation(renewFn, fence)).toEqual(stale);
  expect(await t.mutation(releaseFn, fence)).toEqual(stale);
  const second = await claim("second");
  if (second.status !== "granted") throw Error("Expected a takeover");
  expect(second.fencing_token).not.toBe(first.fencing_token);
  expect(await t.mutation(renewFn, fence)).toEqual(stale);
  expect(await t.mutation(releaseFn, fence)).toEqual(stale);
  expect(
    await t.mutation(releaseFn, requestFence(second.fencing_token)),
  ).toEqual({
    v: 1,
    status: "released",
  });
  expect(await claim("first")).toEqual(stale);
  expect(await claim("second")).toEqual(stale);
});

test("only the current token and epoch can renew or release", async () => {
  const { t, binding, claim, requestFence } = await setup();
  const granted = await claim("holder");
  if (granted.status !== "granted") throw Error("Expected a grant");
  const fence = requestFence(granted.fencing_token);
  setSystemTime(new Date(start + 10_000));
  for (const mutation of [renewFn, releaseFn]) {
    expect(await t.mutation(mutation, requestFence("wrong-token"))).toEqual(
      stale,
    );
    expect(
      await t.mutation(mutation, requestFence(granted.fencing_token, 2)),
    ).toEqual(stale);
  }
  expect(await t.mutation(renewFn, fence)).toEqual({
    v: 1,
    status: "renewed",
    lease_ms: leaseMs,
  });
  expect(await t.run(({ db }) => db.get(binding))).toMatchObject({
    lease_expires_at: start + leaseMs + 10_000,
  });
  setSystemTime(new Date(start + leaseMs));
  expect(await claim("holder")).toEqual({ ...granted, lease_ms: 10_000 });
  expect(await t.mutation(releaseFn, fence)).toEqual({
    v: 1,
    status: "released",
  });
  expect(await t.run(({ db }) => db.get(binding))).toMatchObject({
    lease_released_at: start + leaseMs,
  });
  expect(await t.mutation(renewFn, fence)).toEqual(stale);
  expect(await t.mutation(releaseFn, fence)).toEqual(stale);
});

test("the run owner must present the right bound device and boot", async () => {
  const { t, claim, requestFence, wrongDevice, wrongUser, unbound } =
    await setup();
  for (const overrides of [
    { bearer: wrongDevice },
    { bearer: wrongUser },
    { bearer: unbound },
    { bearer: "invalid" },
    { boot: "old" },
    { machine: "not-the-owner-device" },
  ]) {
    expect(await claim("first", overrides)).toEqual(stale);
  }
  const granted = await claim("first");
  if (granted.status !== "granted") throw Error("Expected a grant");
  for (const bearer of [wrongDevice, wrongUser, unbound]) {
    const fence = { ...requestFence(granted.fencing_token), bearer };
    expect(await t.mutation(renewFn, fence)).toEqual(stale);
    expect(await t.mutation(releaseFn, fence)).toEqual(stale);
  }
});

test("binding adoption invalidates the earlier boot's lease without granting another device", async () => {
  const { t, binding, claim, requestFence } = await setup();
  const first = await claim("first");
  if (first.status !== "granted") throw Error("Expected a first grant");
  await t.run(({ db }) => db.patch(binding, { daemon_boot_id: "replacement" }));
  expect(await t.mutation(renewFn, requestFence(first.fencing_token))).toEqual(
    stale,
  );
  expect(await claim("first", { boot: "replacement" })).toEqual(stale);
  expect(await claim("second")).toEqual(stale);
  const second = await claim("second", { boot: "replacement" });
  expect(second.status).toBe("granted");
});

test("a binding without a lease still admits legacy delivery", async () => {
  const { deliver } = await setup();
  expect(await deliver()).toMatchObject({ state: "claimed" });
});

test("the exact current lease admits delivery, and an expired or superseded token cannot start or settle", async () => {
  const { t, owner, message, claim, requestFence, deliver } = await setup();
  const first = await claim("first");
  if (first.status !== "granted") throw Error("Expected a first grant");
  await expect(deliver()).rejects.toThrow("STALE_RUN_LEASE");
  const { permit } = await deliver(first.fencing_token);
  const fence = {
    ...permit,
    conversationSequence: Number(permit.conversationSequence),
    conversationId: permit.conversationId as Id<"conversations">,
    fencingToken: first.fencing_token,
  };
  const startDelivery = (token: string) =>
    t.run((ctx) =>
      startDeliveryInDb(ctx, owner, {
        ...fence,
        fencingToken: token,
        now: Date.now(),
      }),
    );
  const complete = (token: string) =>
    t.run((ctx) =>
      completeDeliveryInDb(ctx, owner, {
        ...fence,
        fencingToken: token,
        now: Date.now(),
      }),
    );
  setSystemTime(new Date(start + leaseMs));
  await expect(startDelivery(first.fencing_token)).rejects.toThrow(
    "STALE_RUN_LEASE",
  );
  expect(await t.run(({ db }) => db.get(message))).toMatchObject({
    delivery_status: "claimed",
  });
  const second = await claim("second");
  if (second.status !== "granted") throw Error("Expected a takeover");
  await expect(startDelivery(first.fencing_token)).rejects.toThrow(
    "STALE_RUN_LEASE",
  );
  expect(await startDelivery(second.fencing_token)).toMatchObject({
    state: "delivery-started",
  });
  await expect(complete(first.fencing_token)).rejects.toThrow(
    "STALE_RUN_LEASE",
  );
  expect(
    await t.mutation(releaseFn, requestFence(second.fencing_token)),
  ).toEqual({
    v: 1,
    status: "released",
  });
  await expect(complete(second.fencing_token)).rejects.toThrow(
    "STALE_RUN_LEASE",
  );
  const third = await claim("third");
  if (third.status !== "granted") throw Error("Expected a third grant");
  expect(await complete(third.fencing_token)).toEqual({ accepted: true });
  const terminal = await t.run(({ db }) => db.get(message));
  expect(terminal).toMatchObject({ delivery_status: "delivered" });
  setSystemTime(new Date(start + leaseMs + 100));
  expect(await complete(third.fencing_token)).toEqual({ accepted: true });
  expect(await t.run(({ db }) => db.get(message))).toEqual(terminal);
});

test("execution authority reads never disclose the lease token", async () => {
  const { t, conversation, claim, wrongDevice } = await setup();
  const granted = await claim("private-grant");
  if (granted.status !== "granted") throw Error("Expected a grant");
  const result = await t.query(api.executionBindings.getExecutionAuthority, {
    conversation_id: conversation,
    api_token: wrongDevice,
  });
  expect(result?.bindings).toMatchObject([{ epoch: 1, state: "ready" }]);
  expect(JSON.stringify(result)).not.toContain(granted.fencing_token);
  expect(result?.head).not.toHaveProperty("run_claim_ids");
});

test("a retired claim identifier stays stale in a later epoch", async () => {
  const { t, binding, head, claim } = await setup();
  expect(await claim("first")).toMatchObject({ status: "granted", run: 1 });
  await t.run(async ({ db }) => {
    const row = await db.get(binding);
    if (!row) throw Error("Expected a binding");
    const {
      _id,
      _creationTime,
      claim_id,
      fencing_token,
      lease_boot_id,
      lease_expires_at,
      ...next
    } = row;
    await db.insert("execution_bindings", { ...next, epoch: 2 });
    await db.patch(head, { current_epoch: 2, admission_epoch: 2 });
  });
  expect(await claim("first")).toEqual(stale);
  expect(await claim("second")).toMatchObject({ status: "granted", run: 2 });
});

test("only the fenced current ready binding can grant a lease", async () => {
  const { t, conversation, head, binding, claim } = await setup();
  await t.run(({ db }) =>
    db.patch(conversation, { execution_protocol_state: "legacy-quiescing" }),
  );
  expect(await claim("first")).toEqual(stale);
  await t.run(async ({ db }) => {
    await db.patch(conversation, { execution_protocol_state: "fenced" });
    await db.patch(head, { protocol_state: "legacy-quiescing" });
  });
  expect(await claim("first")).toEqual(stale);
  await t.run(({ db }) =>
    db.patch(head, { protocol_state: "fenced", current_epoch: undefined }),
  );
  expect(await claim("first")).toEqual(stale);
  await t.run(async ({ db }) => {
    await db.patch(head, { current_epoch: 1 });
    await db.patch(binding, { state: "stopped" });
  });
  expect(await claim("first")).toEqual(stale);
  await t.run(({ db }) => db.patch(binding, { state: "ready" }));
  expect(await claim("")).toEqual(stale);
  expect(await claim("first")).toMatchObject({ status: "granted" });
});
