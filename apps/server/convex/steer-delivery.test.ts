import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  parseDeliverySettleResponse,
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  STEER_BATON_CAPABILITY,
} from "@codecast/edge-contract";
import { TURN_STARTER_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import {
  cancelFencedDeliveriesOnKill,
  claimNextDeliveryInDb,
  EXECUTION_PROTOCOL_CAPABILITIES,
} from "./executionBindings";
import type { Doc } from "./_generated/dataModel";

const flag = "SWARM_TURN_BATON";
const edge = "CODECAST_EDGE_DELIVERY_V1";
const savedBaton = process.env[flag];
const savedEdge = process.env[edge];
const observed = { id: "turn", run: 1, start_event_seq: 7 };

beforeEach(() => {
  process.env[flag] = "1";
  process.env[edge] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (savedBaton === undefined) delete process.env[flag];
  else process.env[flag] = savedBaton;
  if (savedEdge === undefined) delete process.env[edge];
  else process.env[edge] = savedEdge;
  setSystemTime();
});

async function fixture() {
  const f = await setupRunLease();
  const grant = await f.claim("steer-run");
  if (grant.status !== "granted") throw new Error("Expected run lease");
  const fence = {
    v: 1,
    session: f.conversation,
    run: 1,
    fencing_token: grant.fencing_token,
  };
  const { other, projection } = await f.t.run(async ({ db }) => {
    const other = await fixtureRows(db, "kernel other sender").user();
    const binding = (await db.get(f.binding))!;
    await db.patch(f.conversation, { owner_user_id: other });
    await db.patch(f.binding, {
      capabilities: [...binding.required_capabilities, STEER_BATON_CAPABILITY],
    });
    const row = await db.query("run_turn_projections").unique();
    if (!row) throw new Error("Expected initial projection");
    await db.patch(row._id, {
      projection_version: TURN_STARTER_PROJECTION_VERSION,
      turn_ids: [observed.id],
      open_turn: {
        id: observed.id,
        start_event_seq: observed.start_event_seq,
        starter: { kind: "person", id: f.owner },
        prompt_ids: [],
      },
    });
    return { other, projection: row._id };
  });
  const send = (
    client_id: string,
    turn: typeof observed | undefined,
    sender = f.owner,
  ) =>
    asUser(f.t, sender).mutation(api.pendingMessages.sendMessageV2, {
      conversation_id: f.conversation,
      command_id: client_id,
      client_id,
      content: client_id,
      ...(turn ? { observed_turn: turn } : {}),
    });
  const call = async (verb: string, input: object = {}) => {
    const response = await f.t.fetch(`/edge/v1/${verb}`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify({ ...fence, ...input }),
    });
    expect(response.status).toBe(200);
    return await response.json();
  };
  const next = async () => {
    const parsed = parsePermitsNextResponse(await call("permits.next"));
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const permit = async () => {
    const selected = await next();
    if (selected.status !== "permit") throw new Error(JSON.stringify(selected));
    const { delivery_id, attempt_id, seq, intent, sender } = selected;
    return {
      selected,
      request: { delivery_id, attempt_id, seq, intent, sender },
    };
  };
  const begin = async (input: object) => {
    const parsed = parseDeliveryStartResponse(
      await call("delivery.start", input),
    );
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const settle = async (input: object, outcome: string, extra: object = {}) => {
    const parsed = parseDeliverySettleResponse(
      await call("delivery.settle", { ...input, outcome, ...extra }),
    );
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const turn = (open_turn: Doc<"run_turn_projections">["open_turn"]) =>
    f.t.run(({ db }) => db.patch(projection, { open_turn }));
  const rows = () =>
    f.t.run(async ({ db }) => ({
      head: await db.get(f.head),
      messages: await db
        .query("pending_messages")
        .withIndex("by_conversation_sequence", (q) =>
          q.eq("conversation_id", f.conversation),
        )
        .collect(),
      attempts: await db.query("delivery_attempts").collect(),
    }));
  return {
    ...f,
    fence,
    next,
    permit,
    begin,
    settle,
    turn,
    send,
    rows,
    projection,
    other,
  };
}

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
