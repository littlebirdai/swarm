import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { boot, machine, start } from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture as fixture,
} from "../test-helpers/steer-delivery.testkit";
import { api, internal } from "./_generated/api";
import {
  cancelFencedDeliveriesOnKill,
  claimNextDeliveryInDb,
  EXECUTION_PROTOCOL_CAPABILITIES,
} from "./executionBindings";

const flag = "SWARM_TURN_BATON";
const savedBaton = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (savedBaton === undefined) delete process.env[flag];
  else process.env[flag] = savedBaton;
  setSystemTime();
});

test("a holder passes two waiting queues in steer sequence order and settlement preserves the older gap", async () => {
  const f = await fixture();
  await f.send("contender", observed, f.other);
  await f.send("steer-one", observed);
  await f.send("steer-two", observed);
  const later = (await f.rows()).messages[3]!;
  expect(
    await f.t.run((ctx) =>
      claimNextDeliveryInDb(ctx, f.owner, {
        conversationId: f.conversation,
        executionEpoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: boot,
        runtimeId: "runtime",
        now: start,
        fencingToken: f.fence.fencing_token,
        expectedMessageId: later._id,
      }),
    ),
  ).toMatchObject({
    state: "waiting-for-earlier-message",
    messageId: (await f.rows()).messages[2]?._id,
  });
  expect((await f.rows()).attempts).toEqual([]);
  const first = await f.permit();
  expect(first.selected).toMatchObject({
    delivery_id: "steer-one",
    seq: 3,
    intent: "steer",
    baton_token: 1,
    expected: { kind: "turn", turn: observed.id },
  });
  expect(await f.begin(first.request)).toMatchObject({
    status: "started",
    intent: "steer",
  });
  expect(await f.next()).toMatchObject({
    attempt_id: first.request.attempt_id,
    state: "started",
  });
  expect(await f.settle(first.request, "applied")).toMatchObject({
    status: "recorded",
  });
  expect(await f.settle(first.request, "applied")).toMatchObject({
    status: "duplicate",
  });
  expect((await f.rows()).head?.next_nonterminal_sequence).toBe(1);
  const second = await f.permit();
  expect(second.selected).toMatchObject({
    delivery_id: "steer-two",
    seq: 4,
    intent: "steer",
  });
  expect(await f.begin(second.request)).toMatchObject({ status: "started" });
  await f.turn(null);
  expect(await f.begin(second.request)).toMatchObject({
    status: "already_started",
  });
  expect(
    await f.settle({ ...second.request, intent: "queue" }, "applied"),
  ).toMatchObject({ status: "stale" });
  expect(await f.settle(second.request, "applied")).toMatchObject({
    status: "recorded",
  });
  const legacy = await f.permit();
  expect(legacy.selected).toMatchObject({
    delivery_id: "delivery",
    seq: 1,
    intent: "queue",
  });
  await f.begin(legacy.request);
  await f.settle(legacy.request, "applied");
  expect((await f.permit()).selected).toMatchObject({
    delivery_id: "contender",
    seq: 2,
    intent: "queue",
  });
  expect(
    (await f.rows()).messages.map((row) => row.conversation_sequence),
  ).toEqual([1, 2, 3, 4]);
});

test("a correlated replay of an already delivered steer keeps the next attempt in flight", async () => {
  const f = await fixture();
  await f.send("already-delivered", observed);
  const settled = await f.permit();
  expect(settled.selected).toMatchObject({ intent: "steer" });
  expect(await f.begin(settled.request)).toMatchObject({ status: "started" });
  expect(await f.settle(settled.request, "applied")).toMatchObject({
    status: "recorded",
  });

  await f.send("next-steer", observed);
  const next = await f.permit();
  expect(next.selected).toMatchObject({
    delivery_id: "next-steer",
    intent: "steer",
  });
  expect(await f.begin(next.request)).toMatchObject({ status: "started" });
  const before = await f.rows();
  expect(
    before.attempts.find(
      (attempt) => attempt._id === settled.request.attempt_id,
    )?.state,
  ).toBe("delivered");
  const evidence = {
    resolution_evidence: "provider receipt for already-delivered",
  };
  expect(
    await f.settle(
      { ...settled.request, seq: next.request.seq },
      "applied",
      evidence,
    ),
  ).toMatchObject({
    status: "stale",
  });
  expect(await f.settle(settled.request, "applied", evidence)).toMatchObject({
    status: "duplicate",
  });
  expect(await f.rows()).toEqual(before);
});

test("start rejects a claimed steer for a reused turn ID without releasing the replacement slot on replay", async () => {
  const f = await fixture();
  await f.send("old-turn", observed);
  const old = await f.permit();
  expect(old.selected).toMatchObject({ intent: "steer", baton_token: null });
  await f.turn({
    id: observed.id,
    start_event_seq: 8,
    starter: { kind: "person", id: f.owner },
    prompt_ids: [],
  });
  expect(await f.begin(old.request)).toMatchObject({
    status: "rejected",
    reason: "stale-turn",
  });
  expect((await f.rows()).messages[1]).toMatchObject({
    status: "cancelled",
    delivery_status: "rejected",
  });
  await f.send("new-turn", { ...observed, start_event_seq: 8 });
  const current = await f.permit();
  expect(current.selected).toMatchObject({
    delivery_id: "new-turn",
    state: "new",
  });
  expect(await f.begin(old.request)).toMatchObject({
    status: "rejected",
    reason: "stale-turn",
  });
  expect((await f.rows()).head?.active_delivery_attempt_id).toBe(
    current.request.attempt_id,
  );
});

test("unreserved stale steers are terminal without an attempt and cannot pass a waiting legacy row", async () => {
  const f = await fixture();
  await f.send("expired-steer", observed);
  await f.turn(null);
  expect((await f.permit()).selected).toMatchObject({
    delivery_id: "delivery",
    seq: 1,
  });
  const state = await f.rows();
  expect(state.attempts).toHaveLength(1);
  expect(state.messages[1]).toMatchObject({
    delivery_status: "rejected",
    status: "cancelled",
    delivery_disposition_reason: "stale-turn",
  });
});

test("idle cutover appends old unsequenced queue rows in their queue order exactly once", async () => {
  const f = await fixture();
  await f.t.run(async ({ db }) => {
    const base = {
      conversation_id: f.conversation,
      from_user_id: f.owner,
      content: "legacy work",
      created_at: start,
      retry_count: 0,
      status: "held" as const,
    };
    await db.insert("pending_messages", {
      ...base,
      queued: true,
      client_id: "last",
      queue_at: 20,
    });
    await db.insert("pending_messages", {
      ...base,
      queued: true,
      content: "first legacy row",
      queue_at: 10,
    });
    await db.insert("pending_messages", { ...base, client_id: "held-note" });
  });
  await f.turn(null);
  await f.send("after-cutover", undefined);
  const state = await f.rows();
  expect(
    state.messages.find((row) => row.content === "first legacy row"),
  ).toMatchObject({
    client_id: expect.any(String),
    delivery_id: expect.any(String),
    delivery_intent: "queue",
    conversation_sequence: 2,
  });
  expect(state.messages.find((row) => row.client_id === "last")).toMatchObject({
    delivery_id: "last",
    conversation_sequence: 3,
  });
  expect(
    state.messages.find((row) => row.client_id === "after-cutover")
      ?.conversation_sequence,
  ).toBe(4);
  expect(
    state.messages.find((row) => row.client_id === "held-note")
      ?.delivery_intent,
  ).toBeUndefined();
  expect((await f.permit()).selected).toMatchObject({
    delivery_id: "delivery",
    seq: 1,
  });
  expect((await f.rows()).head?.next_conversation_sequence).toBe(5);
});

test("a claimed steer cannot use a newer token held by the same sender", async () => {
  const f = await fixture();
  await f.send("contender", observed, f.other);
  await f.send("old-baton", observed);
  const permit = await f.permit();
  await f.t.run(async ({ db }) => {
    const claim = (await db.query("claims").unique())!;
    await db.patch(claim._id, { token: 3 });
  });
  expect(await f.begin(permit.request)).toMatchObject({
    status: "rejected",
    reason: "stale-baton",
  });
  expect((await f.rows()).head?.next_nonterminal_sequence).toBe(1);
});

test("an unreserved null-token steer from an agent is rejected", async () => {
  const f = await fixture();
  await f.send("lone", observed);
  await f.t.run(async ({ db }) => {
    const row = (await db
      .query("pending_messages")
      .withIndex("by_conversation_client_id", (q) =>
        q.eq("conversation_id", f.conversation).eq("client_id", "lone"),
      )
      .unique())!;
    await db.patch(row._id, { from_conversation_id: f.conversation });
  });
  expect(await f.next()).toMatchObject({ status: "empty" });
  const state = await f.rows();
  expect(state.attempts).toEqual([]);
  expect(state.messages[1]).toMatchObject({
    delivery_status: "rejected",
    delivery_disposition_reason: "stale-steer-sender",
  });
});

test("an unreserved steer loses eligibility when the holder loses send access", async () => {
  const f = await fixture();
  await f.send("contender", observed, f.other);
  await f.t.run(async ({ db }) => {
    const claim = (await db.query("claims").unique())!;
    await db.patch(claim._id, { holder: f.other, token: 2 });
  });
  await f.send("removed", observed, f.other);
  await f.t.run(({ db }) =>
    db.patch(f.conversation, { owner_user_id: undefined }),
  );
  expect(await f.next()).toMatchObject({ status: "empty" });
  const state = await f.rows();
  expect(state.attempts).toEqual([]);
  expect(state.messages.at(-1)).toMatchObject({
    delivery_status: "rejected",
    delivery_disposition_reason: "stale-steer-sender",
  });
});

test("drain-current commits stale cleanup with a valid lease even when earlier work remains", async () => {
  const f = await fixture();
  await f.send("old-steer", observed);
  await f.turn(null);
  await f.t.run(({ db }) =>
    db.patch(f.head, { pending_policy: "drain-current" }),
  );
  const stop = (fencing_token: string) =>
    f.t.mutation(api.executionBindings.publishRuntimeDisposition, {
      api_token: f.bearer,
      conversation_id: f.conversation,
      epoch: 1,
      configuration_revision: 1,
      owner_device_id: machine,
      daemon_boot_id: boot,
      runtime_id: "runtime",
      reason: "drain",
      disposition: "stopped",
      fencing_token,
    });
  await expect(stop("wrong")).rejects.toThrow("STALE_RUN_LEASE");
  expect((await f.rows()).messages[1]?.delivery_status).toBe("pending");
  expect(await stop(f.fence.fencing_token)).toEqual({ accepted: false });
  expect((await f.rows()).messages[1]).toMatchObject({
    delivery_status: "rejected",
    delivery_disposition_reason: "stale-turn",
  });
  const existing = await f.permit();
  await f.begin(existing.request);
  await f.settle(existing.request, "applied");
  expect(await stop(f.fence.fencing_token)).toEqual({ accepted: true });
});

test("the next sender queues while a started steer owns the slot and can drive after it settles", async () => {
  const f = await fixture();
  await f.send("contender", observed, f.other);
  await f.send("in-flight", observed);
  const handed = await f.permit();
  await f.begin(handed.request);
  await f.t.run(async ({ db }) => {
    const claim = (await db.query("claims").unique())!;
    await db.patch(claim._id, { lease_until: start });
  });
  await f.send("wait", observed, f.other);
  expect((await f.rows()).messages.at(-1)).toMatchObject({
    delivery_intent: "queue",
  });
  expect((await f.permit()).selected).toMatchObject({
    attempt_id: handed.request.attempt_id,
    state: "started",
  });
  expect(await f.settle(handed.request, "applied")).toMatchObject({
    status: "recorded",
  });
  await f.send("new-holder", observed, f.other);
  expect((await f.permit()).selected).toMatchObject({
    delivery_id: "new-holder",
    baton_token: 2,
  });
});

test("an in-doubt steer remains the slot owner when the daemon asks to retry it", async () => {
  const f = await fixture();
  await f.send("uncertain", observed);
  const permit = await f.permit();
  await f.begin(permit.request);
  expect(await f.settle(permit.request, "in_doubt")).toMatchObject({
    status: "recorded",
  });
  await f.turn(null);
  expect(
    await f.settle(permit.request, "failed", {
      retryable: true,
      resolution_evidence: "machine claims no effect",
    }),
  ).toMatchObject({ status: "stale" });
  expect(await f.next()).toMatchObject({
    attempt_id: permit.request.attempt_id,
    state: "started",
    intent: "steer",
  });
  expect((await f.rows()).messages[1]?.delivery_status).toBe("ambiguous");
});

test("kill cancels a fenced queue-for-later row without touching the handed steer", async () => {
  const f = await fixture();
  await asUser(f.t, f.owner).mutation(api.dispatch.dispatch, {
    action: "queueMessage",
    args: [f.conversation, "later", "later"],
  });
  await f.send("steer", observed);
  const active = await f.permit();
  await f.begin(active.request);
  expect(
    await f.t.run((ctx) =>
      cancelFencedDeliveriesOnKill(ctx, f.conversation, start),
    ),
  ).toEqual({ cancelled: 2, inFlight: 1 });
  const state = await f.rows();
  expect(state.messages[1]).toMatchObject({
    status: "cancelled",
    delivery_status: "cancelled-by-supersession",
  });
  expect(state.head).toMatchObject({
    active_delivery_attempt_id: active.request.attempt_id,
    next_nonterminal_sequence: active.request.seq,
  });
});

test("successor cancellation does not release a later claimed steer until its own batch", async () => {
  const f = await fixture();
  await f.t.run(async ({ db }) => {
    for (let seq = 2; seq <= 128; seq++) {
      await db.insert("pending_messages", {
        conversation_id: f.conversation,
        from_user_id: f.owner,
        content: "queue",
        status: "pending",
        created_at: start,
        retry_count: 0,
        client_id: `queue-${seq}`,
        delivery_id: `queue-${seq}`,
        delivery_protocol_version: 1,
        execution_epoch: 1,
        conversation_sequence: seq,
        delivery_status: "pending",
      });
    }
    await db.patch(f.head, { next_conversation_sequence: 129 });
  });
  await f.send("last-steer", observed);
  const active = await f.permit();
  expect(active.selected).toMatchObject({ seq: 129, intent: "steer" });
  await f.t.run(async ({ db }) => {
    const { _id, _creationTime, ...binding } = (await db.get(f.binding))!;
    await db.patch(f.binding, { state: "stopped" });
    await db.insert("execution_bindings", {
      ...binding,
      epoch: 2,
      configuration_revision: 2,
      applied_configuration_revision: 2,
      runtime_id: "successor",
      operation_id: "successor-op",
      capabilities: binding.required_capabilities,
      claim_id: undefined,
    });
    await db.patch(f.head, {
      pending_epoch: 2,
      admission_epoch: 2,
      pending_policy: "cancel-unstarted",
      cancelled_through_sequence: 129,
      successor_intent: {
        intent_id: "move",
        requested_by_user_id: f.owner,
        expected_current_epoch: 1,
        kind: "restart",
        policy: "cancel-unstarted",
        requested_agent: binding.requested_agent,
        transport: binding.transport,
        project_path: binding.project_path,
        configuration_revision: 2,
        owner_device_id: machine,
        protocol_version: 1,
        required_capabilities: binding.required_capabilities,
        status: "consumed",
        successor_epoch: 2,
        consumed_daemon_boot_id: boot,
        created_at: start,
      },
    });
  });
  const activate = () =>
    f.t.mutation(api.executionBindings.activateExecutionSuccessor, {
      api_token: f.bearer,
      conversation_id: f.conversation,
      expected_current_epoch: 1,
      successor_epoch: 2,
      current_configuration_revision: 1,
      current_owner_device_id: machine,
      current_daemon_boot_id: boot,
      current_operation_id: "operation",
      current_runtime_id: "runtime",
      successor_configuration_revision: 2,
      successor_owner_device_id: machine,
      successor_daemon_boot_id: boot,
      successor_runtime_id: "successor",
    });
  expect(await activate()).toMatchObject({
    activated: false,
    cancelledMessages: 128,
    remainingCancellations: 1,
  });
  expect((await f.rows()).head?.active_delivery_attempt_id).toBe(
    active.request.attempt_id,
  );
  expect(await activate()).toMatchObject({
    activated: true,
    cancelledMessages: 1,
  });
  const state = await f.rows();
  expect(state.head?.active_delivery_attempt_id).toBeUndefined();
  expect(state.attempts[0]?.state).toBe("cancelled-by-supersession");
});

test("replacement boot adopts the later active steer and fences the old daemon", async () => {
  const f = await fixture();
  await f.send("steer", observed);
  await f.send("unstarted-old-turn", observed);
  const first = await f.permit();
  await f.begin(first.request);
  const replacement = {
    owner_device_id: machine,
    daemon_boot_id: "replacement",
    api_token: f.bearer,
  };
  await f.t.mutation(
    api.executionBindings.registerExecutionDaemonBoot,
    replacement,
  );
  expect(
    await f.t.mutation(api.executionBindings.claimExecutionStart, {
      ...replacement,
      conversation_id: f.conversation,
      epoch: 1,
      configuration_revision: 1,
      protocol_version: 1,
      required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposed_operation_id: "operation",
    }),
  ).toMatchObject({ state: "ready" });
  expect(await f.settle(first.request, "applied")).toMatchObject({
    status: "stale",
  });
  const lease = await f.claim("replacement-run", { boot: "replacement" });
  if (lease.status !== "granted") throw new Error("Expected replacement lease");
  expect(
    await f.t.mutation(internal.edgeDelivery.next, {
      ...f.fence,
      v: 1,
      bearer: f.bearer,
      fencing_token: lease.fencing_token,
    }),
  ).toMatchObject({
    attempt_id: first.request.attempt_id,
    intent: "steer",
    baton_token: null,
    state: "started",
  });
  const after = await f.rows();
  expect(after.head).toMatchObject({
    next_nonterminal_sequence: 1,
    active_delivery_state: "ambiguous",
  });
  expect(after.messages[0]).toMatchObject({ delivery_status: "pending" });
  expect(after.attempts[0]).toMatchObject({
    _id: first.request.attempt_id,
    daemon_boot_id: "replacement",
  });
  const replacementFence = {
    ...f.fence,
    v: 1 as const,
    bearer: f.bearer,
    fencing_token: lease.fencing_token,
  };
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...replacementFence,
      ...first.request,
      outcome: "duplicate",
      resolution_evidence: "replacement journal proves the steer was applied",
    }),
  ).toMatchObject({ status: "recorded" });
  expect(
    await f.t.mutation(internal.edgeDelivery.next, replacementFence),
  ).toMatchObject({
    delivery_id: "delivery",
    intent: "queue",
    seq: 1,
  });
  expect((await f.rows()).messages[2]).toMatchObject({
    delivery_status: "rejected",
    delivery_disposition_reason: "stale-turn",
  });
});

test("a started steer recovers with its original wire authority after capability loss", async () => {
  const f = await fixture();
  await f.send("first", observed);
  const first = await f.permit();
  await f.begin(first.request);
  await f.t.run(async ({ db }) => {
    const binding = (await db.get(f.binding))!;
    await db.patch(f.binding, { capabilities: binding.required_capabilities });
  });
  expect(await f.next()).toMatchObject({
    attempt_id: first.request.attempt_id,
    state: "started",
    intent: "steer",
    baton_token: null,
  });
  expect(await f.settle(first.request, "applied")).toMatchObject({
    status: "recorded",
  });
  await f.turn(null);
  expect((await f.permit()).selected).toMatchObject({
    delivery_id: "delivery",
    intent: "queue",
  });
});

test("a machine may terminally report a steer stale only for a different observed turn", async () => {
  const f = await fixture();
  await f.send("steer", observed);
  const permit = await f.permit();
  await f.begin(permit.request);
  const before = await f.rows();
  expect(
    await f.settle(permit.request, "stale", {
      observed: { kind: "turn", turn: observed.id },
    }),
  ).toMatchObject({ status: "stale" });
  expect(await f.rows()).toEqual(before);
  const ended = { observed: { kind: "turn", turn: null } };
  expect(await f.settle(permit.request, "stale", ended)).toMatchObject({
    status: "recorded",
  });
  expect(await f.settle(permit.request, "stale", ended)).toMatchObject({
    status: "duplicate",
  });
  expect((await f.rows()).messages[1]).toMatchObject({
    status: "cancelled",
    delivery_status: "rejected",
    delivery_disposition_reason: "stale-turn",
  });
});

test("flag-off replay retains the old queue permit and persisted slot", async () => {
  const f = await fixture();
  delete process.env[flag];
  const first = await f.permit();
  expect(first.selected).toMatchObject({
    delivery_id: "delivery",
    seq: 1,
    intent: "queue",
    state: "new",
  });
  const claimed = await f.rows();
  expect(await f.next()).toEqual(first.selected);
  expect(await f.rows()).toEqual(claimed);
  const started = await f.begin(first.request);
  expect(started.status).toBe("started");
  const startedRows = await f.rows();
  expect(await f.begin(first.request)).toEqual({
    ...started,
    status: "already_started",
  });
  expect(await f.rows()).toEqual(startedRows);
});

test("queue start releases the claim if a turn opens, then retries the same delivery after it ends", async () => {
  const f = await fixture();
  await f.turn(null);
  const first = await f.permit();
  await f.turn({
    id: observed.id,
    start_event_seq: observed.start_event_seq,
    prompt_ids: [],
  });
  expect(await f.begin(first.request)).toEqual({
    v: 1,
    status: "rejected",
    reason: "turn-open",
  });
  const deferred = await f.rows();
  expect(deferred.head?.active_delivery_attempt_id).toBeUndefined();
  expect(deferred.messages[0]).toMatchObject({
    delivery_status: "pending",
    delivery_id: first.request.delivery_id,
    conversation_sequence: first.request.seq,
  });
  expect(deferred.attempts[0]).toMatchObject({
    state: "failed-before-effect",
    failure_message: "turn-open",
  });
  expect(await f.next()).toMatchObject({ status: "empty" });
  await f.turn(null);
  const second = await f.permit();
  expect(second.request).toMatchObject({
    delivery_id: first.request.delivery_id,
    seq: first.request.seq,
  });
  expect(second.request.attempt_id).not.toBe(first.request.attempt_id);
  expect(await f.begin(second.request)).toMatchObject({
    status: "started",
    intent: "queue",
  });
});

test.each(["flag off", "capability dropped"] as const)(
  "an unreserved steer becomes terminal when the baton is disabled (%s)",
  async (mode) => {
    const f = await fixture();
    await f.send("old-steer", observed);
    await f.send("next", undefined);
    await f.t.run(async ({ db }) => {
      await db.patch(f.message, {
        status: "delivered",
        delivery_status: "delivered",
      });
      await db.patch(f.head, { next_nonterminal_sequence: 2 });
      if (mode === "capability dropped") {
        const binding = (await db.get(f.binding))!;
        await db.patch(f.binding, {
          capabilities: binding.required_capabilities,
        });
      }
    });
    if (mode === "flag off") delete process.env[flag];
    expect((await f.permit()).selected).toMatchObject({
      intent: "queue",
      delivery_id: "next",
      seq: 3,
    });
    const state = await f.rows();
    expect(state.messages[1]).toMatchObject({
      delivery_status: "rejected",
      status: "cancelled",
      delivery_disposition_reason: "stale-turn",
    });
    expect(state.head?.next_nonterminal_sequence).toBe(3);
    expect(state.attempts).toHaveLength(1);
  },
);

test("rejection selects the oldest eligible steer behind a waiting queue", async () => {
  const f = await fixture();
  await f.send("eligible", observed);
  await f.send("later", observed);
  const own = await f.rows();
  const reject = (row: (typeof own.messages)[number]) =>
    f.t.mutation(api.executionBindings.rejectHeadDelivery, {
      api_token: f.bearer,
      fencing_token: f.fence.fencing_token,
      conversation_id: f.conversation,
      message_id: row._id,
      delivery_id: row.delivery_id!,
      conversation_sequence: String(row.conversation_sequence),
      execution_epoch: 1,
      reason: "unsupported input",
    });
  await expect(reject(own.messages[0]!)).rejects.toThrow(
    "DELIVERY_SEQUENCE_HEAD_MISMATCH",
  );
  await expect(reject(own.messages[2]!)).rejects.toThrow(
    "DELIVERY_SEQUENCE_HEAD_MISMATCH",
  );
  expect(await f.rows()).toEqual(own);
  expect(await reject(own.messages[1]!)).toEqual({ rejected: true });
  expect((await f.rows()).head?.next_nonterminal_sequence).toBe(1);
  expect((await f.permit()).selected).toMatchObject({
    delivery_id: "later",
    intent: "steer",
    seq: 3,
  });
});
