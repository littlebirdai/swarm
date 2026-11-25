import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { presentToken } from "@platform/auth/tokenFormat";
import { scheduledJobs } from "../test-helpers/database.testkit";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease as setup,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  EXECUTION_PROTOCOL_CAPABILITIES,
  listExecutionWork,
  publishRuntimeDispositionInDb,
  rejectHeadDeliveryInDb,
  requestExecutionSuccessorInDb,
  completeDeliveryInDb,
  startDeliveryInDb,
} from "./executionBindings";
import { renewRunLease } from "./lib/edge/runLease";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const stale = { v: 1, status: "stale" };
const renewFn = internal.edgeRunLease.renew;
const releaseFn = internal.edgeRunLease.release;

beforeEach(() => setSystemTime(new Date(start)));
afterEach(() => setSystemTime());

test("competing claims yield one grant and an idempotent replay with fresh remaining time", async () => {
  const { t, head, claim } = await setup();
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
  expect(
    await t.run(({ db }) => db.query("run_leases").unique()),
  ).toMatchObject({
    claim_id: claimId,
    expires_at: start + leaseMs,
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
  const { t, claim, requestFence } = await setup();
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
  expect(
    await t.run(({ db }) => db.query("run_leases").unique()),
  ).toMatchObject({
    expires_at: start + leaseMs + 10_000,
  });
  setSystemTime(new Date(start + leaseMs));
  expect(await claim("holder")).toEqual({ ...granted, lease_ms: 10_000 });
  expect(await t.mutation(releaseFn, fence)).toEqual({
    v: 1,
    status: "released",
  });
  expect(
    await t.run(({ db }) => db.query("run_leases").unique()),
  ).toMatchObject({
    released_at: start + leaseMs,
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
    { bearer: presentToken(unbound, machine) },
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
  expect(result?.bindings[0]).not.toHaveProperty("claim_id");
});

test("a retired claim identifier stays stale in a later epoch", async () => {
  const { t, binding, head, claim } = await setup();
  expect(await claim("first")).toMatchObject({ status: "granted", run: 1 });
  await t.run(async ({ db }) => {
    const row = await db.get(binding);
    if (!row) throw Error("Expected a binding");
    const { _id, _creationTime, claim_id, ...next } = row;
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
  expect(await claim("x".repeat(129))).toEqual(stale);
  expect(await claim("x".repeat(128))).toMatchObject({ status: "granted" });
});

for (const operation of [
  "reject queued delivery",
  "publish runtime disposition",
  "request successor",
] as const) {
  test(`${operation} requires the current run lease for writes`, async () => {
    const { t, owner, conversation, binding, head, message, claim } =
      await setup();
    const first = await claim("first");
    if (first.status !== "granted") throw Error("Expected a grant");
    const target = {
      requestedAgent: "codex" as const,
      transport: "app-server" as const,
      projectPath: "/fixture",
      configurationRevision: 2,
      ownerDeviceId: machine,
      daemonBootId: boot,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    };
    if (operation === "request successor") {
      await t.run(({ db }) =>
        db.patch(head, {
          successor_intent: {
            intent_id: "test-intent",
            requested_by_user_id: owner,
            kind: "restart",
            expected_current_epoch: 1,
            policy: "cancel-unstarted",
            requested_agent: "codex",
            transport: "app-server",
            project_path: "/fixture",
            configuration_revision: 2,
            owner_device_id: machine,
            protocol_version: 1,
            required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
            status: "pending",
            created_at: start,
          },
        }),
      );
    }
    const apply = (fencingToken?: string) =>
      t.run(async (ctx): Promise<unknown> => {
        const common = {
          conversationId: conversation,
          fencingToken,
          now: Date.now(),
        };
        switch (operation) {
          case "reject queued delivery":
            return rejectHeadDeliveryInDb(ctx, owner, {
              ...common,
              messageId: message,
              deliveryId: "delivery",
              conversationSequence: 1,
              executionEpoch: 1,
              reason: "explicit rejection",
            });
          case "publish runtime disposition":
            return publishRuntimeDispositionInDb(ctx, owner, {
              ...common,
              epoch: 1,
              configurationRevision: 1,
              ownerDeviceId: machine,
              daemonBootId: boot,
              runtimeId: "runtime",
              disposition: "stopped",
              reason: "explicit stop",
            });
          case "request successor":
            return requestExecutionSuccessorInDb(ctx, owner, {
              ...common,
              intentId: "test-intent",
              expectedCurrentEpoch: 1,
              policy: "cancel-unstarted",
              target,
            });
        }
      });
    await expect(apply()).rejects.toThrow("STALE_RUN_LEASE");
    setSystemTime(new Date(start + leaseMs));
    await expect(apply(first.fencing_token)).rejects.toThrow("STALE_RUN_LEASE");
    expect(await t.run(({ db }) => db.get(message))).toMatchObject({
      delivery_status: "pending",
    });
    expect(await t.run(({ db }) => db.get(binding))).toMatchObject({
      state: "ready",
    });
    expect(await t.run(({ db }) => db.get(head))).not.toHaveProperty(
      "pending_epoch",
    );
    const second = await claim("second");
    if (second.status !== "granted") throw Error("Expected another grant");
    await expect(apply(first.fencing_token)).rejects.toThrow("STALE_RUN_LEASE");
    expect(await apply(second.fencing_token)).toMatchObject(
      operation === "reject queued delivery"
        ? { rejected: true }
        : operation === "publish runtime disposition"
          ? { accepted: true }
          : { created: true },
    );
  });
}

test("receipt retention ends at the fixed deadline and leaves a live lease alone", async () => {
  const { t, claim, requestFence } = await setup();
  const first = await claim("first");
  if (first.status !== "granted") throw Error("Expected a grant");
  expect(
    await t.mutation(releaseFn, requestFence(first.fencing_token)),
  ).toEqual({ v: 1, status: "released" });
  const retention = start + leaseMs + 7 * 24 * 60 * 60_000;
  setSystemTime(new Date(retention - 1));
  expect(await claim("first")).toEqual(stale);
  expect(await claim("second")).toMatchObject({ status: "granted" });
  expect(await t.mutation(internal.edgeRunLease.prune, {})).toBe(0);
  setSystemTime(new Date(retention));
  expect(await t.mutation(internal.edgeRunLease.prune, {})).toBe(1);
  expect(
    await t.run(({ db }) => db.query("run_leases").collect()),
  ).toMatchObject([{ claim_id: "second" }]);
});

for (const deletion of ["conversation", "account"] as const) {
  test(`${deletion} deletion purges run lease rows`, async () => {
    const { t, claim, owner, conversation } = await setup();
    expect(await claim("first")).toMatchObject({ status: "granted" });
    if (deletion === "conversation") {
      await t.mutation(internal.sessionDelete.purgeConversationRows, {
        conversation_id: conversation,
      });
    } else {
      await t.run(({ db }) => db.delete(conversation));
      await t.mutation(internal.accountDelete.purgeAccount, { user_id: owner });
    }
    expect(await t.run(({ db }) => db.query("run_leases").collect())).toEqual(
      [],
    );
  });
}

test("renewal writes only the side row that the work subscription never reads", async () => {
  const { t, bearer, claim, requestFence } = await setup();
  const granted = await claim("one");
  if (granted.status !== "granted") throw Error("Expected a grant");
  const lease = await t.run(({ db }) => db.query("run_leases").unique());
  if (!lease) throw Error("Expected the lease side row");

  const trace = (
    ctx: MutationCtx,
    events: { method: string; key: string }[],
  ) => ({
    ...ctx,
    db: new Proxy(ctx.db, {
      get(target, method, receiver) {
        const value = Reflect.get(target, method, receiver);
        if (method !== "get" && method !== "query" && method !== "patch")
          return value;
        return (...args: unknown[]) => {
          events.push({ method, key: String(args[0]) });
          return Reflect.apply(value, target, args);
        };
      },
    }),
  });
  const workArgs = {
    api_token: bearer,
    owner_device_id: machine,
    daemon_boot_id: boot,
    protocol_version: 1,
    capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
  };
  const readWork = (
    listExecutionWork as unknown as {
      _handler: (ctx: QueryCtx, args: typeof workArgs) => Promise<unknown>;
    }
  )._handler;
  const subscription: { method: string; key: string }[] = [];
  const before = await t.run((ctx) =>
    readWork(trace(ctx, subscription), workArgs),
  );
  expect(before).toMatchObject([{ bindings: [{ state: "ready" }] }]);
  expect(JSON.stringify(before)).not.toContain(granted.fencing_token);
  expect(JSON.stringify(before)).not.toContain("claim_id");
  expect(
    subscription
      .filter(({ method }) => method === "query")
      .map(({ key }) => key)
      .sort(),
  ).toEqual([
    "api_tokens",
    "conversation_execution_heads",
    "execution_bindings",
  ]);
  expect(subscription).not.toContainEqual({ method: "get", key: lease._id });

  const renewal: { method: string; key: string }[] = [];
  const fence = requestFence(granted.fencing_token);
  setSystemTime(new Date(start + 10));
  expect(
    await t.run((ctx) => renewRunLease(trace(ctx, renewal), fence)),
  ).toMatchObject({ status: "renewed" });
  expect(renewal.filter(({ method }) => method === "patch")).toEqual([
    { method: "patch", key: lease._id },
  ]);
  expect(
    renewal.filter(
      ({ method, key }) => method === "query" && key === "api_tokens",
    ),
  ).toHaveLength(1);
  expect(renewal.filter(({ method }) => method === "get")).toEqual([
    { method: "get", key: fence.conversation_id },
  ]);
  expect(
    await t.query(api.executionBindings.listExecutionWork, workArgs),
  ).toEqual(before);
});

test("retention schedules another bounded batch when the index page is full", async () => {
  const { t, claim } = await setup();
  expect(await claim("one")).toMatchObject({ status: "granted" });
  await t.run(async ({ db }) => {
    const row = await db.query("run_leases").unique();
    if (!row) throw Error("Expected a receipt");
    const { _id, _creationTime, ...receipt } = row;
    for (let i = 0; i < 500; i++) {
      await db.insert("run_leases", {
        ...receipt,
        claim_id: `receipt-${i}`,
        retain_until: start,
      });
    }
  });
  expect(await t.mutation(internal.edgeRunLease.prune, {})).toBe(500);
  expect(await scheduledJobs(t, internal.edgeRunLease.prune)).toHaveLength(1);
  expect(
    await t.run(({ db }) => db.query("run_leases").collect()),
  ).toMatchObject([{ claim_id: "one" }]);
});

test("pruning the latest expired receipt keeps that claim stale and the fence closed", async () => {
  const { t, claim, deliver } = await setup();
  const grant = await claim("first");
  if (grant.status !== "granted") throw Error("Expected a grant");
  setSystemTime(new Date(start + leaseMs + 7 * 24 * 60 * 60_000));
  expect(await t.mutation(internal.edgeRunLease.prune, {})).toBe(1);
  expect(await claim("first")).toEqual(stale);
  await expect(deliver(grant.fencing_token)).rejects.toThrow("STALE_RUN_LEASE");
  expect(await claim("second")).toMatchObject({ status: "granted" });
});

test("renewal extends retention past the original seven-day cutoff", async () => {
  const { t, claim, requestFence } = await setup();
  const grant = await claim("long-running");
  if (grant.status !== "granted") throw Error("Expected a grant");
  const row = await t.run(({ db }) => db.query("run_leases").unique());
  if (!row) throw Error("Expected a lease");
  const originalCutoff = start + leaseMs + 7 * 24 * 60 * 60_000;
  expect(row.retain_until).toBe(originalCutoff);

  await t.run(({ db }) =>
    db.patch(row._id, { expires_at: originalCutoff + 1 }),
  );
  setSystemTime(new Date(originalCutoff));
  const fence = requestFence(grant.fencing_token);
  expect(await t.mutation(renewFn, fence)).toMatchObject({ status: "renewed" });
  expect(await t.mutation(internal.edgeRunLease.prune, {})).toBe(0);
  expect(await t.run(({ db }) => db.get(row._id))).toMatchObject({
    expires_at: originalCutoff + leaseMs,
    retain_until: originalCutoff + leaseMs + 7 * 24 * 60 * 60_000,
  });
});
